/* Folio — Edit: change existing text and images in place, crop pages.
   Each edited page gets its own one-page "edit base" copy. Changes are kept on the page as a list
   (removed text operators, image moves/deletes, crop, OCR text) and replayed onto the base to build
   the page the viewer shows, so undo/redo is just restoring that list. */
'use strict';

(() => {
  const { PDFDocument, PDFName, StandardFonts } = PDFLib;
  const analysisCache = new Map(); // base source id -> Promise<analysis>
  const blockCache = new Map();    // `${src}|${rot}` -> blocks | Promise
  let imgSel = null;               // { pid, key }
  let busyEdit = false;

  Object.assign(TOOL_BUTTONS, {
    edittext: { icon: 'edittext', label: 'Edit text & images' },
    crop: { icon: 'crop', label: 'Crop' },
  });
  Object.assign(TOOL_INFO, {
    edittext: { name: 'Edit text & images', hint: 'Click text to edit it in place. Click an image to move, resize or delete it.' },
    crop: { name: 'Crop', hint: 'Drag a rectangle to keep. Everything outside it is cropped away.' },
  });

  // ------------------------------------------------------------ edit base & rebuild
  async function ensureEditBase(pg) {
    if (pg.edit) return;
    const src = S.sources.get(pg.src);
    const lib = await PDFDocument.load(src.bytes, { ignoreEncryption: true, updateMetadata: false });
    if (src.fields.length) { try { await fillForm(lib, src.formValues); lib.getForm().flatten(); } catch (e) { console.warn(e); } }
    const out = await PDFDocument.create();
    const [p] = await out.copyPages(lib, [pg.idx]);
    out.addPage(p);
    const base = await registerSource(await out.save(), src.name);
    pg.edit = { base: base.id, removed: [], img: {}, crop: null, ocr: null };
    pg.src = base.id;
    pg.idx = 0;
  }

  function analysisFor(baseId) {
    if (!analysisCache.has(baseId)) {
      analysisCache.set(baseId, (async () => {
        const lib = await PDFDocument.load(S.sources.get(baseId).bytes, { ignoreEncryption: true, updateMetadata: false });
        const a = await CS.analyze(lib.getPage(0));
        a.textByKey = new Map(a.texts.map((t) => [`${t.si}:${t.oi}`, t]));
        a.imgByKey = new Map(a.images.map((m) => [`${m.si}:${m.oi}`, m]));
        return a;
      })());
    }
    return analysisCache.get(baseId);
  }

  // Build the page the viewer shows from its edit base plus the recorded changes.
  async function applyEdits(pg) {
    const ed = pg.edit;
    const base = S.sources.get(ed.base);
    const lib = await PDFDocument.load(base.bytes, { ignoreEncryption: true, updateMetadata: false });
    const page = lib.getPage(0);
    const ana = await analysisFor(ed.base);
    const edits = new Map();
    for (const k of ed.removed) { const t = ana.textByKey.get(k); if (t) edits.set(k, CS.removalFor(t)); }
    for (const [k, v] of Object.entries(ed.img)) {
      if (v.del) edits.set(k, '');
      else if (v.m) edits.set(k, (orig) => CS.transformFor(null, v.m, orig));
    }
    const streams = CS.pageStreams(page);
    const refs = streams.map((s) => s.ref);
    const touched = new Set([...edits.keys()].map((k) => +k.split(':')[0]));
    for (const si of touched) {
      const bytes = CS.rewrite(ana.streams[si], edits, si);
      refs[si] = lib.context.register(lib.context.flateStream(bytes));
    }
    if (ed.ocr?.length) refs.push(await ocrStream(lib, page, ed.ocr));
    page.node.set(PDFName.of('Contents'), lib.context.obj(refs));
    if (ed.crop) {
      const [x1, y1, x2, y2] = ed.crop;
      page.setCropBox(x1, y1, x2 - x1, y2 - y1);
    }
    const derived = await registerSource(await lib.save(), base.name);
    pg.src = derived.id;
    pg.idx = 0;
    const p = await derived.doc.getPage(1);
    const vp = p.getViewport({ scale: 1, rotation: (pg.base + pg.rot) % 360 });
    pg.W = n2(vp.width); pg.H = n2(vp.height);
  }

  // Invisible, searchable text for OCR results (text render mode 3), squeezed to each word's width.
  async function ocrStream(lib, page, words) {
    const font = await lib.embedFont(StandardFonts.Helvetica);
    const key = page.node.newFontDictionary('FolioOCR', font.ref);
    const safe = (s) => [...s].map((ch) => { try { font.encodeText(ch); return ch; } catch { return '?'; } }).join('');
    let src = 'q BT 3 Tr ';
    for (const w of words) {
      const text = safe(w.t);
      if (!text.trim()) continue;
      const natural = font.widthOfTextAtSize(text, w.size) || 1;
      const tz = Math.max(1, Math.min(1000, (100 * w.w) / natural));
      const [a, b, c, d, e, f] = w.m;
      src += `/${key.asString().slice(1)} ${w.size.toFixed(2)} Tf ${tz.toFixed(2)} Tz ${[a, b, c, d, e, f].map((v) => v.toFixed(4)).join(' ')} Tm ${font.encodeText(text).toString()} Tj `;
    }
    src += 'ET Q';
    return lib.context.register(lib.context.flateStream(new TextEncoder().encode(src)));
  }

  async function viewportOf(pg) {
    const p = await S.sources.get(pg.src).doc.getPage(pg.idx + 1);
    return p.getViewport({ scale: 1, rotation: (pg.base + pg.rot) % 360 });
  }

  // ------------------------------------------------------------ text blocks (what the user clicks)
  const redrawKey = (key) => S.pages.filter((p) => `${p.src}|${p.idx}|${p.rot}` === key).forEach(drawAnnots);
  function blocksFor(pg) {
    const key = `${pg.src}|${pg.idx}|${pg.rot}`;
    if (!blockCache.has(key)) {
      const p = computeBlocks(pg).then((b) => { blockCache.set(key, b); redrawKey(key); return b; });
      blockCache.set(key, p);
    }
    const v = blockCache.get(key);
    return v instanceof Promise ? null : v;
  }

  async function computeBlocks(pg) {
    const src = S.sources.get(pg.src);
    const page = await src.doc.getPage(pg.idx + 1);
    const vp = page.getViewport({ scale: 1, rotation: (pg.base + pg.rot) % 360 });
    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const [a, b, c, d, e, f] = it.transform;
      const len = Math.hypot(a, b) || 1;
      const size = Math.hypot(c, d) || len;
      const [x0, y0] = vp.convertToViewportPoint(e, f);
      const [x1, y1] = vp.convertToViewportPoint(e + (a / len) * it.width, f + (b / len) * it.width);
      if (Math.abs(y1 - y0) > size * 0.2 || x1 < x0 - 0.5) continue; // only horizontal, left-to-right text is editable
      items.push({ str: it.str, x0, x1: Math.max(x1, x0 + 1), y: y0, size, family: tc.styles[it.fontName]?.fontFamily || '' });
    }
    items.sort((p, q) => (Math.abs(p.y - q.y) < Math.min(p.size, q.size) * 0.35 ? p.x0 - q.x0 : p.y - q.y));
    const lines = [];
    for (const it of items) {
      const ln = lines[lines.length - 1];
      if (ln && Math.abs(it.y - ln.y) < Math.min(it.size, ln.size) * 0.35 && it.x0 - ln.x1 < Math.max(it.size, ln.size) * 1.5 && it.x0 > ln.x0) {
        const gap = it.x0 - ln.x1;
        if (gap > it.size * 0.12 && !/\s$/.test(ln.text) && !/^\s/.test(it.str)) ln.text += ' ';
        ln.text += it.str;
        ln.x1 = Math.max(ln.x1, it.x1);
        ln.size = Math.max(ln.size, it.size);
      } else lines.push({ text: it.str, x0: it.x0, x1: it.x1, y: it.y, size: it.size, family: it.family });
    }
    lines.sort((p, q) => p.y - q.y || p.x0 - q.x0);
    const blocks = [];
    for (const ln of lines) {
      const b = blocks.find((bk) => {
        const last = bk.lines[bk.lines.length - 1];
        const gap = ln.y - last.y;
        return gap > last.size * 0.6 && gap < last.size * 1.75 && ln.size / last.size > 0.8 && ln.size / last.size < 1.25 &&
          ln.x0 < bk.x1 + last.size && ln.x1 > bk.x0 - last.size && Math.abs(ln.x0 - bk.x0) < last.size * 3;
      });
      if (b) { b.lines.push(ln); b.x0 = Math.min(b.x0, ln.x0); b.x1 = Math.max(b.x1, ln.x1); }
      else blocks.push({ lines: [ln], x0: ln.x0, x1: ln.x1 });
    }
    return blocks.map((b, i) => {
      const first = b.lines[0], last = b.lines[b.lines.length - 1];
      const size = first.size;
      const gaps = b.lines.slice(1).map((l, k) => l.y - b.lines[k].y);
      return {
        i, lines: b.lines, size, family: first.family,
        x: n2(b.x0), y: n2(first.y - size * 0.92), w: n2(b.x1 - b.x0), h: n2(last.y - first.y + size * 1.15),
        lineGap: gaps.length ? gaps.reduce((s, g) => s + g, 0) / gaps.length : size * 1.2,
      };
    });
  }

  // Images on the page (from the edit base analysis, or the original page when not yet edited)
  async function imagesFor(pg) {
    if (!pg.edit) {
      // Analyze the current page without creating an edit base yet.
      const key = `img|${pg.src}|${pg.idx}`;
      if (!analysisCache.has(key)) {
        analysisCache.set(key, (async () => {
          const lib = await PDFDocument.load(S.sources.get(pg.src).bytes, { ignoreEncryption: true, updateMetadata: false });
          return CS.analyze(lib.getPage(pg.idx));
        })());
      }
      const a = await analysisCache.get(key);
      return a.images.map((m) => ({ key: `${m.si}:${m.oi}`, ctm: m.ctm }));
    }
    const a = await analysisFor(pg.edit.base);
    return a.images.filter((m) => !pg.edit.img[`${m.si}:${m.oi}`]?.del).map((m) => {
      const k = `${m.si}:${m.oi}`;
      const t = pg.edit.img[k];
      return { key: k, ctm: t?.m ? CS.mul(m.ctm, t.m) : m.ctm };
    });
  }
  const imgRectCache = new Map();
  function imageRects(pg) {
    const key = `${pg.src}|${pg.idx}|${pg.rot}`;
    if (!imgRectCache.has(key)) {
      const p = (async () => {
        const vp = await viewportOf(pg);
        const imgs = await imagesFor(pg);
        return imgs.map((im) => {
          const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => vp.convertToViewportPoint(...CS.apply(im.ctm, u, v)));
          const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
          return { key: im.key, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
        }).filter((r) => r.w > 4 && r.h > 4);
      })().then((r) => { imgRectCache.set(key, r); redrawKey(key); return r; });
      imgRectCache.set(key, p);
    }
    const v = imgRectCache.get(key);
    return v instanceof Promise ? null : v;
  }

  // ------------------------------------------------------------ overlay
  Folio.overlays.push((pg, layer) => {
    if (layer !== 'under' || S.tool !== 'edittext') return '';
    const k = 1 / S.zoom;
    let html = '';
    const imgs = imageRects(pg) || [];
    for (const r of imgs) {
      const sel = imgSel && imgSel.pid === pg.id && imgSel.key === r.key;
      const g = sel && imgSel.ghost ? imgSel.ghost : r;
      html += `<rect class="edit-img${sel ? ' sel' : ''}" data-img="${r.key}" x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" fill="${sel ? 'rgba(26,115,232,.08)' : 'transparent'}" stroke="var(--sel)" stroke-width="${(sel ? 1.6 : 1) * k}" stroke-dasharray="${sel ? '' : `${4 * k} ${3 * k}`}"/>`;
      if (sel) html += `<rect data-imgh="se" x="${g.x + g.w - 4.5 * k}" y="${g.y + g.h - 4.5 * k}" width="${9 * k}" height="${9 * k}" fill="#fff" stroke="var(--sel)" stroke-width="${1.4 * k}"/>`;
    }
    const blocks = blocksFor(pg) || [];
    for (const b of blocks) {
      html += `<rect class="edit-block" data-block="${b.i}" x="${b.x - 2}" y="${b.y - 1}" width="${b.w + 4}" height="${b.h + 2}" fill="transparent" stroke="var(--sel)" stroke-width="${0.8 * k}" stroke-dasharray="${3 * k} ${2 * k}"/>`;
    }
    return html;
  });

  // ------------------------------------------------------------ edit text tool
  Folio.tools.edittext = {
    activate() { S.pages.forEach(drawAnnots); },
    deactivate() { imgSel = null; S.pages.forEach(drawAnnots); },
    down(e, pid, pt, before) {
      const pg = getPage(pid);
      const hit = e.target.closest('[data-aid]');
      if (hit) {
        imgSel = null;
        select(pid, hit.dataset.aid);
        const a = getAnnot(pid, hit.dataset.aid);
        return { drag: { mode: 'move', a, orig: clone(a) } };
      }
      const h = e.target.closest('[data-imgh]');
      const im = e.target.closest('[data-img]');
      if ((h || im) && !busyEdit) {
        const key = h ? imgSel.key : im.dataset.img;
        const r = (imageRects(pg) || []).find((x) => x.key === key);
        if (!r) return null;
        select(null);
        imgSel = { pid, key, ghost: null };
        drawAnnots(pg);
        renderInspector();
        return {
          drag: {
            onMove(p, ev, dx, dy) {
              let g;
              if (h) { const w = Math.max(8, r.w + dx); g = { x: r.x, y: r.y, w, h: ev.shiftKey ? Math.max(8, r.h + dy) : (w * r.h) / r.w }; }
              else g = { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h };
              imgSel.ghost = g;
              drawAnnots(pg);
            },
            onUp(d) { if (d.moved && imgSel?.ghost) moveImage(pg, key, r, imgSel.ghost, before); },
          },
        };
      }
      const blk = e.target.closest('[data-block]');
      if (blk && !busyEdit) {
        const b = (blocksFor(pg) || []).find((x) => x.i === +blk.dataset.block);
        if (b) editBlock(pg, b, before);
        return null;
      }
      imgSel = null;
      select(null);
      drawAnnots(pg);
      return null;
    },
  };

  async function withBusy(label, fn) {
    busyEdit = true;
    busy(label);
    try { return await fn(); } catch (e) { console.error(e); toast(`${label.replace(/…$/, '')} failed: ${e.message}`, true); } finally { busyEdit = false; busy(null); }
  }

  async function editBlock(pg, b, before) {
    await withBusy('Preparing text for editing…', async () => {
      const vpBefore = await viewportOf(pg);
      await ensureEditBase(pg);
      const ana = await analysisFor(pg.edit.base);
      const removed = new Set(pg.edit.removed);
      const padX = b.size * 0.6, padY = b.size * 0.35;
      const inside = ([x, y]) => x >= b.x - padX && x <= b.x + b.w + padX && y >= b.y - padY && y <= b.y + b.h + padY;
      const ops = ana.texts.filter((t) => {
        const k = `${t.si}:${t.oi}`;
        if (removed.has(k) || t.invisible) return false;
        const p0 = vpBefore.convertToViewportPoint(...t.p0), p1 = vpBefore.convertToViewportPoint(...t.p1);
        return inside(p0) && inside(p1);
      });
      // Font, size and color from the operators that draw this block
      const tally = new Map();
      for (const t of ops) tally.set(t.baseFont, (tally.get(t.baseFont) || 0) + t.chars);
      const baseFont = [...tally.entries()].sort((p, q) => q[1] - p[1])[0]?.[0] || '';
      const fm = Folio.fonts.match(baseFont, b.family);
      const color = ops.find((t) => t.chars)?.color || '#000000';
      const sizes = ops.filter((t) => t.chars).map((t) => t.size).sort((p, q) => p - q);
      const size = n2(sizes.length ? sizes[sizes.length >> 1] : b.size);

      // Paragraph text: soft-wrap lines that run near the block's right edge, keep short lines as hard breaks.
      let text = '';
      b.lines.forEach((ln, i) => {
        text += ln.text.trim();
        if (i < b.lines.length - 1) text += (ln.x1 - b.x) > b.w * 0.8 ? ' ' : '\n';
      });
      const multi = b.lines.length > 1;
      const a = {
        id: uid(), type: 'text', text, color, size, font: fm.font, bold: fm.bold, italic: fm.italic,
        x: b.x, y: n2(b.lines[0].y - size * TEXT_ASC), lh: multi ? n2(b.lineGap / size) : TEXT_LH,
        wrap: multi ? n2(b.w + size * 0.6) : null, align: 'left', replaces: true,
      };
      if (!ops.length) a.cover = { x: b.x - 1, y: b.y - 1, w: b.w + 2, h: b.h + 2 };
      measureText(a);
      pg.edit.removed.push(...ops.map((t) => `${t.si}:${t.oi}`));
      await applyEdits(pg);
      pg.annots.push(a);
      checkpoint(before);
      rebuild();
      if (!ops.length) toast('This text could not be separated from the page, so it is covered and retyped instead.');
      select(null);
      startEdit(pg.id, a, snap());
    });
  }

  async function moveImage(pg, key, from, to, before) {
    await withBusy('Updating image…', async () => {
      const vp = await viewportOf(pg);
      await ensureEditBase(pg);
      const ana = await analysisFor(pg.edit.base);
      const im = ana.imgByKey.get(key);
      if (!im) throw new Error('image not found');
      const prev = pg.edit.img[key]?.m;
      const A = im.ctm, Aeff = prev ? CS.mul(A, prev) : A;
      // display-space map from old rect to new rect, carried into user space
      const sx = to.w / from.w, sy = to.h / from.h;
      const Ddisp = [sx, 0, 0, sy, to.x - from.x * sx, to.y - from.y * sy];
      const V = vp.transform;
      const Duser = CS.mul(CS.inv(V), CS.mul(Ddisp, V));
      const M = CS.mul(CS.inv(A), CS.mul(Duser, Aeff));
      pg.edit.img[key] = { m: M };
      await applyEdits(pg);
      imgSel = { pid: pg.id, key, ghost: null };
      checkpoint(before);
      rebuild();
    });
  }

  async function deleteImage() {
    if (!imgSel) return;
    const pg = getPage(imgSel.pid);
    const key = imgSel.key;
    const before = snap();
    await withBusy('Deleting image…', async () => {
      await ensureEditBase(pg);
      pg.edit.img[key] = { del: true };
      await applyEdits(pg);
      imgSel = null;
      checkpoint(before);
      rebuild();
      renderInspector();
    });
  }

  Folio.onKey = ((prev) => (e, k, mod) => {
    if (prev?.(e, k, mod)) return true;
    if (S.tool === 'edittext' && imgSel && !mod && (k === 'delete' || k === 'backspace')) { e.preventDefault(); deleteImage(); return true; }
    if (S.tool === 'edittext' && imgSel && k === 'escape') { imgSel = null; S.pages.forEach(drawAnnots); renderInspector(); return true; }
    return false;
  })(Folio.onKey);

  Folio.inspector['tool:edittext'] = (body) => {
    if (imgSel) {
      body.insertAdjacentHTML('beforeend', `<div class="tool-title"><i data-i="image"></i>Image <span class="label" style="margin-left:auto">selected</span></div>
        <p class="note">Drag to move. Drag the corner to resize (hold Shift to stretch).</p>
        <div class="row"><button class="btn sm danger-outline" id="imgDel"><i data-i="trash"></i><span>Delete image</span></button></div>`);
      body.querySelector('#imgDel').onclick = deleteImage;
      return;
    }
    body.insertAdjacentHTML('beforeend', `<p class="note">Dashed boxes show text and images you can edit. Click a paragraph to retype it in its original font. The old text is removed from the file, not hidden.</p>
      <p class="note">Edited text keeps its own box: drag it to move, drag its right edge to change the wrap width, and use the controls here to change font, size and color.</p>`);
  };

  // ------------------------------------------------------------ crop
  Folio.tools.crop = {
    activate() { S.pages.forEach(drawAnnots); },
    deactivate() { cropDraft = null; S.pages.forEach(drawAnnots); },
    down(e, pid, pt, before) {
      cropDraft = { pid, x: pt.x, y: pt.y, w: 0, h: 0 };
      return {
        drag: {
          onMove(p) {
            cropDraft.x = Math.min(pt.x, p.x); cropDraft.y = Math.min(pt.y, p.y);
            cropDraft.w = Math.abs(p.x - pt.x); cropDraft.h = Math.abs(p.y - pt.y);
            drawAnnots(getPage(pid));
          },
          onUp(d) {
            const r = cropDraft;
            if (!d.moved || r.w < 10 || r.h < 10) { cropDraft = null; drawAnnots(getPage(pid)); return; }
            askCrop(getPage(pid), r, before);
          },
        },
      };
    },
  };
  let cropDraft = null;
  Folio.overlays.push((pg, layer) => {
    if (layer !== 'over' || !cropDraft || cropDraft.pid !== pg.id) return '';
    const r = cropDraft;
    return `<path d="M0 0H${pg.W}V${pg.H}H0Z M${r.x} ${r.y}V${r.y + r.h}H${r.x + r.w}V${r.y}Z" fill="rgba(10,14,20,.45)" fill-rule="evenodd" pointer-events="none"/>
      <rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="none" stroke="var(--sel)" stroke-width="${1.5 / S.zoom}" pointer-events="none"/>`;
  });

  function askCrop(pg, r, before) {
    const same = S.pages.filter((p) => Math.abs(p.W - pg.W) < 1 && Math.abs(p.H - pg.H) < 1);
    const sel = S.pages.filter((p) => S.selPages.has(p.id));
    openPanel({
      title: 'Crop pages',
      body: `<p class="note">Keep a ${Math.round(r.w)} × ${Math.round(r.h)} pt area (${(r.w / 72).toFixed(2)} × ${(r.h / 72).toFixed(2)} in). Cropping hides the rest of the page; it can be undone.</p>
        <div class="field"><label class="check"><input type="radio" name="cropScope" value="this" checked> This page</label>
        ${sel.length > 1 ? `<label class="check"><input type="radio" name="cropScope" value="sel"> Selected pages (${sel.length})</label>` : ''}
        ${same.length > 1 ? `<label class="check"><input type="radio" name="cropScope" value="same"> All ${same.length} pages of this size</label>` : ''}</div>`,
      actions: [{ label: 'Cancel' }, {
        label: 'Crop', primary: true,
        run: async (form) => {
          const scope = form.querySelector('[name="cropScope"]:checked').value;
          const targets = scope === 'sel' ? sel : scope === 'same' ? same : [pg];
          await withBusy('Cropping…', async () => {
            const vp = await viewportOf(pg);
            const [ux1, uy1] = vp.convertToPdfPoint(r.x, r.y), [ux2, uy2] = vp.convertToPdfPoint(r.x + r.w, r.y + r.h);
            const box = [Math.min(ux1, ux2), Math.min(uy1, uy2), Math.max(ux1, ux2), Math.max(uy1, uy2)];
            for (const t of targets) await cropPage(t, box);
            checkpoint(before);
            rebuild();
            if (S.fit) setZoom('fit');
          });
          cropDraft = null;
        },
      }],
      onClose: () => { cropDraft = null; drawAnnots(pg); },
    });
  }

  async function cropPage(pg, box) {
    const oldVp = await viewportOf(pg);
    await ensureEditBase(pg);
    pg.edit.crop = box;
    await applyEdits(pg);
    const newVp = await viewportOf(pg);
    remapAnnots(pg, (x, y) => newVp.convertToViewportPoint(...oldVp.convertToPdfPoint(x, y)));
  }

  async function uncrop(pg) {
    const before = snap();
    await withBusy('Removing crop…', async () => {
      const oldVp = await viewportOf(pg);
      pg.edit.crop = null;
      await applyEdits(pg);
      const newVp = await viewportOf(pg);
      remapAnnots(pg, (x, y) => newVp.convertToViewportPoint(...oldVp.convertToPdfPoint(x, y)));
      checkpoint(before);
      rebuild();
      if (S.fit) setZoom('fit');
      renderInspector();
    });
  }

  function remapAnnots(pg, f) {
    const P = ([x, y]) => f(x, y).map(n2);
    for (const a of pg.annots) {
      if (a.points) a.points = a.points.map(P);
      else if ('x1' in a) { [a.x1, a.y1] = P([a.x1, a.y1]); [a.x2, a.y2] = P([a.x2, a.y2]); }
      else {
        const [x1, y1] = P([a.x, a.y]), [x2, y2] = P([a.x + (a.w || 0), a.y + (a.h || 0)]);
        a.x = Math.min(x1, x2); a.y = Math.min(y1, y2);
        if (a.type !== 'text') { a.w = Math.abs(x2 - x1); a.h = Math.abs(y2 - y1); }
      }
      if (a.cover) { const [cx, cy] = P([a.cover.x, a.cover.y]); a.cover = { ...a.cover, x: cx, y: cy }; }
    }
  }

  Folio.inspector['tool:crop'] = (body) => {
    const pg = getPage(S.current);
    body.insertAdjacentHTML('beforeend', '<p class="note">Drag on a page to choose the area to keep. You can apply the same crop to every page of that size.</p>');
    if (pg?.edit?.crop) {
      body.insertAdjacentHTML('beforeend', `<div class="row"><button class="btn sm" id="uncrop"><i data-i="crop"></i><span>Remove crop from page ${pageIndex(pg.id) + 1}</span></button></div>`);
      body.querySelector('#uncrop').onclick = () => uncrop(pg);
    }
  };

  // Rebuilt pages need fresh block/image outlines.
  Folio.onRebuild.push(() => { if (S.tool === 'edittext' && imgSel && !getPage(imgSel.pid)) imgSel = null; });

  // ------------------------------------------------------------ OCR text layer (used by Convert → Recognize text)
  Folio.edit = {
    ensureEditBase, applyEdits, viewportOf,
    async setOcr(pg, words) {
      await ensureEditBase(pg);
      pg.edit.ocr = words;
      await applyEdits(pg);
    },
  };
})();

// ------------------------------------------------------------ generic panel dialog (used by several features)
function openPanel({ title, body, actions = [{ label: 'Close' }], onClose, wide = false, onOpen }) {
  const d = $('#panelDlg');
  d.classList.toggle('wide', wide);
  $('#panelTitle').textContent = title;
  $('#panelBody').innerHTML = body;
  const foot = $('#panelFoot');
  foot.innerHTML = '<span class="grow"></span>';
  let closed = false;
  const close = () => { if (closed) return; closed = true; d.close(); onClose?.(); };
  for (const act of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn' + (act.primary ? ' primary' : '') + (act.danger ? ' danger-outline' : '');
    b.textContent = act.label;
    if (act.left) foot.prepend(b); else foot.appendChild(b);
    b.onclick = async () => {
      if (act.run) {
        const keep = await act.run($('#panelForm'), b);
        if (keep === false) return;
      }
      close();
    };
  }
  d.oncancel = () => { closed = true; onClose?.(); };
  hydrateIcons($('#panelBody'));
  d.showModal();
  onOpen?.($('#panelForm'));
  return { close };
}
