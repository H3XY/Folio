/* Folio — Header & footer, page numbers, Bates numbering, watermark.
   Settings live in S.stamps (part of undo history), preview on every page, and are drawn on save. */
'use strict';

(() => {
  const { degrees, rgb } = PDFLib;
  const SLOTS = [['tl', 'Left'], ['tc', 'Center'], ['tr', 'Right']];
  const FSLOTS = [['bl', 'Left'], ['bc', 'Center'], ['br', 'Right']];
  const TOKENS = [['{page}', 'Page number'], ['{pages}', 'Total pages'], ['{bates}', 'Bates number'], ['{date}', 'Date'], ['{file}', 'File name']];

  const defaultsHF = () => ({
    slots: { tl: '', tc: '', tr: '', bl: '', bc: '', br: 'Page {page} of {pages}' },
    font: 'Arial', bold: false, italic: false, size: 9, color: '#161a20',
    margins: { top: 0.5, bottom: 0.5, left: 0.75, right: 0.75 }, // inches
    from: 1, to: 0, startNumber: 1, dateFormat: 'MM/DD/YYYY',
    bates: { prefix: 'ABC', start: 1, digits: 6, suffix: '' },
  });
  const defaultsWM = () => ({ text: 'CONFIDENTIAL', font: 'Arial', bold: true, italic: false, size: 64, color: '#d92f2f', opacity: 0.18, angle: 45, from: 1, to: 0 });

  Object.assign(TOOL_BUTTONS, {
    headerfooter: { icon: 'headerfooter', label: 'Header & footer', action: () => openHeaderFooter() },
    watermark: { icon: 'watermark', label: 'Watermark', action: () => openWatermark() },
    bates: { icon: 'bates', label: 'Bates numbering', action: () => openHeaderFooter(true) },
  });

  const inRange = (cfg, i, total) => i + 1 >= (cfg.from || 1) && i + 1 <= (cfg.to || total);
  const batesNo = (b, i) => `${b.prefix || ''}${String((+b.start || 0) + i).padStart(+b.digits || 1, '0')}${b.suffix || ''}`;

  function fill(text, hf, i, total) {
    const first = Math.max(0, (hf.from || 1) - 1);
    return text
      .replace(/\{page\}/g, String(i - first + (+hf.startNumber || 1)))
      .replace(/\{pages\}/g, String(total))
      .replace(/\{bates\}/g, batesNo(hf.bates, i - first))
      .replace(/\{date\}/g, formatDate(new Date(), hf.dateFormat || 'MM/DD/YYYY'))
      .replace(/\{file\}/g, S.docName.replace(/\.pdf$/i, ''));
  }

  // Everything to draw on one page, in the page's display frame (top-left origin, y down).
  function items(pg, st = S.stamps) {
    const i = pageIndex(pg.id), total = S.pages.length;
    const out = [];
    const hf = st.hf;
    if (hf && inRange(hf, i, total)) {
      const m = { t: hf.margins.top * 72, b: hf.margins.bottom * 72, l: hf.margins.left * 72, r: hf.margins.right * 72 };
      const pos = {
        tl: [m.l, m.t + hf.size * 0.8, 'start'], tc: [pg.W / 2, m.t + hf.size * 0.8, 'middle'], tr: [pg.W - m.r, m.t + hf.size * 0.8, 'end'],
        bl: [m.l, pg.H - m.b, 'start'], bc: [pg.W / 2, pg.H - m.b, 'middle'], br: [pg.W - m.r, pg.H - m.b, 'end'],
      };
      for (const [slot, raw] of Object.entries(hf.slots)) {
        if (!raw) continue;
        const [x, y, anchor] = pos[slot];
        out.push({ kind: 'hf', text: fill(raw, hf, i, total), x, y, anchor, size: hf.size, font: hf.font, bold: hf.bold, italic: hf.italic, color: hf.color, opacity: 1, angle: 0 });
      }
    }
    const wm = st.wm;
    if (wm && wm.text && inRange(wm, i, total)) {
      out.push({ kind: 'wm', text: wm.text, x: pg.W / 2, y: pg.H / 2, anchor: 'middle', center: true, size: wm.size, font: wm.font, bold: wm.bold, italic: wm.italic, color: wm.color, opacity: wm.opacity, angle: wm.angle });
    }
    return out;
  }

  Folio.overlays.push((pg, layer) => {
    if (layer !== 'over') return '';
    const st = preview || S.stamps;
    if (!st.hf && !st.wm) return '';
    return items(pg, st).map((it) => {
      const tf = it.angle ? ` transform="rotate(${-it.angle} ${n2(it.x)} ${n2(it.y)})"` : '';
      return `<text x="${n2(it.x)}" y="${n2(it.y)}" text-anchor="${it.anchor}"${it.center ? ' dominant-baseline="central"' : ''} font-family="${esc(Folio.fonts.css(it.font))}" font-size="${it.size}" font-weight="${it.bold ? 700 : 400}" font-style="${it.italic ? 'italic' : 'normal'}" fill="${it.color}" fill-opacity="${it.opacity}" pointer-events="none" style="white-space:pre"${tf}>${esc(it.text)}</text>`;
    }).join('');
  });

  Folio.exportPage.push(async (page, pg, ctx) => {
    if (!S.stamps.hf && !S.stamps.wm) return;
    for (const it of items(pg)) {
      const font = await ctx.textFont(it);
      const text = ctx.safe(font, it.text);
      const w = font.widthOfTextAtSize(text, it.size);
      const color = ctx.hexRgb(it.color);
      if (it.center) {
        // Rotate about the page center; offsets are in pdf-lib's y-up frame.
        const th = (it.angle * Math.PI) / 180, cx = it.x, cy = ctx.H - it.y;
        const ox = -w / 2, oy = -it.size * 0.35;
        page.drawText(text, {
          x: cx + ox * Math.cos(th) - oy * Math.sin(th), y: cy + ox * Math.sin(th) + oy * Math.cos(th),
          size: it.size, font, color, opacity: it.opacity, rotate: degrees(it.angle),
        });
      } else {
        const x = it.anchor === 'middle' ? it.x - w / 2 : it.anchor === 'end' ? it.x - w : it.x;
        page.drawText(text, { x, y: ctx.H - it.y, size: it.size, font, color, opacity: it.opacity });
      }
    }
  });

  // ------------------------------------------------------------ dialogs
  let preview = null; // settings shown on the pages while a dialog is open
  const redrawAll = () => S.pages.forEach(drawAnnots);

  const fontOptions = (cur) => Folio.fonts.families().map((n) => `<option ${n === cur ? 'selected' : ''}>${esc(n)}</option>`).join('');

  function openHeaderFooter(focusBates = false) {
    const hf = clone(S.stamps.hf || defaultsHF());
    if (focusBates && !Object.values(hf.slots).some((s) => s.includes('{bates}'))) {
      if (!S.stamps.hf) hf.slots.br = '';
      hf.slots.br = (hf.slots.br ? hf.slots.br + '  ' : '') + '{bates}';
    }
    const total = S.pages.length;
    const slotInputs = (list, title) => `<div class="field"><span class="label">${title}</span><div class="slot-grid">${list.map(([k, l]) =>
      `<label class="slot"><span>${l}</span><input type="text" class="form-input" data-slot="${k}" value="${esc(hf.slots[k])}" spellcheck="false"></label>`).join('')}</div></div>`;
    openPanel({
      title: focusBates ? 'Bates numbering' : 'Header & footer',
      wide: true,
      body: `
        <p class="note">Click a box, then a token to insert it. Changes preview on the pages behind this window.</p>
        <div class="row token-row">${TOKENS.map(([t, l]) => `<button type="button" class="btn sm" data-token="${t}" title="${l}">${l}</button>`).join('')}</div>
        ${slotInputs(SLOTS, 'Header')}
        ${slotInputs(FSLOTS, 'Footer')}
        <div class="grid-3">
          <label class="form-field"><span>Font</span><select class="form-input" id="hfFont">${fontOptions(hf.font)}</select></label>
          <label class="form-field"><span>Size (pt)</span><input class="form-input" type="number" id="hfSize" min="5" max="48" step="0.5" value="${hf.size}"></label>
          <label class="form-field"><span>Color</span><input class="form-input color-input" type="color" id="hfColor" value="${hf.color}"></label>
          <label class="form-field"><span>Top / bottom margin (in)</span><span class="pair"><input class="form-input" type="number" id="hfMt" min="0" step="0.05" value="${hf.margins.top}"><input class="form-input" type="number" id="hfMb" min="0" step="0.05" value="${hf.margins.bottom}"></span></label>
          <label class="form-field"><span>Left / right margin (in)</span><span class="pair"><input class="form-input" type="number" id="hfMl" min="0" step="0.05" value="${hf.margins.left}"><input class="form-input" type="number" id="hfMr" min="0" step="0.05" value="${hf.margins.right}"></span></label>
          <label class="form-field"><span>Pages</span><span class="pair"><input class="form-input" type="number" id="hfFrom" min="1" max="${total}" value="${hf.from || 1}"><input class="form-input" type="number" id="hfTo" min="1" max="${total}" value="${hf.to || total}"></span></label>
          <label class="form-field"><span>First page number</span><input class="form-input" type="number" id="hfStart" min="0" value="${hf.startNumber}"></label>
          <label class="form-field"><span>Date format</span><select class="form-input" id="hfDate">${DATE_FORMATS.map((d) => `<option value="${d}" ${d === hf.dateFormat ? 'selected' : ''}>${esc(formatDate(new Date(), d))}</option>`).join('')}</select></label>
          <label class="check"><input type="checkbox" id="hfBold" ${hf.bold ? 'checked' : ''}> Bold</label>
        </div>
        <fieldset class="bates-set${focusBates ? ' focus' : ''}"><legend>Bates number</legend>
          <div class="grid-4">
            <label class="form-field"><span>Prefix</span><input class="form-input" type="text" id="bPrefix" value="${esc(hf.bates.prefix)}" spellcheck="false"></label>
            <label class="form-field"><span>Start number</span><input class="form-input" type="number" id="bStart" min="0" value="${hf.bates.start}"></label>
            <label class="form-field"><span>Digits</span><input class="form-input" type="number" id="bDigits" min="1" max="15" value="${hf.bates.digits}"></label>
            <label class="form-field"><span>Suffix</span><input class="form-input" type="text" id="bSuffix" value="${esc(hf.bates.suffix)}" spellcheck="false"></label>
          </div>
          <p class="note mono" id="bPreview"></p>
        </fieldset>`,
      actions: [
        ...(S.stamps.hf ? [{ label: 'Remove header & footer', danger: true, left: true, run: () => { checkpoint(); delete S.stamps.hf; } }] : []),
        { label: 'Cancel' },
        { label: 'Apply', primary: true, run: () => { checkpoint(); S.stamps = { ...S.stamps, hf: clone(preview.hf) }; } },
      ],
      onOpen: (form) => {
        let lastSlot = form.querySelector(focusBates ? '[data-slot="br"]' : '[data-slot="bc"]');
        const read = () => {
          SLOTS.concat(FSLOTS).forEach(([k]) => { hf.slots[k] = form.querySelector(`[data-slot="${k}"]`).value; });
          hf.font = form.querySelector('#hfFont').value;
          hf.size = clamp(+form.querySelector('#hfSize').value || 9, 5, 48);
          hf.color = form.querySelector('#hfColor').value;
          hf.bold = form.querySelector('#hfBold').checked;
          hf.margins = { top: +form.querySelector('#hfMt').value || 0, bottom: +form.querySelector('#hfMb').value || 0, left: +form.querySelector('#hfMl').value || 0, right: +form.querySelector('#hfMr').value || 0 };
          hf.from = clamp(+form.querySelector('#hfFrom').value || 1, 1, total);
          hf.to = clamp(+form.querySelector('#hfTo').value || total, hf.from, total);
          hf.startNumber = +form.querySelector('#hfStart').value || 0;
          hf.dateFormat = form.querySelector('#hfDate').value;
          hf.bates = { prefix: form.querySelector('#bPrefix').value, start: +form.querySelector('#bStart').value || 0, digits: clamp(+form.querySelector('#bDigits').value || 1, 1, 15), suffix: form.querySelector('#bSuffix').value };
          form.querySelector('#bPreview').textContent = `First page: ${batesNo(hf.bates, 0)}   ·   Last page: ${batesNo(hf.bates, hf.to - hf.from)}`;
          preview = { ...S.stamps, hf: clone(hf) };
          redrawAll();
        };
        form.addEventListener('input', read);
        form.addEventListener('change', read);
        form.querySelectorAll('[data-slot]').forEach((inp) => inp.addEventListener('focus', () => { lastSlot = inp; }));
        form.querySelectorAll('[data-token]').forEach((b) => b.addEventListener('click', () => {
          const inp = lastSlot;
          const s = inp.selectionStart ?? inp.value.length, e2 = inp.selectionEnd ?? inp.value.length;
          inp.value = inp.value.slice(0, s) + b.dataset.token + inp.value.slice(e2);
          inp.focus();
          inp.setSelectionRange(s + b.dataset.token.length, s + b.dataset.token.length);
          read();
        }));
        read();
        if (focusBates) form.querySelector('#bPrefix').select();
      },
      onClose: () => { preview = null; redrawAll(); },
    });
  }

  function openWatermark() {
    const wm = clone(S.stamps.wm || defaultsWM());
    const total = S.pages.length;
    openPanel({
      title: 'Watermark',
      body: `
        <label class="form-field"><span>Text</span><input class="form-input" type="text" id="wmText" value="${esc(wm.text)}" spellcheck="false"></label>
        <div class="row token-row">${['CONFIDENTIAL', 'DRAFT', 'PRIVILEGED & CONFIDENTIAL', 'ATTORNEY WORK PRODUCT', 'COPY'].map((t) => `<button type="button" class="btn sm" data-wm="${t}">${t}</button>`).join('')}</div>
        <div class="grid-3">
          <label class="form-field"><span>Font</span><select class="form-input" id="wmFont">${fontOptions(wm.font)}</select></label>
          <label class="form-field"><span>Size (pt)</span><input class="form-input" type="number" id="wmSize" min="8" max="300" value="${wm.size}"></label>
          <label class="form-field"><span>Color</span><input class="form-input color-input" type="color" id="wmColor" value="${wm.color}"></label>
          <label class="form-field"><span>Opacity <output id="wmOpOut"></output></span><input type="range" id="wmOpacity" min="0.05" max="1" step="0.05" value="${wm.opacity}"></label>
          <label class="form-field"><span>Angle (°)</span><input class="form-input" type="number" id="wmAngle" min="-90" max="90" value="${wm.angle}"></label>
          <label class="form-field"><span>Pages</span><span class="pair"><input class="form-input" type="number" id="wmFrom" min="1" max="${total}" value="${wm.from || 1}"><input class="form-input" type="number" id="wmTo" min="1" max="${total}" value="${wm.to || total}"></span></label>
          <label class="check"><input type="checkbox" id="wmBold" ${wm.bold ? 'checked' : ''}> Bold</label>
        </div>`,
      actions: [
        ...(S.stamps.wm ? [{ label: 'Remove watermark', danger: true, left: true, run: () => { checkpoint(); delete S.stamps.wm; } }] : []),
        { label: 'Cancel' },
        { label: 'Apply', primary: true, run: () => { checkpoint(); S.stamps = { ...S.stamps, wm: clone(preview.wm) }; } },
      ],
      onOpen: (form) => {
        const read = () => {
          wm.text = form.querySelector('#wmText').value;
          wm.font = form.querySelector('#wmFont').value;
          wm.size = clamp(+form.querySelector('#wmSize').value || 64, 8, 300);
          wm.color = form.querySelector('#wmColor').value;
          wm.opacity = +form.querySelector('#wmOpacity').value;
          wm.angle = clamp(+form.querySelector('#wmAngle').value || 0, -90, 90);
          wm.bold = form.querySelector('#wmBold').checked;
          wm.from = clamp(+form.querySelector('#wmFrom').value || 1, 1, total);
          wm.to = clamp(+form.querySelector('#wmTo').value || total, wm.from, total);
          form.querySelector('#wmOpOut').textContent = `${Math.round(wm.opacity * 100)}%`;
          preview = { ...S.stamps, wm: clone(wm) };
          redrawAll();
        };
        form.addEventListener('input', read);
        form.addEventListener('change', read);
        form.querySelectorAll('[data-wm]').forEach((b) => b.addEventListener('click', () => { form.querySelector('#wmText').value = b.dataset.wm; read(); }));
        read();
      },
      onClose: () => { preview = null; redrawAll(); },
    });
  }

  Folio.stamps = { items, batesNo };
})();
