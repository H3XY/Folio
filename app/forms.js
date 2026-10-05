/* Folio — fill form fields directly on the page (checkboxes, radio buttons, text fields, dropdowns).
   Controls sit over each field's widget; values go through the same path as the Forms tab
   (src.formValues -> pdf-lib fill -> re-render), so the page shows the PDF's own appearance. */
'use strict';

(() => {
  const widgetCache = new Map(); // `${src}|${idx}` -> Promise<widgets>

  async function widgetsFor(pg) {
    const src = S.sources.get(pg.src);
    if (!src?.fields.length) return [];
    const key = `${src.id}|${pg.idx}`;
    if (!widgetCache.has(key)) {
      widgetCache.set(key, (async () => {
        const page = await src.doc.getPage(pg.idx + 1);
        const annots = await page.getAnnotations({ intent: 'display' });
        return annots.filter((a) => a.subtype === 'Widget' && a.fieldName && !a.hidden && !a.readOnly);
      })());
    }
    return widgetCache.get(key);
  }

  const valueOf = (src, name) => {
    if (name in src.formValues) return src.formValues[name];
    return src.fields.find((f) => f.name === name)?.value;
  };

  // Apply in order: each fill reads the latest values, so rapid clicks never land out of sequence.
  function applyNow(src) {
    src._applyChain = (src._applyChain || Promise.resolve())
      .then(() => applyForm(src))
      .catch((e) => toast('Could not update the form: ' + e.message, true));
    return src._applyChain;
  }

  function setValue(src, name, v, immediate) {
    src.formValues[name] = v;
    setDirty(true);
    if (immediate) applyNow(src); else scheduleFormApply(src);
    renderForms();
    S.pages.filter((p) => p.src === src.id).forEach((p) => syncLayer(p));
  }

  // A radio widget's on-value may be an index into the group's /Opt list (pdf-lib and others do this).
  function radioValue(src, w) {
    const opts = src.fields.find((f) => f.name === w.fieldName)?.options || [];
    if (opts.includes(w.buttonValue)) return w.buttonValue;
    if (/^\d+$/.test(String(w.buttonValue)) && opts[+w.buttonValue] !== undefined) return opts[+w.buttonValue];
    return w.buttonValue;
  }

  async function buildLayer(pg) {
    const el = wraps.get(pg.id);
    if (!el) return;
    const src = S.sources.get(pg.src);
    const key = `${src.id}|${pg.idx}|${pg.rot}`;
    const widgets = await widgetsFor(pg);
    const page = widgets.length ? await src.doc.getPage(pg.idx + 1) : null;
    // Look at the layer only after the awaits, so overlapping refreshes don't each add one.
    let layer = el.querySelector('.fields');
    if (!widgets.length) { layer?.remove(); return; }
    if (layer?.dataset.key === key) { syncLayer(pg); return; }
    const vp = page.getViewport({ scale: 1, rotation: (pg.base + pg.rot) % 360 });
    layer?.remove();
    layer = document.createElement('div');
    layer.className = 'fields';
    layer.dataset.key = key;
    for (const w of widgets) {
      const [x1, y1, x2, y2] = w.rect;
      const a = vp.convertToViewportPoint(x1, y1), b = vp.convertToViewportPoint(x2, y2);
      const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]), wd = Math.abs(b[0] - a[0]), ht = Math.abs(b[1] - a[1]);
      const pos = `left:${(x / vp.width) * 100}%;top:${(y / vp.height) * 100}%;width:${(wd / vp.width) * 100}%;height:${(ht / vp.height) * 100}%`;
      let ctl;
      if (w.fieldType === 'Btn' && (w.checkBox || w.radioButton)) {
        ctl = document.createElement('button');
        ctl.type = 'button';
        ctl.className = `fld fld-${w.radioButton ? 'radio' : 'check'}`;
        ctl.title = w.alternativeText || w.fieldName;
        ctl.addEventListener('click', () => {
          if (w.radioButton) setValue(src, w.fieldName, radioValue(src, w), true);
          else setValue(src, w.fieldName, !valueOf(src, w.fieldName), true);
        });
      } else if (w.fieldType === 'Tx') {
        ctl = document.createElement(w.multiLine ? 'textarea' : 'input');
        if (!w.multiLine) ctl.type = 'text';
        ctl.className = 'fld fld-text';
        ctl.spellcheck = true;
        if (w.maxLen) ctl.maxLength = w.maxLen;
        ctl.title = w.alternativeText || w.fieldName;
        ctl.addEventListener('focus', () => { ctl.style.fontSize = Math.max(8, Math.min(ctl.clientHeight * (w.multiLine ? 0.4 : 0.62), 20 * S.zoom)) + 'px'; });
        ctl.addEventListener('input', () => setValue(src, w.fieldName, ctl.value, false));
        ctl.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape' || (e.key === 'Enter' && !w.multiLine)) ctl.blur(); });
      } else if (w.fieldType === 'Ch') {
        ctl = document.createElement('select');
        ctl.className = 'fld fld-choice';
        ctl.title = w.alternativeText || w.fieldName;
        const opts = (w.options || []).map((o) => ({ v: o.exportValue ?? o.displayValue, label: o.displayValue ?? o.exportValue }));
        ctl.innerHTML = `<option value=""></option>${opts.map((o) => `<option value="${esc(o.v)}">${esc(o.label)}</option>`).join('')}`;
        ctl.addEventListener('change', () => setValue(src, w.fieldName, ctl.value, true));
      } else continue; // push buttons, signature fields: not fillable here
      ctl.dataset.name = w.fieldName;
      if (w.radioButton) ctl.dataset.value = radioValue(src, w);
      ctl.style.cssText = pos;
      ctl.addEventListener('pointerdown', (e) => e.stopPropagation());
      layer.appendChild(ctl);
    }
    el.appendChild(layer);
    syncLayer(pg);
  }

  // Reflect current values in the controls (text shows only while editing; the PDF draws it otherwise).
  function syncLayer(pg) {
    const el = wraps.get(pg.id);
    const src = S.sources.get(pg.src);
    if (!el || !src) return;
    el.querySelectorAll('.fields .fld').forEach((c) => {
      const v = valueOf(src, c.dataset.name);
      if (c.classList.contains('fld-check')) c.setAttribute('aria-pressed', String(!!v));
      else if (c.classList.contains('fld-radio')) c.setAttribute('aria-pressed', String(v === c.dataset.value));
      else if (document.activeElement !== c) c.value = v ?? '';
    });
  }

  Folio.onRebuild.push(() => { for (const pg of S.pages) buildLayer(pg).catch((e) => console.warn('form fields', e)); });
  Folio.forms = { widgetsFor, buildLayer };
})();
