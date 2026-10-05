/* Folio — Combine files: gather PDFs, images, Office/HTML/text files into one new PDF.
   Files can be reordered, removed or trimmed to a page range; each file gets a bookmark. */
'use strict';

(() => {
  const { PDFName, PDFHexString } = PDFLib;
  let items = [];          // { id, name, path, data: Uint8Array (PDF), pages, thumb, range }
  let bookmarks = true;
  let combining = false;
  S.outline = [];          // [{ title, pid }] bookmarks for the current document

  TOOL_BUTTONS.combine = { icon: 'combine', label: 'Combine files', title: 'Combine files into one PDF', action: () => openCombine() };
  $('#btnCombine').onclick = () => openCombine();

  // ------------------------------------------------------------ adding files
  async function toPdfBytes(f) {
    const bytes = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
    if (isImageName(f.name)) return new Uint8Array(await imageFileToPdf(bytes, mimeOf(f.name)));
    if (Folio.createPdf?.handles(f.name)) return Folio.createPdf.convert({ ...f, data: bytes });
    return bytes;
  }

  async function addFiles(files) {
    for (const f of files) {
      const it = { id: uid(), name: f.name, path: f.path || null, range: '', pages: 0, thumb: '', loading: true };
      items.push(it);
      render();
      try {
        it.data = await toPdfBytes(f);
        const doc = await loadPdfjs(it.data);
        it.pages = doc.numPages;
        const page = await doc.getPage(1);
        const vp0 = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: 220 / Math.max(vp0.width, vp0.height) });
        const c = document.createElement('canvas');
        c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
        it.thumb = c.toDataURL('image/jpeg', 0.8);
        doc.destroy();
      } catch (e) {
        it.error = e?.name === 'PasswordException' ? 'Password-protected. Unlock it first.' : (e.message || 'Could not read this file');
      }
      it.loading = false;
      render();
    }
  }

  async function addOpenDocument() {
    if (!S.pages.length) return;
    busy('Preparing the open document…');
    try {
      const data = await exportPdf(S.pages);
      busy(null);
      await addFiles([{ name: S.docName, path: S.docDir ? `${S.docDir}\\${S.docName}` : null, data }]);
    } finally { busy(null); }
  }

  async function pick() {
    if (native) { const files = await native.openDialog({ title: 'Add files to combine' }); if (files.length) addFiles(files); return; }
    const inp = document.createElement('input');
    inp.type = 'file'; inp.multiple = true; inp.accept = '.pdf,image/*,.html,.htm,.txt';
    inp.onchange = async () => addFiles(await filesFromInput(inp.files));
    inp.click();
  }

  // ------------------------------------------------------------ dialog
  function openCombine() {
    items = [];
    openPanel({
      title: 'Combine files',
      wide: true,
      body: `<div class="cmb-bar">
          <button type="button" class="btn sm" id="cmbAdd"><i data-i="add"></i><span>Add files…</span></button>
          ${S.pages.length ? `<button type="button" class="btn sm" id="cmbOpen"><i data-i="open"></i><span>Add open document</span></button>` : ''}
          <span class="grow"></span>
          <label class="check"><input type="checkbox" id="cmbMarks" ${bookmarks ? 'checked' : ''}> Add a bookmark for each file</label>
        </div>
        <div class="cmb-grid" id="cmbGrid"></div>
        <p class="note" id="cmbSummary"></p>`,
      actions: [{ label: 'Cancel' }, {
        label: 'Combine', primary: true,
        run: async () => {
          const ready = items.filter((i) => !i.error && !i.loading);
          if (items.some((i) => i.loading)) { toast('Wait for all files to finish loading', true); return false; }
          if (ready.length < 2) { toast('Add at least two files to combine', true); return false; }
          try { ready.forEach((i) => Folio.convert.parseRange(i.range, i.pages)); } catch (e) { toast(e.message, true); return false; }
          setTimeout(() => combine(ready), 0);
          return true;
        },
      }],
      onOpen: (form) => {
        form.querySelector('#cmbAdd').onclick = pick;
        form.querySelector('#cmbOpen')?.addEventListener('click', addOpenDocument);
        form.querySelector('#cmbMarks').onchange = (e) => { bookmarks = e.target.checked; };
        // files dropped on the dialog go into the list, not into the open document
        const dlg = $('#panelDlg');
        const stop = (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); e.stopPropagation(); } };
        dlg.ondragenter = stop; dlg.ondragover = stop; dlg.ondragleave = stop;
        dlg.ondrop = async (e) => {
          if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
          e.preventDefault(); e.stopPropagation();
          $('#dropVeil').hidden = true;
          addFiles(await filesFromInput(e.dataTransfer.files));
        };
        render();
      },
      onClose: () => { const dlg = $('#panelDlg'); dlg.ondragenter = dlg.ondragover = dlg.ondragleave = dlg.ondrop = null; },
    });
  }

  let dragId = null;
  function render() {
    const grid = $('#cmbGrid');
    if (!grid) return;
    if (!items.length) {
      grid.innerHTML = `<div class="cmb-empty"><i data-i="combine"></i><b>Add files to combine</b><span>PDFs, images, Word, Excel, PowerPoint, web pages and text files. Drag files here or use Add files.</span></div>`;
    } else {
      grid.innerHTML = items.map((it, i) => `
        <div class="cmb-card${it.error ? ' bad' : ''}" draggable="${!it.loading}" data-id="${it.id}">
          <span class="cmb-num">${i + 1}</span>
          <button type="button" class="cmb-x" data-rm="${it.id}" title="Remove">×</button>
          <div class="cmb-thumb">${it.loading ? '<span class="spinner"></span>' : it.thumb ? `<img src="${it.thumb}" alt="">` : '<i data-i="totext"></i>'}</div>
          <div class="cmb-name" title="${esc(it.name)}">${esc(it.name)}</div>
          <div class="cmb-meta">${it.error ? esc(it.error) : it.loading ? 'Loading…' : `${it.pages} page${it.pages === 1 ? '' : 's'}`}</div>
          ${!it.error && !it.loading && it.pages > 1 ? `<input class="form-input cmb-range" data-range="${it.id}" placeholder="All pages" value="${esc(it.range)}" title="Pages to include, e.g. 1-3, 5" spellcheck="false">` : ''}
        </div>`).join('');
    }
    hydrateIcons(grid);
    grid.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => { items = items.filter((x) => x.id !== b.dataset.rm); render(); }; });
    grid.querySelectorAll('[data-range]').forEach((inp) => {
      inp.oninput = () => { items.find((x) => x.id === inp.dataset.range).range = inp.value; summary(); };
      inp.onkeydown = (e) => e.stopPropagation();
    });
    grid.querySelectorAll('.cmb-card').forEach((card) => {
      card.ondragstart = (e) => { dragId = card.dataset.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/x-folio-combine', dragId); card.classList.add('dragging'); };
      card.ondragend = () => { dragId = null; grid.querySelectorAll('.cmb-card').forEach((c) => c.classList.remove('dragging', 'drop-before', 'drop-after')); };
      card.ondragover = (e) => {
        if (!dragId) return;
        e.preventDefault(); e.stopPropagation();
        const r = card.getBoundingClientRect();
        const after = e.clientX > r.left + r.width / 2;
        grid.querySelectorAll('.cmb-card').forEach((c) => c.classList.remove('drop-before', 'drop-after'));
        card.classList.add(after ? 'drop-after' : 'drop-before');
      };
      card.ondrop = (e) => {
        if (!dragId) return;
        e.preventDefault(); e.stopPropagation();
        const after = card.classList.contains('drop-after');
        const moving = items.find((x) => x.id === dragId);
        items = items.filter((x) => x !== moving);
        let at = items.findIndex((x) => x.id === card.dataset.id);
        if (after) at++;
        items.splice(at, 0, moving);
        dragId = null;
        render();
      };
    });
    summary();
  }

  function summary() {
    const el = $('#cmbSummary');
    if (!el) return;
    const ok = items.filter((i) => !i.error && !i.loading);
    let pages = 0, bad = false;
    for (const it of ok) { try { pages += Folio.convert.parseRange(it.range, it.pages).length; } catch { bad = true; } }
    el.textContent = !items.length ? '' : `${ok.length} file${ok.length === 1 ? '' : 's'} · ${pages} page${pages === 1 ? '' : 's'} in the combined PDF${bad ? ' · check the page ranges' : ''}. Drag cards to change the order.`;
  }

  // ------------------------------------------------------------ combine
  async function combine(list) {
    combining = true;
    busy('Combining files…');
    try {
      const all = [];
      const outline = [];
      for (const [n, it] of list.entries()) {
        busy(`Combining file ${n + 1} of ${list.length}…`);
        const pages = await addSource(it.data, it.name, it.path);
        const keep = Folio.convert.parseRange(it.range, pages.length).map((i) => pages[i]);
        if (!keep.length) continue;
        outline.push({ title: it.name.replace(/\.[^.]+$/, ''), pid: keep[0].id });
        all.push(...keep);
      }
      checkpoint();
      S.pages = all;
      S.docName = 'Combined.pdf';
      S.docDir = list.find((i) => i.path)?.path.replace(/[\\/][^\\/]*$/, '') || S.docDir;
      S.selPages.clear();
      H.undo.length = 0; H.redo.length = 0;
      S.stamps = {};
      clearSearch();
      rebuild();
      renderForms();
      Folio.onIngest.forEach((f) => f(all, 'replace'));
      S.outline = bookmarks ? outline : [];
      setDirty(true);
      syncHistoryButtons();
      setZoom('fit');
      $('#viewer').scrollTop = 0;
      toast(`Combined ${list.length} files into ${all.length} pages. Save to keep it.`);
    } catch (e) {
      console.error(e);
      toast('Combine failed: ' + e.message, true);
    } finally {
      combining = false;
      busy(null);
    }
  }

  // Opening another document drops the previous document's bookmarks.
  Folio.onIngest.push((pages, mode) => { if (mode === 'replace' && !combining) S.outline = []; });

  // ------------------------------------------------------------ bookmarks in the saved PDF
  Folio.afterExport.push(async (out, layout) => {
    const index = new Map(layout.map((l) => [l.pid, l.index]));
    const entries = (S.outline || []).filter((e) => index.has(e.pid));
    if (!entries.length) return;
    const ctx = out.context;
    const root = ctx.nextRef();
    const refs = entries.map(() => ctx.nextRef());
    entries.forEach((e, i) => {
      const dict = ctx.obj({ Title: PDFHexString.fromText(e.title), Parent: root, Dest: [out.getPage(index.get(e.pid)).ref, 'Fit'] });
      if (i > 0) dict.set(PDFName.of('Prev'), refs[i - 1]);
      if (i < entries.length - 1) dict.set(PDFName.of('Next'), refs[i + 1]);
      ctx.assign(refs[i], dict);
    });
    ctx.assign(root, ctx.obj({ Type: 'Outlines', First: refs[0], Last: refs[refs.length - 1], Count: entries.length }));
    out.catalog.set(PDFName.of('Outlines'), root);
    out.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
  });

  Folio.combine = { open: openCombine, addFiles, combine: () => combine(items.filter((i) => !i.error && !i.loading)) };
})();
