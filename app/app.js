/* Folio — offline PDF editor.
   Rendering: pdf.js. Writing: pdf-lib. Everything runs locally; nothing is uploaded. */
'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
const PDFJS_OPTS = {
  cMapUrl: 'vendor/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: 'vendor/standard_fonts/',
  isEvalSupported: false, // CVE-2024-4367 hardening
};
const { PDFDocument, StandardFonts, rgb, degrees, BlendMode, LineCapStyle,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix } = PDFLib;

const native = window.folio || null; // Electron bridge; absent when opened in a plain browser

// Feature modules (fonts, edit, stamps, esign, convert) register themselves here.
const Folio = (globalThis.Folio = {
  tools: {},        // id -> { down(e, pid, pt, before), cursor }
  annotTypes: {},   // type -> { svg(a, interactive), bbox(a), export(page, a, ctx), move(a, dx, dy) }
  overlays: [],     // (pg) -> svg markup drawn above annotations
  exportPage: [],   // async (page, pg, ctx) after marks are drawn
  afterExport: [],  // async (out, layout, pageList) before the document is saved (bookmarks etc.)
  onIngest: [],     // (pages) after files are opened
  onRebuild: [],    // () after the page list changes
  inspector: {},    // type/tool -> (body, target) extra inspector UI
});

// ---------------------------------------------------------------- helpers
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const n2 = (v) => Math.round(v * 100) / 100;
const dpr = () => Math.min(window.devicePixelRatio || 1, 2);
const clone = (o) => JSON.parse(JSON.stringify(o));

const ICONS = {
  open: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1"/><path d="M3 7v11a1 1 0 0 0 1 1h14.5a1 1 0 0 0 1-.8L21 11H7.2a1 1 0 0 0-1 .8L4.5 19"/>',
  add: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11v6M9 14h6"/>',
  save: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  select: '<path d="M5 3l13 7-6 1.5L9.5 18z"/><path d="M12.5 12.5L17 17"/>',
  text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  highlight: '<path d="M14.5 4.5l5 5L11 18H6v-5z"/><path d="M3 21h8"/>',
  ink: '<path d="M3 17c3-6 5-9 7-9s1 6 3 6 3-4 5-4 2 3 3 3"/>',
  arrow: '<path d="M5 19L19 5M10 5h9v9"/>',
  line: '<path d="M5 19L19 5"/>',
  rect: '<rect x="4" y="5" width="16" height="14" rx="1"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="9" ry="7"/>',
  sign: '<path d="M3 17c2-1 3-5 5-5s0 5 2 5 2-3 4-3 1 3 3 3h4"/><path d="M3 21h18"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  whiteout: '<rect x="3" y="7" width="18" height="10" rx="1"/><path d="M7 12h10" stroke-dasharray="2 2"/>',
  redact: '<rect x="3" y="7" width="18" height="10" rx="1" fill="currentColor"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
  minus: '<path d="M5 12h14"/>', plus: '<path d="M12 5v14M5 12h14"/>',
  theme: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor"/>',
  rotl: '<path d="M4 4v5h5"/><path d="M4.5 9A8 8 0 1 1 6 16.5"/>',
  rotr: '<path d="M20 4v5h-5"/><path d="M19.5 9A8 8 0 1 0 18 16.5"/>',
  blank: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  dup: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h2"/>',
  extract: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 17v-6M9 14l3 3 3-3"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  front: '<rect x="8" y="8" width="12" height="12" rx="1" fill="currentColor"/><path d="M4 16V5a1 1 0 0 1 1-1h11"/>',
  initials: '<path d="M4 17V7M8 17l3-10 3 10M9 14h4"/><path d="M3 21h18"/>',
  date: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  check: '<path d="M4 12.5l5 5L20 6"/>',
  cross: '<path d="M6 6l12 12M18 6L6 18"/>',
  dot: '<circle cx="12" cy="12" r="4.5" fill="currentColor"/>',
  edittext: '<path d="M4 6V4h10v2M9 4v12"/><path d="M14 20l1-4 6-6 3 3-6 6z"/>',
  crop: '<path d="M6 2v16h16"/><path d="M2 6h16v16"/>',
  headerfooter: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 7h16M4 17h16"/>',
  watermark: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 15l8-6" stroke-dasharray="2 2"/>',
  bates: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 17h3M13 17h3"/><path d="M8 7h8"/>',
  certsign: '<path d="M4 17c2-1 3-5 5-5s0 5 2 5 2-3 3-3"/><circle cx="18" cy="8" r="3"/><path d="M16.5 10.5L15 15l3-1.5 3 1.5-1.5-4.5"/>',
  verify: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  toword: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M8 12l1.5 5L12 13l2.5 4L16 12"/>',
  toexcel: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 12l6 6M15 12l-6 6"/>',
  toppt: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M10 18v-6h2.5a2 2 0 0 1 0 4H10"/>',
  toimage: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  totext: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M8 13h8M8 17h5"/>',
  create: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11v6M9 14h6"/>',
  ocr: '<path d="M3 7V4h3M18 4h3v3M21 17v3h-3M6 20H3v-3"/><path d="M8 9h8M8 12h8M8 15h5"/>',
  compress: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M12 9v3M12 15v3M10 12h4"/>',
  bold: '<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z"/>',
  italic: '<path d="M10 5h8M6 19h8M15 5L9 19"/>',
  combine: '<rect x="3" y="3" width="8" height="10" rx="1"/><rect x="13" y="3" width="8" height="10" rx="1"/><path d="M7 13v3h10v-3M12 16v5M9 18l3 3 3-3"/>',
  grip: '<circle cx="9" cy="6" r="1" fill="currentColor"/><circle cx="15" cy="6" r="1" fill="currentColor"/><circle cx="9" cy="12" r="1" fill="currentColor"/><circle cx="15" cy="12" r="1" fill="currentColor"/><circle cx="9" cy="18" r="1" fill="currentColor"/><circle cx="15" cy="18" r="1" fill="currentColor"/>',
  alignl:'<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>',
  alignc: '<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>',
  alignr: '<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>',
};
function hydrateIcons(root = document) {
  $$('i[data-i]', root).forEach((el) => {
    if (!el.firstChild) el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[el.dataset.i] || ''}</svg>`;
  });
}

// ---------------------------------------------------------------- state
const TOOL_INFO = {
  select: { name: 'Select', hint: 'Click a mark to select it. Drag to move, drag the corner to resize. Delete removes it.' },
  text: { name: 'Text', hint: 'Click on a page to type. Double-click existing text to edit it.' },
  highlight: { name: 'Highlight', hint: 'Drag across text to highlight it.' },
  ink: { name: 'Draw', hint: 'Draw freehand on the page.' },
  arrow: { name: 'Arrow', hint: 'Drag to draw an arrow. Hold Shift to snap to 45°.' },
  line: { name: 'Line', hint: 'Drag to draw a line. Hold Shift to snap to 45°.' },
  rect: { name: 'Box', hint: 'Drag to draw a box. Hold Shift for a square.' },
  ellipse: { name: 'Ellipse', hint: 'Drag to draw an ellipse. Hold Shift for a circle.' },
  whiteout: { name: 'Whiteout', hint: 'Drag to cover content with white. The content underneath is still in the file.' },
  redact: { name: 'Redact', hint: 'Drag over content to remove. Redacted pages are flattened on save so the text underneath is gone.' },
  place: { name: 'Place', hint: 'Click on a page to place it. Esc to cancel.' },
  initials: { name: 'Initials', hint: 'Draw or type your initials, then click to place them.' },
  date: { name: 'Date', hint: 'Click on a page to stamp today’s date.' },
  check: { name: 'Checkmark', hint: 'Click to place a checkmark.' },
  cross: { name: 'Cross', hint: 'Click to place a cross.' },
  dot: { name: 'Dot', hint: 'Click to place a dot.' },
};

// Tool ribbons, modeled on Acrobat's tool sets.
const MODES = {
  comment: ['select', '|', 'text', 'highlight', 'ink', 'arrow', 'line', 'rect', 'ellipse', 'image', '|', 'whiteout', 'redact'],
  edit: ['select', '|', 'edittext', 'text', 'image', 'crop', '|', 'headerfooter', 'watermark', 'bates', '|', 'redact'],
  sign: ['select', '|', 'sign', 'initials', 'text', 'date', 'check', 'cross', 'dot', '|', 'certsign', 'verify'],
  convert: ['toword', 'toexcel', 'toppt', 'toimage', 'totext', '|', 'combine', 'create', 'ocr', 'compress'],
};
const TOOL_BUTTONS = {
  select: { icon: 'select', label: 'Select', key: 'V' },
  text: { icon: 'text', label: 'Add text', key: 'T' },
  highlight: { icon: 'highlight', label: 'Highlight', key: 'H' },
  ink: { icon: 'ink', label: 'Draw', key: 'D' },
  arrow: { icon: 'arrow', label: 'Arrow', key: 'A' },
  line: { icon: 'line', label: 'Line', key: 'L' },
  rect: { icon: 'rect', label: 'Box', key: 'R' },
  ellipse: { icon: 'ellipse', label: 'Ellipse', key: 'E' },
  image: { icon: 'image', label: 'Image', key: 'I' },
  whiteout: { icon: 'whiteout', label: 'Whiteout', key: 'W', title: 'Covers content; the original stays in the file' },
  redact: { icon: 'redact', label: 'Redact', key: 'X', danger: true, title: 'Permanently removes content on save' },
  sign: { icon: 'sign', label: 'Signature', key: 'S' },
  initials: { icon: 'initials', label: 'Initials' },
  date: { icon: 'date', label: 'Date' },
  check: { icon: 'check', label: '' , title: 'Checkmark' },
  cross: { icon: 'cross', label: '', title: 'Cross' },
  dot: { icon: 'dot', label: '', title: 'Dot' },
};
const toolMode = (t) => Object.keys(MODES).find((m) => MODES[m].includes(t));
const COLORS = ['#161a20', '#d92f2f', '#e07b00', '#11865b', '#1f5fd6', '#7a3fd1'];
const HL_COLORS = ['#ffd400', '#7cf27c', '#7cd3ff', '#ff8ad8', '#ffa26b'];
const RECT_TYPES = ['rect', 'ellipse', 'highlight', 'whiteout', 'redact'];
const BOX_TYPES = [...RECT_TYPES, 'image', 'mark'];
const KEEP_ASPECT = ['image', 'mark'];

const S = {
  sources: new Map(),   // id -> { id, name, path, orig, bytes, ver, doc, fields, formValues }
  pages: [],            // { id, src, idx, base, rot, W, H, annots: [] }
  zoom: 1, fit: true,
  mode: 'comment',
  tool: 'select',
  stamps: {},           // document-wide: header, footer, watermark, bates
  sel: null,            // { pid, aid }
  selPages: new Set(),
  current: null,        // page id in view
  editing: null,
  pending: null,        // image waiting to be placed
  hits: [],             // search results
  style: {
    text: { color: '#161a20', size: 14, font: 'Arial', bold: false, italic: false },
    date: { color: '#161a20', size: 12, font: 'Arial', bold: false, italic: false, format: 'MM/DD/YYYY' },
    mark: { color: '#161a20' },
    highlight: { color: '#ffd400' },
    ink: { color: '#1f5fd6', width: 2 },
    arrow: { color: '#d92f2f', width: 2 },
    line: { color: '#d92f2f', width: 2 },
    rect: { color: '#d92f2f', width: 2 },
    ellipse: { color: '#d92f2f', width: 2 },
  },
  docName: 'Untitled.pdf',
  docDir: null,
  dirty: false,
};
const getPage = (id) => S.pages.find((p) => p.id === id);
const getAnnot = (pid, aid) => getPage(pid)?.annots.find((a) => a.id === aid);
const pageIndex = (id) => S.pages.findIndex((p) => p.id === id);

function setDirty(v) {
  S.dirty = v;
  native?.setDirty(v);
  const t = `${v ? '• ' : ''}${S.docName} — Folio`;
  document.title = t;
  native?.setTitle(t);
}

// ---------------------------------------------------------------- history
const H = { undo: [], redo: [] };
const snap = () => JSON.stringify({ pages: S.pages, stamps: S.stamps });
function restore(s) {
  const o = JSON.parse(s);
  S.pages = o.pages;
  S.stamps = o.stamps || {};
}
function checkpoint(s = snap()) {
  H.undo.push(s);
  if (H.undo.length > 100) H.undo.shift();
  H.redo.length = 0;
  setDirty(true);
  syncHistoryButtons();
}
function undo() {
  if (S.editing) commitEdit();
  if (!H.undo.length) return;
  H.redo.push(snap());
  restore(H.undo.pop());
  afterHistory();
}
function redo() {
  if (!H.redo.length) return;
  H.undo.push(snap());
  restore(H.redo.pop());
  afterHistory();
}
function afterHistory() {
  S.sel = null;
  S.selPages = new Set([...S.selPages].filter((id) => getPage(id)));
  setDirty(true);
  rebuild();
  renderInspector();
  syncHistoryButtons();
}
function syncHistoryButtons() {
  $('#btnUndo').disabled = !H.undo.length;
  $('#btnRedo').disabled = !H.redo.length;
}

// ---------------------------------------------------------------- UI chrome
let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', err);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), err ? 5000 : 2600);
}
function busy(text) {
  $('#busyText').textContent = text || 'Working…';
  $('#busy').hidden = !text;
}
function confirmBox(title, text, yes = 'OK') {
  return new Promise((resolve) => {
    const d = $('#confirmDlg');
    $('#confirmTitle').textContent = title;
    $('#confirmText').textContent = text;
    $('#confirmYes').textContent = yes;
    const done = (v) => { d.close(); resolve(v); };
    $('#confirmYes').onclick = () => done(true);
    $('#confirmNo').onclick = () => done(false);
    d.oncancel = () => resolve(false);
    d.showModal();
  });
}

// ---------------------------------------------------------------- loading
async function loadPdfjs(bytes) {
  return pdfjsLib.getDocument({ ...PDFJS_OPTS, data: bytes.slice() }).promise;
}

function describeFields(form) {
  const L = PDFLib;
  return form.getFields().map((f) => {
    const name = f.getName();
    try {
      if (f instanceof L.PDFTextField) return { name, kind: 'text', multi: f.isMultiline(), value: f.getText() || '' };
      if (f instanceof L.PDFCheckBox) return { name, kind: 'check', value: f.isChecked() };
      if (f instanceof L.PDFDropdown || f instanceof L.PDFOptionList) return { name, kind: 'select', options: f.getOptions(), value: f.getSelected()[0] || '' };
      if (f instanceof L.PDFRadioGroup) return { name, kind: 'radio', options: f.getOptions(), value: f.getSelected() || '' };
    } catch { /* unreadable field */ }
    return null;
  }).filter(Boolean);
}

// A loaded PDF that pages can refer to. Edited pages get their own derived sources.
async function registerSource(bytes, name, path = null) {
  const id = uid();
  let doc;
  try {
    doc = await loadPdfjs(bytes);
  } catch (e) {
    if (e?.name === 'PasswordException') throw new Error(`“${name}” is password-protected. Remove the password, then open it again.`);
    throw new Error(`“${name}” could not be read as a PDF.`);
  }
  const src = { id, name, path, orig: bytes, bytes, ver: 0, doc, fields: [], formValues: {} };
  S.sources.set(id, src);
  return src;
}

async function addSource(bytes, name, path = null) {
  const src = await registerSource(bytes, name, path);
  const { id, doc } = src;
  try {
    const lib = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    src.fields = describeFields(lib.getForm());
  } catch { /* no usable form */ }
  const pages = [];
  for (let i = 0; i < doc.numPages; i++) {
    const p = await doc.getPage(i + 1);
    const vp = p.getViewport({ scale: 1 });
    pages.push({ id: uid(), src: id, idx: i, base: p.rotate, rot: 0, W: n2(vp.width), H: n2(vp.height), annots: [] });
  }
  return pages;
}

async function imageFileToPdf(bytes, type) {
  const d = await PDFDocument.create();
  let img;
  if (/png/.test(type)) img = await d.embedPng(bytes);
  else if (/jpe?g/.test(type)) img = await d.embedJpg(bytes);
  else img = await d.embedPng(await toPngBytes(bytes, type));
  const s = Math.min(612 / img.width, 792 / img.height, 1);
  const w = img.width * s, h = img.height * s;
  const page = d.addPage([w, h]);
  page.drawImage(img, { x: 0, y: 0, width: w, height: h });
  return d.save();
}
async function toPngBytes(bytes, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const img = await loadImage(url);
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  URL.revokeObjectURL(url);
  return new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer());
}
const loadImage = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });

const isImageName = (n) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(n);
const mimeOf = (n) => ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' }[n.split('.').pop().toLowerCase()] || 'application/pdf');

// files: [{ name, path?, data: Uint8Array }]
async function ingest(files, mode) {
  if (!files.length) return;
  if (S.editing) commitEdit();
  busy(files.length > 1 ? `Opening ${files.length} files…` : `Opening ${files[0].name}…`);
  const added = [];
  try {
    for (const f of files) {
      try {
        let bytes = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
        if (isImageName(f.name)) bytes = await imageFileToPdf(bytes, mimeOf(f.name));
        else if (Folio.createPdf?.handles(f.name)) { busy(`Converting ${f.name} to PDF…`); bytes = await Folio.createPdf.convert(f); }
        added.push(...(await addSource(bytes, f.name, f.path)));
      } catch (e) {
        toast(e.message || `Could not open ${f.name}`, true);
      }
    }
  } finally { busy(null); }
  if (!added.length) return;

  checkpoint();
  if (mode === 'replace') {
    S.pages = added;
    const first = files.find((f) => /\.pdf$/i.test(f.name)) || files[0];
    S.docName = first.name.replace(/\.[^.]+$/, '') + '.pdf';
    S.docDir = first.path ? first.path.replace(/[\\/][^\\/]*$/, '') : null;
    S.selPages.clear();
    H.undo.length = 0; H.redo.length = 0;
    clearSearch();
    rebuild();
    setDirty(false);
    syncHistoryButtons();
    if (S.fit) setZoom('fit');
    $('#viewer').scrollTop = 0;
  } else {
    const at = S.current ? pageIndex(S.current) + 1 : S.pages.length;
    S.pages.splice(at, 0, ...added);
    rebuild();
    scrollToPage(added[0].id);
    toast(`Added ${added.length} page${added.length > 1 ? 's' : ''}`);
  }
  renderForms();
  Folio.onIngest.forEach((f) => f(added, mode));
}

async function pickFiles(mode) {
  if (native) return ingest(await native.openDialog({ title: mode === 'replace' ? 'Open' : 'Add pages' }), mode);
  $(mode === 'replace' ? '#fileOpen' : '#fileAdd').click();
}
async function filesFromInput(list) {
  return Promise.all([...list].map(async (f) => ({ name: f.name, path: f.path || null, data: new Uint8Array(await f.arrayBuffer()) })));
}

// ---------------------------------------------------------------- viewer
const wraps = new Map(); // page id -> element
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    e.target._vis = e.isIntersecting;
    if (e.isIntersecting) renderPage(e.target.dataset.id);
  }
}, { root: $('#viewer'), rootMargin: '900px 0px' });

function makeWrap(pg) {
  const el = document.createElement('div');
  el.className = 'page';
  el.dataset.id = pg.id;
  el.innerHTML = `<svg class="ov" xmlns="http://www.w3.org/2000/svg"></svg><span class="pnum"></span>`;
  const svg = el.querySelector('svg');
  svg.addEventListener('pointerdown', (e) => onDown(e, el.dataset.id));
  svg.addEventListener('pointermove', onMove);
  svg.addEventListener('pointerup', onUp);
  svg.addEventListener('pointercancel', onUp);
  svg.addEventListener('dblclick', (e) => onDbl(e, el.dataset.id));
  return el;
}

function rebuild() {
  const stack = $('#stack');
  const ids = new Set(S.pages.map((p) => p.id));
  for (const [id, el] of wraps) if (!ids.has(id)) { io.unobserve(el); el.remove(); wraps.delete(id); }
  S.pages.forEach((pg, i) => {
    let el = wraps.get(pg.id);
    if (!el) { el = makeWrap(pg); wraps.set(pg.id, el); io.observe(el); }
    el.style.width = pg.W * S.zoom + 'px';
    el.style.height = pg.H * S.zoom + 'px';
    el.querySelector('svg').setAttribute('viewBox', `0 0 ${pg.W} ${pg.H}`);
    el.querySelector('.pnum').textContent = `${i + 1}`;
    if (stack.children[i] !== el) stack.insertBefore(el, stack.children[i] || null);
    drawAnnots(pg);
    if (el._vis) renderPage(pg.id);
  });
  $('#empty').hidden = S.pages.length > 0;
  $('#pageCount').textContent = S.pages.length;
  if (!S.pages.find((p) => p.id === S.current)) S.current = S.pages[0]?.id || null;
  rebuildThumbs();
  updateStatus();
  Folio.onRebuild.forEach((f) => f());
}

async function renderPage(pid) {
  const pg = getPage(pid), el = wraps.get(pid);
  if (!pg || !el) return;
  const src = S.sources.get(pg.src);
  const scale = S.zoom * dpr();
  const key = `${scale}|${pg.rot}|${src.id}:${src.ver}|${pg.idx}`;
  if (el._key === key) return;
  el._key = key;
  el._task?.cancel();
  const page = await src.doc.getPage(pg.idx + 1);
  const vp = page.getViewport({ scale, rotation: (pg.base + pg.rot) % 360 });
  const c = document.createElement('canvas');
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const task = page.render({ canvasContext: c.getContext('2d'), viewport: vp });
  el._task = task;
  try { await task.promise; } catch (e) {
    if (e?.name !== 'RenderingCancelledException') { console.error(e); el._key = null; }
    return;
  }
  if (el._key !== key) return;
  el.querySelector('canvas')?.remove();
  el.prepend(c);
}

function invalidateSource(srcId) {
  S.pages.forEach((p) => {
    if (p.src !== srcId) return;
    const el = wraps.get(p.id);
    if (el) { el._key = null; if (el._vis) renderPage(p.id); }
    thumbCache.delete(p.id);
  });
  textCache.forEach((_, k) => { if (k.startsWith(srcId + ':')) textCache.delete(k); });
  rebuildThumbs();
}

// ---------------------------------------------------------------- zoom & scrolling
function setZoom(z) {
  const v = $('#viewer');
  if (z === 'fit') {
    S.fit = true;
    const maxW = Math.max(...S.pages.map((p) => p.W), 612);
    z = (v.clientWidth - 64) / maxW;
  } else S.fit = false;
  z = clamp(z, 0.1, 6);
  const anchor = S.current;
  const el = anchor && wraps.get(anchor);
  const frac = el ? (v.scrollTop - el.offsetTop) / el.offsetHeight : 0;
  S.zoom = z;
  rebuild();
  if (el) v.scrollTop = el.offsetTop + frac * el.offsetHeight;
  const sel = $('#zoomSel');
  const match = [...sel.options].find((o) => +o.value === Math.round(z * 100) / 100);
  if (S.fit) sel.value = 'fit';
  else if (match) sel.value = match.value;
  else { const o = sel.querySelector('[value="custom"]'); o.textContent = `${Math.round(z * 100)}%`; o.hidden = false; sel.value = 'custom'; }
  updateStatus();
  if (S.editing) positionEditor();
}
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6];
function zoomStep(dir) {
  const z = S.zoom;
  const next = dir > 0 ? ZOOM_STEPS.find((s) => s > z + 0.01) : [...ZOOM_STEPS].reverse().find((s) => s < z - 0.01);
  setZoom(next || z);
}

function scrollToPage(pid, flash = false) {
  const el = wraps.get(pid);
  if (!el) return;
  $('#viewer').scrollTo({ top: el.offsetTop - 20, behavior: 'smooth' });
  S.current = pid;
  updateStatus();
  if (flash) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
}

let scrollRaf = 0;
$('#viewer').addEventListener('scroll', () => {
  cancelAnimationFrame(scrollRaf);
  scrollRaf = requestAnimationFrame(() => {
    const v = $('#viewer');
    const mark = v.scrollTop + v.clientHeight * 0.35;
    let cur = S.pages[0]?.id;
    for (const pg of S.pages) {
      const el = wraps.get(pg.id);
      if (el && el.offsetTop <= mark) cur = pg.id; else break;
    }
    if (cur !== S.current) { S.current = cur; updateStatus(); markActiveThumb(); }
  });
});

function updateStatus() {
  const i = pageIndex(S.current);
  $('#stPage').textContent = S.pages.length ? `Page ${i + 1} of ${S.pages.length}` : 'No document';
  $('#stZoom').textContent = `${Math.round(S.zoom * 100)}%`;
}

// ---------------------------------------------------------------- annotation drawing
function bbox(a) {
  if (a.type === 'line' || a.type === 'arrow') {
    return { x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2), w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) };
  }
  if (a.type === 'ink') {
    const xs = a.points.map((p) => p[0]), ys = a.points.map((p) => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  if (Folio.annotTypes[a.type]?.bbox) return Folio.annotTypes[a.type].bbox(a);
  return { x: a.x, y: a.y, w: a.w, h: a.h };
}

function pathD(a) {
  if (a.type === 'ink') return 'M' + a.points.map((p) => `${n2(p[0])} ${n2(p[1])}`).join(' L');
  let d = `M${n2(a.x1)} ${n2(a.y1)} L${n2(a.x2)} ${n2(a.y2)}`;
  if (a.type === 'arrow') {
    const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1), L = Math.max(9, a.width * 4.5);
    const p = (o) => `${n2(a.x2 - L * Math.cos(ang + o))} ${n2(a.y2 - L * Math.sin(ang + o))}`;
    d += ` M${p(-Math.PI / 7)} L${n2(a.x2)} ${n2(a.y2)} L${p(Math.PI / 7)}`;
  }
  return d;
}

const TEXT_ASC = 0.94, TEXT_LH = 1.2;
const measureCtx = document.createElement('canvas').getContext('2d');
const fontCss = (a) => Folio.fonts?.css(a.font) || 'Helvetica, Arial, sans-serif';
const cssFont = (a, size = a.size) => `${a.italic ? 'italic ' : ''}${a.bold ? 'bold ' : ''}${size}px ${fontCss(a)}`;
// Lines exactly as they will be drawn: explicit breaks, plus word wrap when the box has a fixed width.
function textLines(a) {
  measureCtx.font = cssFont(a);
  const out = [];
  for (const para of a.text.split('\n')) {
    if (!a.wrap) { out.push(para); continue; }
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const test = line + word;
      if (line && measureCtx.measureText(test.trimEnd()).width > a.wrap) { out.push(line.trimEnd()); line = word.trimStart(); }
      else line = test;
    }
    out.push(line.trimEnd());
  }
  return out;
}
function lineWidth(a, s) { measureCtx.font = cssFont(a); return measureCtx.measureText(s).width; }
function lineX(a, s) {
  if (!a.wrap || !a.align || a.align === 'left') return a.x;
  const w = lineWidth(a, s);
  return a.align === 'center' ? a.x + (a.wrap - w) / 2 : a.x + a.wrap - w;
}
const lh = (a) => a.lh || TEXT_LH;
function measureText(a) {
  const lines = textLines(a);
  a.w = a.wrap || Math.max(8, ...lines.map((l) => lineWidth(a, l))) + 2;
  a.h = Math.max(1, lines.length) * a.size * lh(a);
}

function annotSvg(a, interactive) {
  const aid = interactive ? ` data-aid="${a.id}"` : '';
  switch (a.type) {
    case 'rect':
      return `<rect${aid} x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" fill="none" stroke="${a.color}" stroke-width="${a.width}"/>` +
        (interactive ? `<rect data-aid="${a.id}" x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" fill="none" stroke="transparent" stroke-width="${a.width + 8}"/>` : '');
    case 'ellipse':
      return `<ellipse${aid} cx="${a.x + a.w / 2}" cy="${a.y + a.h / 2}" rx="${a.w / 2}" ry="${a.h / 2}" fill="none" stroke="${a.color}" stroke-width="${a.width}"/>` +
        (interactive ? `<ellipse data-aid="${a.id}" cx="${a.x + a.w / 2}" cy="${a.y + a.h / 2}" rx="${a.w / 2}" ry="${a.h / 2}" fill="none" stroke="transparent" stroke-width="${a.width + 8}"/>` : '');
    case 'highlight':
      return `<rect${aid} x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" fill="${a.color}" opacity=".5" style="mix-blend-mode:multiply"/>`;
    case 'whiteout':
      return `<rect${aid} x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" fill="#fff"${interactive ? ' stroke="#9aa3ae" stroke-width=".5" stroke-dasharray="2 2"' : ''}/>`;
    case 'redact':
      return `<rect${aid} x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" fill="#000"/>`;
    case 'line': case 'arrow': case 'ink': {
      const d = pathD(a);
      return `<path d="${d}" fill="none" stroke="${a.color}" stroke-width="${a.width}" stroke-linecap="round" stroke-linejoin="round"/>` +
        (interactive ? `<path data-aid="${a.id}" d="${d}" fill="none" stroke="transparent" stroke-width="${Math.max(10, a.width + 8)}" stroke-linecap="round"/>` : '');
    }
    case 'text': {
      if (S.editing && S.editing.aid === a.id && interactive) return '';
      const spans = textLines(a).map((ln, i) =>
        `<tspan x="${n2(lineX(a, ln))}" y="${n2(a.y + a.size * TEXT_ASC + i * a.size * lh(a))}">${esc(ln) || ' '}</tspan>`).join('');
      const cover = a.cover ? `<rect x="${a.cover.x}" y="${a.cover.y}" width="${a.cover.w}" height="${a.cover.h}" fill="#fff"/>` : '';
      return cover + `<text font-family="${esc(fontCss(a))}" font-size="${a.size}" font-weight="${a.bold ? 700 : 400}" font-style="${a.italic ? 'italic' : 'normal'}" fill="${a.color}" style="white-space:pre">${spans}</text>` +
        (interactive ? `<rect data-aid="${a.id}" x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" fill="transparent"${a.replaces ? ' class="edited" stroke="var(--sel)" stroke-width=".6" stroke-dasharray="3 2" stroke-opacity=".5"' : ''}/>` : '');
    }
    case 'image':
      return `<image${aid} href="${a.data}" x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" preserveAspectRatio="none"/>`;
    case 'mark': {
      const k = a.w / 24;
      const body = a.kind === 'dot'
        ? `<circle cx="12" cy="12" r="5" fill="${a.color}"/>`
        : `<path d="${MARK_PATHS[a.kind]}" fill="none" stroke="${a.color}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`;
      return `<g transform="translate(${a.x} ${a.y}) scale(${n2(k)})">${body}</g>` +
        (interactive ? `<rect data-aid="${a.id}" x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" fill="transparent"/>` : '');
    }
  }
  return Folio.annotTypes[a.type]?.svg(a, interactive) || '';
}
const MARK_PATHS = { check: 'M4 12.5l5 5L20 6', cross: 'M6 6l12 12M18 6L6 18' };

function drawAnnots(pg) {
  const el = wraps.get(pg.id);
  if (!el) return;
  const svg = el.querySelector('svg');
  let html = Folio.overlays.map((f) => f(pg, 'under') || '').join('');
  html += pg.annots.map((a) => annotSvg(a, true)).join('');
  html += Folio.overlays.map((f) => f(pg, 'over') || '').join('');
  // search hits
  for (const h of S.hits) {
    if (h.pid !== pg.id) continue;
    for (const r of h.rects) html += `<rect class="hit" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="#ffb300" opacity=".35" pointer-events="none"/>`;
  }
  // selection
  if (S.sel && S.sel.pid === pg.id) {
    const a = getAnnot(pg.id, S.sel.aid);
    if (a) {
      const k = 1 / S.zoom, b = bbox(a), pad = 3 * k, hs = 4.5 * k;
      html += `<rect x="${b.x - pad}" y="${b.y - pad}" width="${b.w + pad * 2}" height="${b.h + pad * 2}" fill="none" stroke="var(--sel)" stroke-width="${1.2 * k}" stroke-dasharray="${4 * k} ${3 * k}" pointer-events="none"/>`;
      const handle = (name, x, y) => `<rect data-h="${name}" x="${x - hs}" y="${y - hs}" width="${hs * 2}" height="${hs * 2}" fill="#fff" stroke="var(--sel)" stroke-width="${1.4 * k}"/>`;
      if (BOX_TYPES.includes(a.type) || Folio.annotTypes[a.type]?.resizable) html += handle('se', b.x + b.w + pad, b.y + b.h + pad);
      if (a.type === 'text' && a.wrap) html += handle('e', b.x + b.w + pad, b.y + b.h / 2);
      if (a.type === 'line' || a.type === 'arrow') html += handle('p1', a.x1, a.y1) + handle('p2', a.x2, a.y2);
    }
  }
  svg.innerHTML = html;
  refreshThumbOverlay(pg);
}

// ---------------------------------------------------------------- pointer interaction
let drag = null;

function toPagePt(e, svg) {
  const r = svg.getBoundingClientRect();
  const pg = getPage(svg.parentElement.dataset.id);
  return { x: ((e.clientX - r.left) / r.width) * pg.W, y: ((e.clientY - r.top) / r.height) * pg.H };
}

function newAnnot(type, props) {
  const st = S.style[type] || {};
  return { id: uid(), type, ...clone(st), ...props };
}

function onDown(e, pid) {
  if (e.button !== 0) return;
  const svg = e.currentTarget;
  const pg = getPage(pid);
  const pt = toPagePt(e, svg);
  S.current = pid; updateStatus();
  if (S.editing) { commitEdit(); if (S.tool === 'text') return; }
  const t = S.tool;
  const before = snap();

  if (Folio.tools[t]?.down) {
    const r = Folio.tools[t].down(e, pid, pt, before);
    if (r && r.drag) { drag = { ...r.drag, pid, start: pt, before, moved: false }; try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic or already-released pointer */ } e.preventDefault(); }
    return;
  }

  if (t === 'check' || t === 'cross' || t === 'dot') {
    const size = t === 'dot' ? 12 : 16;
    const a = { id: uid(), type: 'mark', kind: t, color: S.style.mark.color, x: n2(pt.x - size / 2), y: n2(pt.y - size / 2), w: size, h: size };
    pg.annots.push(a);
    checkpoint(before);
    drawAnnots(pg);
    return;
  }
  if (t === 'date') {
    const st = S.style.date;
    const a = { id: uid(), type: 'text', ...clone(st), text: formatDate(new Date(), st.format) };
    delete a.format;
    a.x = n2(pt.x); a.y = n2(pt.y - st.size * 0.6);
    measureText(a);
    pg.annots.push(a);
    checkpoint(before);
    drawAnnots(pg);
    return;
  }

  if (t === 'select') {
    const h = e.target.closest('[data-h]');
    const hit = e.target.closest('[data-aid]');
    if (h && S.sel) {
      const a = getAnnot(S.sel.pid, S.sel.aid);
      drag = { mode: 'handle', h: h.dataset.h, pid, a, start: pt, orig: clone(a), before, moved: false };
    } else if (hit) {
      select(pid, hit.dataset.aid);
      const a = getAnnot(pid, hit.dataset.aid);
      drag = { mode: 'move', pid, a, start: pt, orig: clone(a), before, moved: false };
    } else {
      select(null);
      return;
    }
  } else if (RECT_TYPES.includes(t)) {
    const a = newAnnot(t, { x: pt.x, y: pt.y, w: 0, h: 0 });
    pg.annots.push(a);
    drag = { mode: 'create', pid, a, start: pt, before, moved: false };
  } else if (t === 'line' || t === 'arrow') {
    const a = newAnnot(t, { x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y });
    pg.annots.push(a);
    drag = { mode: 'create', pid, a, start: pt, before, moved: false };
  } else if (t === 'ink') {
    const a = newAnnot('ink', { points: [[n2(pt.x), n2(pt.y)]] });
    pg.annots.push(a);
    drag = { mode: 'create', pid, a, start: pt, before, moved: false };
  } else if (t === 'text') {
    const st = S.style.text;
    const a = newAnnot('text', { x: n2(pt.x), y: n2(pt.y - st.size * 0.6), text: '' });
    measureText(a);
    pg.annots.push(a);
    startEdit(pid, a, before);
    return;
  } else if (t === 'place' && S.pending) {
    const p = S.pending;
    const w = Math.min(p.width, pg.W * 0.8), h = w / p.aspect;
    const a = { id: uid(), type: 'image', data: p.data, x: n2(pt.x - w / 2), y: n2(pt.y - h / 2), w: n2(w), h: n2(h) };
    pg.annots.push(a);
    checkpoint(before);
    S.pending = null;
    setTool('select');
    select(pid, a.id);
    return;
  } else return;

  try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic or already-released pointer */ }
  e.preventDefault();
}

const DATE_FORMATS = ['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD', 'MMMM D, YYYY', 'D MMMM YYYY'];
function formatDate(d, f) {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const p2 = (n) => String(n).padStart(2, '0');
  return f.replace(/YYYY|MMMM|MM|DD|D/g, (t) => ({
    YYYY: d.getFullYear(), MMMM: MONTHS[d.getMonth()], MM: p2(d.getMonth() + 1), DD: p2(d.getDate()), D: d.getDate(),
  }[t]));
}

function snapAngle(x0, y0, x, y) {
  const ang = Math.round(Math.atan2(y - y0, x - x0) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(x - x0, y - y0);
  return { x: x0 + len * Math.cos(ang), y: y0 + len * Math.sin(ang) };
}

function onMove(e) {
  if (!drag) return;
  const svg = e.currentTarget;
  const pg = getPage(drag.pid);
  let pt = toPagePt(e, svg);
  const a = drag.a;
  const dx = pt.x - drag.start.x, dy = pt.y - drag.start.y;
  if (!drag.moved && Math.hypot(dx, dy) * S.zoom < 2) return;
  drag.moved = true;

  if (drag.onMove) { drag.onMove(pt, e, dx, dy); return; }
  if (drag.mode === 'create') {
    if (RECT_TYPES.includes(a.type)) {
      let w = dx, h = dy;
      if (e.shiftKey && (a.type === 'rect' || a.type === 'ellipse')) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
      a.x = n2(Math.min(drag.start.x, drag.start.x + w)); a.y = n2(Math.min(drag.start.y, drag.start.y + h));
      a.w = n2(Math.abs(w)); a.h = n2(Math.abs(h));
    } else if (a.type === 'line' || a.type === 'arrow') {
      if (e.shiftKey) pt = snapAngle(a.x1, a.y1, pt.x, pt.y);
      a.x2 = n2(pt.x); a.y2 = n2(pt.y);
    } else if (a.type === 'ink') {
      const last = a.points[a.points.length - 1];
      if (Math.hypot(pt.x - last[0], pt.y - last[1]) * S.zoom > 1.5) a.points.push([n2(pt.x), n2(pt.y)]);
    }
  } else if (drag.mode === 'move') {
    const o = drag.orig;
    if (Folio.annotTypes[a.type]?.move) Folio.annotTypes[a.type].move(a, o, dx, dy);
    else if (o.points) a.points = o.points.map(([x, y]) => [n2(x + dx), n2(y + dy)]);
    else if ('x1' in o) { a.x1 = n2(o.x1 + dx); a.y1 = n2(o.y1 + dy); a.x2 = n2(o.x2 + dx); a.y2 = n2(o.y2 + dy); }
    else { a.x = n2(o.x + dx); a.y = n2(o.y + dy); }
  } else if (drag.mode === 'handle') {
    const o = drag.orig;
    if (drag.h === 'se') {
      let w = Math.max(4, o.w + dx), h = Math.max(4, o.h + dy);
      if (KEEP_ASPECT.includes(a.type) && !e.shiftKey) h = w * (o.h / o.w);
      a.w = n2(w); a.h = n2(h);
      Folio.annotTypes[a.type]?.resized?.(a);
    } else if (drag.h === 'e') {
      a.wrap = n2(Math.max(20, o.wrap + dx));
      measureText(a);
    } else if (drag.h === 'p1') { if (e.shiftKey) pt = snapAngle(a.x2, a.y2, pt.x, pt.y); a.x1 = n2(pt.x); a.y1 = n2(pt.y); }
    else if (drag.h === 'p2') { if (e.shiftKey) pt = snapAngle(a.x1, a.y1, pt.x, pt.y); a.x2 = n2(pt.x); a.y2 = n2(pt.y); }
  }
  drawAnnots(pg);
}

function onUp() {
  if (!drag) return;
  const d = drag;
  drag = null;
  const pg = getPage(d.pid);
  if (d.onUp) { d.onUp(d); return; }
  if (d.mode === 'create') {
    const a = d.a, b = bbox(a);
    const tooSmall = a.type === 'ink' ? a.points.length < 2 : Math.max(b.w, b.h) < 3;
    if (tooSmall) { pg.annots = pg.annots.filter((x) => x !== a); drawAnnots(pg); return; }
    checkpoint(d.before);
    drawAnnots(pg);
  } else if (d.moved) {
    checkpoint(d.before);
    renderInspector();
  }
}

function onDbl(e, pid) {
  const hit = e.target.closest('[data-aid]');
  if (!hit) return;
  const a = getAnnot(pid, hit.dataset.aid);
  if (a?.type === 'text') { select(null); startEdit(pid, a, snap()); }
}

function select(pid, aid) {
  const prev = S.sel?.pid;
  S.sel = pid ? { pid, aid } : null;
  if (prev && prev !== pid) drawAnnots(getPage(prev));
  if (pid) drawAnnots(getPage(pid));
  renderInspector();
}

function deleteSelected() {
  if (!S.sel) return;
  checkpoint();
  const pg = getPage(S.sel.pid);
  pg.annots = pg.annots.filter((a) => a.id !== S.sel.aid);
  S.sel = null;
  drawAnnots(pg);
  renderInspector();
}
function duplicateSelected() {
  if (!S.sel) return;
  checkpoint();
  const pg = getPage(S.sel.pid);
  const a = clone(getAnnot(S.sel.pid, S.sel.aid));
  a.id = uid();
  nudge(a, 12, 12);
  pg.annots.push(a);
  select(pg.id, a.id);
}
function nudge(a, dx, dy) {
  if (a.points) a.points = a.points.map(([x, y]) => [n2(x + dx), n2(y + dy)]);
  else if ('x1' in a) { a.x1 += dx; a.y1 += dy; a.x2 += dx; a.y2 += dy; }
  else { a.x = n2(a.x + dx); a.y = n2(a.y + dy); }
}
function bringToFront() {
  if (!S.sel) return;
  checkpoint();
  const pg = getPage(S.sel.pid);
  const a = getAnnot(pg.id, S.sel.aid);
  pg.annots = pg.annots.filter((x) => x !== a).concat(a);
  drawAnnots(pg);
}

// ---------------------------------------------------------------- text editing
function startEdit(pid, a, before) {
  const el = wraps.get(pid);
  const ta = document.createElement('textarea');
  ta.className = 'ted';
  ta.value = a.text;
  ta.spellcheck = true;
  el.appendChild(ta);
  S.editing = { pid, aid: a.id, ta, before };
  positionEditor();
  drawAnnots(getPage(pid));
  ta.addEventListener('input', positionEditor);
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); commitEdit(); }
  });
  ta.addEventListener('blur', () => setTimeout(() => { if (S.editing?.ta === ta) commitEdit(); }, 0));
  requestAnimationFrame(() => ta.focus());
}
function positionEditor() {
  const ed = S.editing;
  if (!ed) return;
  const a = getAnnot(ed.pid, ed.aid);
  const ta = ed.ta, z = S.zoom;
  Object.assign(ta.style, {
    left: a.x * z + 'px', top: a.y * z + 'px', fontSize: a.size * z + 'px', color: a.color,
    fontFamily: fontCss(a), fontWeight: a.bold ? 700 : 400, fontStyle: a.italic ? 'italic' : 'normal',
    lineHeight: String(lh(a)), whiteSpace: a.wrap ? 'pre-wrap' : 'pre', textAlign: a.align || 'left',
  });
  ta.style.height = '0px';
  if (a.wrap) ta.style.width = a.wrap * z + 'px';
  else { ta.style.width = '0px'; ta.style.width = Math.max(ta.scrollWidth + 4, 40 * z) + 'px'; }
  ta.style.height = ta.scrollHeight + 'px';
}
function commitEdit() {
  const ed = S.editing;
  if (!ed) return;
  S.editing = null;
  const pg = getPage(ed.pid);
  const a = pg && getAnnot(ed.pid, ed.aid);
  ed.ta.remove();
  if (!a) return;
  const text = ed.ta.value.replace(/\s+$/, '');
  if (!text.trim()) pg.annots = pg.annots.filter((x) => x !== a);
  else { a.text = text; measureText(a); }
  if (snap() !== ed.before) checkpoint(ed.before);
  drawAnnots(pg);
  if (a && text.trim() && S.tool === 'select') select(pg.id, a.id);
}

// ---------------------------------------------------------------- tools
function setTool(t) {
  if (S.editing) commitEdit();
  const btn = TOOL_BUTTONS[t];
  const m = toolMode(t);
  if (m && m !== S.mode && t !== 'select' && t !== 'text' && t !== 'image' && t !== 'redact') setMode(m, true);
  if (btn?.action) { btn.action(); return; }
  if (t === 'sign' || t === 'initials') { openSignature(t); return; }
  if (t === 'image') { pickImage(); return; }
  if (t !== 'place') S.pending = null;
  const prev = S.tool;
  if (prev !== t) Folio.tools[prev]?.deactivate?.();
  S.tool = t;
  document.body.dataset.tool = t;
  syncRibbon();
  if (t !== 'select' && S.sel) select(null);
  $('#stHint').textContent = TOOL_INFO[t]?.hint || '';
  if (prev !== t) Folio.tools[t]?.activate?.();
  renderInspector();
}

function setMode(m, keepTool = false) {
  S.mode = m;
  $$('#modes [role="tab"]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === m)));
  renderRibbon();
  try { localStorage.setItem('folio.mode', m); } catch { /* ignore */ }
  if (!keepTool && !MODES[m].includes(S.tool)) setTool('select');
}
function renderRibbon() {
  const bar = $('#tools');
  bar.innerHTML = MODES[S.mode].map((t) => {
    if (t === '|') return '<span class="sep"></span>';
    const b = TOOL_BUTTONS[t] || { icon: t, label: t };
    const title = `${b.title || b.label || TOOL_INFO[t]?.name || ''}${b.key ? ` (${b.key})` : ''}`;
    return `<button class="tool${b.danger ? ' danger' : ''}${b.action ? ' action' : ''}" data-tool="${t}" title="${esc(title)}"><i data-i="${b.icon}"></i>${b.label ? `<span>${esc(b.label)}</span>` : ''}</button>`;
  }).join('');
  hydrateIcons(bar);
  $$('.tool', bar).forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  syncRibbon();
}
function syncRibbon() {
  const t = S.tool;
  $$('#tools .tool').forEach((b) => b.setAttribute('aria-pressed', String(!TOOL_BUTTONS[b.dataset.tool]?.action && (b.dataset.tool === t || (t === 'place' && b.dataset.tool === S.placeKind)))));
}

async function pickImage() {
  let file;
  if (native) {
    const files = await native.openDialog({ title: 'Insert image', images: true });
    if (!files.length) return;
    file = { name: files[0].name, data: files[0].data };
  } else {
    const inp = $('#fileImage');
    inp.value = '';
    inp.click();
    await new Promise((r) => { inp.onchange = r; });
    if (!inp.files[0]) return;
    file = { name: inp.files[0].name, data: new Uint8Array(await inp.files[0].arrayBuffer()) };
  }
  let type = mimeOf(file.name), bytes = file.data;
  if (!/png|jpeg/.test(type)) { bytes = await toPngBytes(bytes, type); type = 'image/png'; }
  const data = await bytesToDataUrl(bytes, type);
  const img = await loadImage(data);
  beginPlace({ data, aspect: img.naturalWidth / img.naturalHeight, width: Math.min(240, img.naturalWidth * 0.75) }, 'image');
}
function bytesToDataUrl(bytes, type) {
  return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(new Blob([bytes], { type })); });
}
function beginPlace(p, kind) {
  S.pending = p;
  S.placeKind = kind;
  setTool('place');
  toast('Click on a page to place it');
}

// ---------------------------------------------------------------- inspector
function swatchRow(colors, current, onPick) {
  const wrap = document.createElement('div');
  wrap.className = 'swatches';
  colors.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'sw'; b.style.background = c; b.title = c;
    b.setAttribute('aria-pressed', String(c.toLowerCase() === (current || '').toLowerCase()));
    b.onclick = () => onPick(c);
    wrap.appendChild(b);
  });
  const custom = document.createElement('label');
  custom.className = 'sw custom'; custom.title = 'Custom color';
  custom.innerHTML = `<input type="color" value="${current || '#000000'}">`;
  custom.querySelector('input').addEventListener('change', (e) => onPick(e.target.value));
  wrap.appendChild(custom);
  return wrap;
}

function fontControls(body, target, apply) {
  const f = document.createElement('div');
  f.className = 'field';
  const families = Folio.fonts?.families() || ['Arial'];
  if (!families.includes(target.font)) families.unshift(target.font);
  f.innerHTML = `<span class="label">Font</span>
    <select class="form-input" id="insp-font">${families.map((n) => `<option ${n === target.font ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
    <div class="row seg-row">
      <button class="icon-btn sm toggle" id="insp-bold" aria-pressed="${!!target.bold}" title="Bold"><i data-i="bold"></i></button>
      <button class="icon-btn sm toggle" id="insp-italic" aria-pressed="${!!target.italic}" title="Italic"><i data-i="italic"></i></button>
      ${target.wrap ? `<span class="sep"></span>${['left', 'center', 'right'].map((al) => `<button class="icon-btn sm toggle" data-align="${al}" aria-pressed="${(target.align || 'left') === al}" title="Align ${al}"><i data-i="align${al[0]}"></i></button>`).join('')}` : ''}
    </div>`;
  f.querySelector('#insp-font').onchange = (e) => apply((o) => { o.font = e.target.value; });
  f.querySelector('#insp-bold').onclick = () => apply((o) => { o.bold = !o.bold; });
  f.querySelector('#insp-italic').onclick = () => apply((o) => { o.italic = !o.italic; });
  $$('[data-align]', f).forEach((b) => { b.onclick = () => apply((o) => { o.align = b.dataset.align; }); });
  body.appendChild(f);
}

function renderInspector() {
  const body = $('#styleBody');
  body.innerHTML = '';
  const a = S.sel && getAnnot(S.sel.pid, S.sel.aid);
  const tool = S.tool === 'place' ? null : S.tool;
  const type = a ? a.type : (['check', 'cross', 'dot'].includes(tool) ? 'mark' : tool);
  const target = a || S.style[type];
  const titleName = a ? ({ text: a.replaces ? 'Edited text' : 'Text', highlight: 'Highlight', ink: 'Drawing', arrow: 'Arrow', line: 'Line', rect: 'Box', ellipse: 'Ellipse', whiteout: 'Whiteout', redact: 'Redaction', image: 'Image', mark: 'Mark' }[a.type] || Folio.annotTypes[a.type]?.name) : TOOL_INFO[S.tool]?.name;
  const icon = a ? (a.type === 'mark' ? a.kind : a.type) : (S.tool === 'place' ? S.placeKind : S.tool);

  const head = document.createElement('div');
  head.className = 'tool-title';
  head.innerHTML = `<i data-i="${icon === 'text' ? 'text' : icon}"></i>${esc(titleName || '')}${a ? ' <span class="label" style="margin-left:auto">selected</span>' : ''}`;
  body.appendChild(head);

  const apply = (fn) => {
    if (a) { checkpoint(); fn(a); if (a.type === 'text') measureText(a); drawAnnots(getPage(S.sel.pid)); }
    else if (S.style[type]) fn(S.style[type]);
    renderInspector();
  };

  if (target && 'color' in target) {
    const f = document.createElement('div');
    f.className = 'field';
    f.innerHTML = '<span class="label">Color</span>';
    f.appendChild(swatchRow(type === 'highlight' ? HL_COLORS : COLORS, target.color, (c) => apply((o) => { o.color = c; })));
    body.appendChild(f);
  }
  const slider = (label, key, min, max, step, unit) => {
    const f = document.createElement('div');
    f.className = 'field';
    f.innerHTML = `<span class="label">${label}<output>${target[key]} ${unit}</output></span><input type="range" min="${min}" max="${max}" step="${step}" value="${target[key]}" id="insp-${key}">`;
    const r = f.querySelector('input'), out = f.querySelector('output');
    let before = null;
    r.addEventListener('input', () => {
      const v = +r.value;
      out.textContent = `${v} ${unit}`;
      if (a) {
        if (before === null) before = snap();
        a[key] = v;
        if (a.type === 'text') measureText(a);
        drawAnnots(getPage(S.sel.pid));
      } else S.style[type][key] = v;
    });
    r.addEventListener('change', () => { if (a && before !== null) { checkpoint(before); before = null; } });
    body.appendChild(f);
  };
  if (target && 'width' in target && type !== 'image') slider('Stroke', 'width', 0.5, 12, 0.5, 'pt');
  if (target && 'font' in target) fontControls(body, target, apply);
  if (target && 'size' in target) slider('Font size', 'size', 4, 96, 0.5, 'pt');
  if (target && 'format' in target) {
    const f = document.createElement('div');
    f.className = 'field';
    f.innerHTML = `<span class="label">Date format</span><select class="form-input" id="insp-datefmt">${DATE_FORMATS.map((d) => `<option value="${d}" ${d === target.format ? 'selected' : ''}>${esc(formatDate(new Date(), d))}</option>`).join('')}</select>`;
    f.querySelector('select').onchange = (e) => { target.format = e.target.value; };
    body.appendChild(f);
  }
  Folio.inspector[type]?.(body, target, a, apply);
  if (!a) Folio.inspector['tool:' + S.tool]?.(body);

  if (type === 'whiteout') body.insertAdjacentHTML('beforeend', '<p class="note">Whiteout only covers what is underneath. The original text is still in the file and can be copied out. Use Redact to remove it.</p>');
  if (type === 'redact') body.insertAdjacentHTML('beforeend', '<p class="note warn">On save, every page with a redaction is flattened to an image at 200 dpi, so the text and graphics under the box are removed for good. Text on those pages can no longer be selected or searched.</p>');
  if (type === 'highlight' && !a) body.insertAdjacentHTML('beforeend', '<p class="note">Tip: search for a phrase, then use <b>Highlight all</b> to mark every match at once.</p>');
  if (type === 'text' && a) body.insertAdjacentHTML('beforeend', '<p class="note">Double-click the text on the page to edit it.</p>');
  if (S.tool === 'place') body.insertAdjacentHTML('beforeend', '<p class="note">Click on a page to place it. Drag the corner to resize afterwards. Press Esc to cancel.</p>');

  if (a) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<button class="btn sm" id="aDup"><i data-i="dup"></i><span>Duplicate</span></button>
      <button class="btn sm" id="aFront"><i data-i="front"></i><span>To front</span></button>
      <button class="btn sm danger-outline" id="aDel"><i data-i="trash"></i><span>Delete</span></button>`;
    body.appendChild(row);
    row.querySelector('#aDup').onclick = duplicateSelected;
    row.querySelector('#aFront').onclick = bringToFront;
    row.querySelector('#aDel').onclick = deleteSelected;
  }

  if (!a && S.tool === 'select') {
    body.insertAdjacentHTML('beforeend', `<div class="divider"></div>
      <div class="field"><span class="label">Shortcuts</span>
      <div class="shortcuts">
        <span class="kbd">T</span><span>Text</span>
        <span class="kbd">H</span><span>Highlight</span>
        <span class="kbd">D</span><span>Draw</span>
        <span class="kbd">A / L</span><span>Arrow / line</span>
        <span class="kbd">R / E</span><span>Box / ellipse</span>
        <span class="kbd">S</span><span>Signature</span>
        <span class="kbd">X</span><span>Redact</span>
        <span class="kbd">Ctrl F</span><span>Search</span>
        <span class="kbd">Ctrl S</span><span>Save</span>
        <span class="kbd">Ctrl Z / Y</span><span>Undo / redo</span>
        <span class="kbd">Ctrl wheel</span><span>Zoom</span>
        <span class="kbd">Arrows</span><span>Nudge selection</span>
      </div></div>`);
  }
  hydrateIcons(body);
}

$$('.tabs [role="tab"]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
function showTab(name) {
  $$('.tabs [role="tab"]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('.tab-body').forEach((b) => { b.hidden = b.dataset.body !== name; });
}

// ---------------------------------------------------------------- thumbnails
const thumbCache = new Map(); // pid -> { key, canvas }
let thumbQueue = Promise.resolve();
const THUMB_W = 132;

function rebuildThumbs() {
  const list = $('#thumbs');
  const existing = new Map($$('.thumb', list).map((t) => [t.dataset.id, t]));
  S.pages.forEach((pg, i) => {
    let t = existing.get(pg.id);
    if (!t) {
      t = document.createElement('div');
      t.className = 'thumb';
      t.draggable = true;
      t.dataset.id = pg.id;
      t.innerHTML = '<div class="tbox"><svg xmlns="http://www.w3.org/2000/svg"></svg></div><span class="tn"></span>';
      wireThumb(t);
    }
    existing.delete(pg.id);
    const box = t.querySelector('.tbox');
    box.style.aspectRatio = `${pg.W} / ${pg.H}`;
    t.querySelector('svg').setAttribute('viewBox', `0 0 ${pg.W} ${pg.H}`);
    t.querySelector('.tn').textContent = i + 1;
    t.classList.toggle('selected', S.selPages.has(pg.id));
    if (list.children[i] !== t) list.insertBefore(t, list.children[i] || null);
    refreshThumbOverlay(pg);
    queueThumb(pg);
  });
  existing.forEach((t) => t.remove());
  markActiveThumb();
}
function refreshThumbOverlay(pg) {
  const t = $(`#thumbs .thumb[data-id="${pg.id}"] svg`);
  if (t) t.innerHTML = pg.annots.map((a) => annotSvg(a, false)).join('');
}
function queueThumb(pg) {
  const src = S.sources.get(pg.src);
  const key = `${pg.rot}|${src.id}:${src.ver}|${pg.idx}`;
  const c = thumbCache.get(pg.id);
  const box = $(`#thumbs .thumb[data-id="${pg.id}"] .tbox`);
  if (c && c.key === key) {
    if (box && c.canvas.parentNode !== box) { box.querySelectorAll('canvas').forEach((old) => old.remove()); box.prepend(c.canvas); }
    return;
  }
  thumbQueue = thumbQueue.then(async () => {
    const cur = getPage(pg.id);
    if (!cur) return;
    const curSrc = S.sources.get(cur.src);
    if (`${cur.rot}|${curSrc.id}:${curSrc.ver}|${cur.idx}` !== key) return; // page changed since queued; a newer job covers it
    const page = await curSrc.doc.getPage(cur.idx + 1);
    const scale = (THUMB_W * dpr()) / cur.W;
    const vp = page.getViewport({ scale, rotation: (cur.base + cur.rot) % 360 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
    // 'print' intent isn't paced by animation frames, so the queue keeps moving while the window is minimized
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, intent: 'print' }).promise;
    thumbCache.get(pg.id)?.canvas.remove();
    thumbCache.set(pg.id, { key, canvas });
    const tbox = $(`#thumbs .thumb[data-id="${pg.id}"] .tbox`);
    if (tbox) { tbox.querySelectorAll('canvas').forEach((old) => old.remove()); tbox.prepend(canvas); }
  }).catch((e) => console.warn(e));
}
function markActiveThumb() {
  $$('#thumbs .thumb').forEach((t) => t.classList.toggle('active', t.dataset.id === S.current));
  const act = $(`#thumbs .thumb[data-id="${S.current}"]`);
  if (act) {
    const list = $('#thumbs');
    if (act.offsetTop < list.scrollTop || act.offsetTop + act.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTo({ top: act.offsetTop - 40 });
    }
  }
}

let lastThumbClick = null;
function wireThumb(t) {
  t.addEventListener('click', (e) => {
    const id = t.dataset.id;
    if (e.shiftKey && lastThumbClick) {
      const a = pageIndex(lastThumbClick), b = pageIndex(id);
      S.pages.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((p) => S.selPages.add(p.id));
    } else if (e.ctrlKey || e.metaKey) {
      S.selPages.has(id) ? S.selPages.delete(id) : S.selPages.add(id);
      lastThumbClick = id;
    } else {
      S.selPages = new Set([id]);
      lastThumbClick = id;
    }
    $$('#thumbs .thumb').forEach((x) => x.classList.toggle('selected', S.selPages.has(x.dataset.id)));
    scrollToPage(id);
  });
  t.addEventListener('dragstart', (e) => {
    const id = t.dataset.id;
    if (!S.selPages.has(id)) { S.selPages = new Set([id]); $$('#thumbs .thumb').forEach((x) => x.classList.toggle('selected', x === t)); }
    S.dragIds = S.pages.filter((p) => S.selPages.has(p.id)).map((p) => p.id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/x-folio-pages', '1');
    requestAnimationFrame(() => S.dragIds.forEach((pid) => $(`#thumbs .thumb[data-id="${pid}"]`)?.classList.add('dragging')));
  });
  t.addEventListener('dragend', () => {
    S.dragIds = null;
    $$('#thumbs .thumb').forEach((x) => x.classList.remove('dragging', 'drop-before', 'drop-after'));
  });
  t.addEventListener('dragover', (e) => {
    if (!S.dragIds) return;
    e.preventDefault();
    const r = t.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    $$('#thumbs .thumb').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
    t.classList.add(after ? 'drop-after' : 'drop-before');
  });
  t.addEventListener('drop', (e) => {
    if (!S.dragIds) return;
    e.preventDefault();
    e.stopPropagation();
    const after = t.classList.contains('drop-after');
    movePages(S.dragIds, t.dataset.id, after);
  });
}

// ---------------------------------------------------------------- page operations
function targetPages() {
  if (S.selPages.size) return S.pages.filter((p) => S.selPages.has(p.id));
  return S.current ? [getPage(S.current)] : [];
}
function movePages(ids, targetId, after) {
  if (ids.includes(targetId)) return;
  checkpoint();
  const moving = S.pages.filter((p) => ids.includes(p.id));
  const rest = S.pages.filter((p) => !ids.includes(p.id));
  let i = rest.findIndex((p) => p.id === targetId);
  if (after) i++;
  rest.splice(i, 0, ...moving);
  S.pages = rest;
  rebuild();
}
function rotatePages(dir) {
  const list = targetPages();
  if (!list.length) return;
  checkpoint();
  for (const pg of list) {
    const W = pg.W, H = pg.H;
    // Rotate the marks with the page so they stay over the same content.
    const tp = dir > 0 ? ([x, y]) => [n2(H - y), n2(x)] : ([x, y]) => [n2(y), n2(W - x)];
    for (const a of pg.annots) {
      if (a.points) a.points = a.points.map(tp);
      else if ('x1' in a) { [a.x1, a.y1] = tp([a.x1, a.y1]); [a.x2, a.y2] = tp([a.x2, a.y2]); }
      else if (a.type === 'text' || a.type === 'image') {
        const [cx, cy] = tp([a.x + a.w / 2, a.y + a.h / 2]);
        a.x = n2(cx - a.w / 2); a.y = n2(cy - a.h / 2);
      } else {
        const [x1, y1] = tp([a.x, a.y]), [x2, y2] = tp([a.x + a.w, a.y + a.h]);
        a.x = Math.min(x1, x2); a.y = Math.min(y1, y2); a.w = Math.abs(x2 - x1); a.h = Math.abs(y2 - y1);
      }
    }
    pg.rot = (pg.rot + (dir > 0 ? 90 : 270)) % 360;
    pg.W = H; pg.H = W;
  }
  S.hits = S.hits.filter((h) => !list.includes(getPage(h.pid)));
  rebuild();
}
async function deletePages() {
  const list = targetPages();
  if (!list.length) return;
  if (list.length === S.pages.length && !(await confirmBox('Delete every page?', 'This leaves the document empty. You can undo with Ctrl+Z.', 'Delete all'))) return;
  checkpoint();
  const ids = new Set(list.map((p) => p.id));
  const firstIdx = pageIndex(list[0].id);
  S.pages = S.pages.filter((p) => !ids.has(p.id));
  S.selPages.clear();
  if (S.sel && ids.has(S.sel.pid)) S.sel = null;
  S.hits = S.hits.filter((h) => !ids.has(h.pid));
  S.current = S.pages[Math.min(firstIdx, S.pages.length - 1)]?.id || null;
  rebuild();
  renderInspector();
  renderHitList();
  toast(`Deleted ${list.length} page${list.length > 1 ? 's' : ''}`);
}
function duplicatePages() {
  const list = targetPages();
  if (!list.length) return;
  checkpoint();
  const last = pageIndex(list[list.length - 1].id);
  const copies = list.map((p) => ({ ...clone(p), id: uid(), annots: p.annots.map((a) => ({ ...clone(a), id: uid() })) }));
  S.pages.splice(last + 1, 0, ...copies);
  rebuild();
}
const blankCache = new Map();
async function insertBlank() {
  const ref = getPage(S.current) || { W: 612, H: 792 };
  const key = `${Math.round(ref.W)}x${Math.round(ref.H)}`;
  let srcId = blankCache.get(key);
  let pg;
  if (!srcId) {
    const d = await PDFDocument.create();
    d.addPage([ref.W, ref.H]);
    [pg] = await addSource(await d.save(), 'Blank page');
    blankCache.set(key, pg.src);
  } else {
    pg = { id: uid(), src: srcId, idx: 0, base: 0, rot: 0, W: ref.W, H: ref.H, annots: [] };
  }
  checkpoint();
  const at = S.current ? pageIndex(S.current) + 1 : S.pages.length;
  S.pages.splice(at, 0, pg);
  rebuild();
  scrollToPage(pg.id, true);
}

// ---------------------------------------------------------------- search
const textCache = new Map(); // `${srcId}:${ver}:${idx}` -> items
async function pageText(pg) {
  const src = S.sources.get(pg.src);
  const k = `${src.id}:${src.ver}:${pg.idx}`;
  if (!textCache.has(k)) {
    const page = await src.doc.getPage(pg.idx + 1);
    const tc = await page.getTextContent();
    textCache.set(k, tc.items.filter((it) => it.str).map((it) => ({ ...it, family: tc.styles[it.fontName]?.fontFamily || 'sans-serif' })));
  }
  return textCache.get(k);
}
let searchSeq = 0;
async function runSearch() {
  const q = $('#searchInput').value;
  const mc = $('#searchCase').checked;
  const seq = ++searchSeq;
  const touched = new Set(S.hits.map((h) => h.pid));
  if (q.trim().length < 2) {
    S.hits = [];
    touched.forEach((pid) => drawAnnots(getPage(pid)));
    renderHitList(q.trim() ? 'Type at least two characters.' : 'Type to search every page.');
    return;
  }
  const needle = mc ? q : q.toLowerCase();
  const hits = [];
  for (const pg of S.pages) {
    const items = await pageText(pg);
    if (seq !== searchSeq) return;
    const src = S.sources.get(pg.src);
    const page = await src.doc.getPage(pg.idx + 1);
    const vp = page.getViewport({ scale: 1, rotation: (pg.base + pg.rot) % 360 });
    for (const it of items) {
      const hay = mc ? it.str : it.str.toLowerCase();
      let from = 0, i;
      while ((i = hay.indexOf(needle, from)) !== -1) {
        from = i + needle.length;
        const [a, b, c, d, e, f] = it.transform;
        const lenA = Math.hypot(a, b) || 1, fh = Math.hypot(c, d) || lenA;
        const ux = a / lenA, uy = b / lenA, vx = -uy, vy = ux;
        // Position within the run by measured glyph widths (proportional fonts), scaled to the run's real width.
        measureCtx.font = `100px ${it.family}`;
        const full = measureCtx.measureText(it.str).width || 1;
        const s0 = (it.width * measureCtx.measureText(it.str.slice(0, i)).width) / full;
        const s1 = (it.width * measureCtx.measureText(it.str.slice(0, i + needle.length)).width) / full;
        const corners = [[s0, -0.22 * fh], [s1, -0.22 * fh], [s0, 0.95 * fh], [s1, 0.95 * fh]]
          .map(([s, t]) => vp.convertToViewportPoint(e + ux * s + vx * t, f + uy * s + vy * t));
        const xs = corners.map((p) => p[0]), ys = corners.map((p) => p[1]);
        const rect = { x: n2(Math.min(...xs)), y: n2(Math.min(...ys)), w: n2(Math.max(...xs) - Math.min(...xs)), h: n2(Math.max(...ys) - Math.min(...ys)) };
        const ctx0 = Math.max(0, i - 28);
        hits.push({ pid: pg.id, rects: [rect], before: it.str.slice(ctx0, i), match: it.str.slice(i, i + needle.length), after: it.str.slice(i + needle.length, i + needle.length + 40), lead: ctx0 > 0 });
      }
    }
  }
  if (seq !== searchSeq) return;
  S.hits = hits;
  hits.forEach((h) => touched.add(h.pid));
  touched.forEach((pid) => { const p = getPage(pid); if (p) drawAnnots(p); });
  renderHitList();
}
function renderHitList(msg) {
  const list = $('#hitList');
  list.innerHTML = '';
  $('#searchActions').hidden = !S.hits.length;
  if (msg) { $('#searchMeta').textContent = msg; return; }
  const pagesHit = new Set(S.hits.map((h) => h.pid)).size;
  $('#searchMeta').textContent = S.hits.length
    ? `${S.hits.length} match${S.hits.length > 1 ? 'es' : ''} on ${pagesHit} page${pagesHit > 1 ? 's' : ''}`
    : ($('#searchInput').value.trim().length >= 2 ? 'No matches. Scanned pages have no text layer to search.' : 'Type to search every page.');
  S.hits.slice(0, 500).forEach((h) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="pg">p.${pageIndex(h.pid) + 1}</span><span class="ctx">${h.lead ? '…' : ''}${esc(h.before)}<mark>${esc(h.match)}</mark>${esc(h.after)}</span>`;
    li.onclick = () => {
      const el = wraps.get(h.pid);
      const r = h.rects[0];
      $('#viewer').scrollTo({ top: el.offsetTop + r.y * S.zoom - $('#viewer').clientHeight / 3, behavior: 'smooth' });
      S.current = h.pid; updateStatus();
    };
    list.appendChild(li);
  });
}
function clearSearch() {
  const touched = new Set(S.hits.map((h) => h.pid));
  S.hits = [];
  touched.forEach((pid) => { const p = getPage(pid); if (p) drawAnnots(p); });
  $('#searchInput').value = '';
  renderHitList();
}
function hitsToAnnots(type) {
  if (!S.hits.length) return;
  checkpoint();
  for (const h of S.hits) {
    const pg = getPage(h.pid);
    for (const r of h.rects) {
      // Redactions get a margin so glyph edges never survive; review the boxes before saving.
      const px = type === 'redact' ? Math.max(1.5, r.h * 0.18) : 0, py = type === 'redact' ? 1 : 0;
      pg.annots.push({ id: uid(), type, ...(type === 'highlight' ? { color: S.style.highlight.color } : {}), x: n2(r.x - px), y: n2(r.y - py), w: n2(r.w + px * 2), h: n2(r.h + py * 2) });
    }
  }
  const n = S.hits.length;
  clearSearch();
  S.pages.forEach(drawAnnots);
  toast(type === 'redact' ? `Marked ${n} match${n > 1 ? 'es' : ''} for redaction. Check each box covers the text, then save.` : `Highlighted ${n} match${n > 1 ? 'es' : ''}`);
}

// ---------------------------------------------------------------- forms
function renderForms() {
  const body = $('#formsBody');
  body.innerHTML = '';
  const used = new Set(S.pages.map((p) => p.src));
  const srcs = [...S.sources.values()].filter((s) => s.fields.length && used.has(s.id));
  const total = srcs.reduce((n, s) => n + s.fields.length, 0);
  $('#formCount').hidden = !total;
  $('#formCount').textContent = total;
  if (!srcs.length) {
    body.innerHTML = '<p class="note">This document has no fillable form fields. To fill a flat form, use the Text tool to type on top of it.</p>';
    return;
  }
  body.insertAdjacentHTML('beforeend', '<p class="note">Values are written into the PDF. On save, fields are flattened so they print and display the same everywhere.</p>');
  for (const src of srcs) {
    const g = document.createElement('div');
    g.className = 'form-group';
    g.innerHTML = `<h3>${esc(src.name)}</h3>`;
    src.fields.forEach((f, fi) => {
      const val = f.name in src.formValues ? src.formValues[f.name] : f.value;
      const id = `ff-${src.id}-${fi}`;
      const row = document.createElement('label');
      row.className = f.kind === 'check' ? 'check' : 'form-field';
      if (f.kind === 'text') {
        row.innerHTML = `<span>${esc(f.name)}</span>` + (f.multi
          ? `<textarea class="form-input" id="${id}">${esc(val)}</textarea>`
          : `<input class="form-input" type="text" id="${id}" value="${esc(val)}">`);
      } else if (f.kind === 'check') {
        row.innerHTML = `<input type="checkbox" id="${id}" ${val ? 'checked' : ''}> ${esc(f.name)}`;
      } else {
        row.innerHTML = `<span>${esc(f.name)}</span><select class="form-input" id="${id}"><option value=""></option>${f.options.map((o) => `<option ${o === val ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
      }
      const input = row.querySelector('input, textarea, select');
      input.addEventListener(f.kind === 'text' ? 'input' : 'change', () => {
        src.formValues[f.name] = f.kind === 'check' ? input.checked : input.value;
        setDirty(true);
        scheduleFormApply(src);
      });
      g.appendChild(row);
    });
    body.appendChild(g);
  }
}
const formTimers = new Map();
function scheduleFormApply(src) {
  clearTimeout(formTimers.get(src.id));
  formTimers.set(src.id, setTimeout(() => applyForm(src).catch((e) => toast('Could not update the form: ' + e.message, true)), 450));
}
async function fillForm(lib, values) {
  const form = lib.getForm();
  for (const [name, v] of Object.entries(values)) {
    try {
      const f = form.getField(name);
      if (f instanceof PDFLib.PDFTextField) f.setText(v || undefined);
      else if (f instanceof PDFLib.PDFCheckBox) v ? f.check() : f.uncheck();
      else if (f instanceof PDFLib.PDFRadioGroup) { if (v) f.select(v); else f.clear(); }
      else if (f instanceof PDFLib.PDFDropdown || f instanceof PDFLib.PDFOptionList) { if (v) f.select(v); else f.clear(); }
    } catch (e) { console.warn('field', name, e); }
  }
  return form;
}
async function applyForm(src) {
  const lib = await PDFDocument.load(src.orig, { ignoreEncryption: true, updateMetadata: false });
  await fillForm(lib, src.formValues);
  src.bytes = await lib.save();
  const old = src.doc;
  src.doc = await loadPdfjs(src.bytes);
  src.ver++;
  old.destroy();
  invalidateSource(src.id);
}

// ---------------------------------------------------------------- signatures
const SIG_INKS = ['#1d2b6b', '#161a20', '#1f5fd6'];
const sig = { mode: 'draw', kind: 'sign', ink: SIG_INKS[0], strokes: [], saved: [], store: { sign: [], initials: [] } };
for (const k of ['sign', 'initials']) {
  try { sig.store[k] = JSON.parse(localStorage.getItem(k === 'sign' ? 'folio.signatures' : 'folio.initials') || '[]'); } catch { sig.store[k] = []; }
}
sig.saved = sig.store.sign;
function persistSigs() {
  sig.store[sig.kind] = sig.saved;
  try { localStorage.setItem(sig.kind === 'sign' ? 'folio.signatures' : 'folio.initials', JSON.stringify(sig.saved.slice(0, 6))); } catch { /* storage unavailable */ }
}

function openSignature(kind = 'sign') {
  const d = $('#sigDlg');
  sig.kind = kind;
  sig.saved = sig.store[kind];
  $('#sigTitle').textContent = kind === 'initials' ? 'Initials' : 'Signature';
  $('#sigText').placeholder = kind === 'initials' ? 'Type your initials' : 'Type your name';
  $('#sigUse').textContent = kind === 'initials' ? 'Place initials' : 'Place signature';
  sig.strokes = [];
  drawSigPad();
  $('#sigText').value = '';
  updateSigPreview();
  setSigMode(sig.mode);
  renderSigColors();
  renderSavedSigs();
  d.showModal();
}
function setSigMode(m) {
  sig.mode = m;
  $$('#sigMode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
  $('#sigDrawWrap').hidden = m !== 'draw';
  $('#sigTypeWrap').hidden = m !== 'type';
  if (m === 'type') setTimeout(() => $('#sigText').focus(), 0);
}
function renderSigColors() {
  const w = $('#sigColors');
  w.innerHTML = '<span class="label">Ink</span>';
  SIG_INKS.forEach((c) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'sw'; b.style.background = c;
    b.setAttribute('aria-pressed', String(c === sig.ink));
    b.onclick = () => { sig.ink = c; renderSigColors(); drawSigPad(); updateSigPreview(); };
    w.appendChild(b);
  });
}
function renderSavedSigs() {
  const w = $('#sigSaved');
  w.innerHTML = '';
  if (!sig.saved.length) return;
  w.insertAdjacentHTML('beforeend', '<span class="label" style="align-self:center">Recent</span>');
  sig.saved.forEach((s, i) => {
    const b = document.createElement('div');
    b.className = 'sig-chip';
    b.innerHTML = `<img src="${s.data}" alt="Saved signature"><button type="button" class="x" title="Forget">×</button>`;
    b.onclick = (e) => {
      if (e.target.classList.contains('x')) { sig.saved.splice(i, 1); persistSigs(); renderSavedSigs(); return; }
      $('#sigDlg').close();
      beginPlace({ data: s.data, aspect: s.aspect, width: sig.kind === 'initials' ? 60 : 170 }, sig.kind);
    };
    w.appendChild(b);
  });
}
function drawSigPad() {
  const c = $('#sigCanvas'), ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.strokeStyle = sig.ink; ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const s of sig.strokes) {
    ctx.beginPath();
    s.forEach(([x, y], i) => {
      if (i === 0) ctx.moveTo(x, y);
      else {
        const [px, py] = s[i - 1];
        ctx.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
      }
    });
    if (s.length === 1) ctx.lineTo(s[0][0] + 0.1, s[0][1]);
    ctx.stroke();
  }
}
(() => {
  const c = $('#sigCanvas');
  let cur = null;
  const pt = (e) => { const r = c.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * c.width, ((e.clientY - r.top) / r.height) * c.height]; };
  c.addEventListener('pointerdown', (e) => { c.setPointerCapture(e.pointerId); cur = [pt(e)]; sig.strokes.push(cur); drawSigPad(); });
  c.addEventListener('pointermove', (e) => { if (cur) { cur.push(pt(e)); drawSigPad(); } });
  const end = () => { cur = null; };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
})();
const SIG_FONT = '"Segoe Script", "Ink Free", "Brush Script MT", cursive';
function updateSigPreview() {
  const p = $('#sigPreview');
  p.textContent = $('#sigText').value || (sig.kind === 'initials' ? 'AB' : 'Your name');
  p.style.color = $('#sigText').value ? sig.ink : '#b9bec6';
}
function trimCanvas(src) {
  const ctx = src.getContext('2d');
  const { width: w, height: h } = src;
  const d = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (d[(y * w + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  const pad = 6;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(src, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}
function useSignature() {
  let canvas;
  if (sig.mode === 'draw') {
    if (!sig.strokes.length) { toast('Draw your signature first', true); return; }
    canvas = $('#sigCanvas');
  } else {
    const txt = $('#sigText').value.trim();
    if (!txt) { toast('Type your name first', true); return; }
    canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = `120px ${SIG_FONT}`;
    canvas.width = Math.ceil(ctx.measureText(txt).width + 60); canvas.height = 220;
    ctx.font = `120px ${SIG_FONT}`; ctx.fillStyle = sig.ink; ctx.textBaseline = 'middle';
    ctx.fillText(txt, 30, 110);
  }
  const t = trimCanvas(canvas);
  if (!t) return;
  const data = t.toDataURL('image/png');
  const entry = { data, aspect: t.width / t.height };
  sig.saved = [entry, ...sig.saved.filter((s) => s.data !== data)].slice(0, 6);
  persistSigs();
  $('#sigDlg').close();
  beginPlace({ ...entry, width: sig.kind === 'initials' ? 60 : 170 }, sig.kind);
}
$$('#sigMode button').forEach((b) => b.addEventListener('click', () => setSigMode(b.dataset.mode)));
$('#sigText').addEventListener('input', updateSigPreview);
$('#sigText').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); useSignature(); } });
$('#sigClear').onclick = () => { sig.strokes = []; drawSigPad(); $('#sigText').value = ''; updateSigPreview(); };
$('#sigCancel').onclick = () => $('#sigDlg').close();
$('#sigUse').onclick = useSignature;
$('#sigDlg').addEventListener('keydown', (e) => e.stopPropagation());

// ---------------------------------------------------------------- export
const hexRgb = (h) => { const v = parseInt(h.slice(1), 16); return rgb(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255); };
const mul = (A, B) => [
  A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1],
  A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
  A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5],
];
const inv = ([a, b, c, d, e, f]) => { const k = a * d - b * c; return [d / k, -b / k, -c / k, a / k, (c * f - d * e) / k, (b * e - a * f) / k]; };

async function exportPdf(pageList) {
  const out = await PDFDocument.create();
  out.setProducer('Folio');
  out.setCreator('Folio');
  const font = await out.embedFont(StandardFonts.Helvetica);
  if (typeof fontkit !== 'undefined') out.registerFontkit(fontkit);
  const fontCache = new Map();
  // Matching TrueType font from Windows when available; standard Helvetica otherwise.
  const textFont = async (a) => {
    const key = `${a.font}|${!!a.bold}|${!!a.italic}`;
    if (!fontCache.has(key)) fontCache.set(key, (Folio.fonts && await Folio.fonts.embed(out, a)) || null);
    return fontCache.get(key) || font;
  };
  let fallback;
  // Draw one line, switching to a symbol font for characters the main font doesn't have.
  const drawLine = async (page, text, x, y, size, f, color, extra = {}) => {
    if (fallback === undefined) fallback = Folio.fonts ? await Folio.fonts.embedFallback(out) : null;
    const parts = Folio.fonts ? Folio.fonts.runs(text, f, fallback) : [{ text, font: f }];
    for (const part of parts) {
      const t = safe(part.font, part.text);
      page.drawText(t, { x, y, size, font: part.font, color, ...extra });
      x += part.font.widthOfTextAtSize(t, size);
    }
  };
  // Standard (non-embedded) fonts only cover WinAnsi; swap anything else for '?'. Embedded fonts pass through.
  const encodable = new Map();
  const safe = (f, s) => [...s].map((ch) => {
    const k = f.name + ch;
    if (!encodable.has(k)) { try { f.encodeText(ch); encodable.set(k, true); } catch { encodable.set(k, false); } }
    return encodable.get(k) ? ch : '?';
  }).join('');
  const clean = (s) => safe(font, s);

  // Source bytes, with any form values filled in and flattened.
  const libs = new Map();
  for (const id of new Set(pageList.map((p) => p.src))) {
    const src = S.sources.get(id);
    let lib = await PDFDocument.load(src.bytes, { ignoreEncryption: true, updateMetadata: false });
    if (src.fields.length) {
      try {
        await fillForm(lib, src.formValues);
        lib.getForm().flatten();
      } catch (e) {
        console.warn('flatten failed', e);
        lib = await PDFDocument.load(src.bytes, { ignoreEncryption: true, updateMetadata: false });
      }
    }
    libs.set(id, lib);
  }
  const flatDocs = new Map();
  const imgCache = new Map();
  const embedImage = async (dataUrl) => {
    if (!imgCache.has(dataUrl)) {
      const bytes = new Uint8Array(await (await fetch(dataUrl)).arrayBuffer());
      imgCache.set(dataUrl, dataUrl.startsWith('data:image/png') ? await out.embedPng(bytes) : await out.embedJpg(bytes));
    }
    return imgCache.get(dataUrl);
  };

  const layout = [];
  const ctxBase = { out, font, textFont, safe, drawLine, embedImage, hexRgb, total: pageList.length };
  let n = 0;
  for (const pg of pageList) {
    busy(`Building page ${++n} of ${pageList.length}…`);
    const src = S.sources.get(pg.src);
    const total = (pg.base + pg.rot) % 360;
    const redactions = pg.annots.filter((a) => a.type === 'redact');
    let page, ctm;

    if (redactions.length) {
      // Burn in: rasterize the page with the boxes painted in, so nothing underneath survives.
      if (!flatDocs.has(pg.src)) flatDocs.set(pg.src, await loadPdfjs(await libs.get(pg.src).save()));
      const flatDoc = flatDocs.get(pg.src);
      const p = await flatDoc.getPage(pg.idx + 1);
      const scale = 200 / 72;
      const vp = p.getViewport({ scale, rotation: total });
      const c = document.createElement('canvas');
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      // 'print' intent: matches printed output and isn't throttled when the window is minimized.
      await p.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
      ctx.fillStyle = '#000';
      for (const a of redactions) ctx.fillRect(a.x * scale, a.y * scale, a.w * scale, a.h * scale);
      const jpg = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9))).arrayBuffer());
      const img = await out.embedJpg(jpg);
      page = out.addPage([pg.W, pg.H]);
      page.drawImage(img, { x: 0, y: 0, width: pg.W, height: pg.H });
      ctm = [1, 0, 0, 1, 0, 0];
    } else {
      const [cp] = await out.copyPages(libs.get(pg.src), [pg.idx]);
      page = out.addPage(cp);
      page.setRotation(degrees(total));
      const p = await src.doc.getPage(pg.idx + 1);
      const vp = p.getViewport({ scale: 1, rotation: total });
      // Map our top-left, y-down page frame (flipped to y-up for pdf-lib) into PDF user space.
      ctm = mul(inv(vp.transform), [1, 0, 0, -1, 0, pg.H]);
    }

    layout.push({ pid: pg.id, index: n - 1, ctm, W: pg.W, H: pg.H });
    const marks = pg.annots.filter((a) => a.type !== 'redact');
    if (!marks.length && !Folio.exportPage.length) continue;
    const H = pg.H;
    const ctx = { ...ctxBase, pg, index: n - 1, W: pg.W, H, ctm };
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...ctm));
    for (const a of marks) {
      switch (a.type) {
        case 'rect':
          page.drawRectangle({ x: a.x, y: H - a.y - a.h, width: a.w, height: a.h, borderColor: hexRgb(a.color), borderWidth: a.width });
          break;
        case 'highlight':
          page.drawRectangle({ x: a.x, y: H - a.y - a.h, width: a.w, height: a.h, color: hexRgb(a.color), opacity: 0.5, blendMode: BlendMode.Multiply });
          break;
        case 'whiteout':
          page.drawRectangle({ x: a.x, y: H - a.y - a.h, width: a.w, height: a.h, color: rgb(1, 1, 1) });
          break;
        case 'ellipse':
          page.drawEllipse({ x: a.x + a.w / 2, y: H - a.y - a.h / 2, xScale: a.w / 2, yScale: a.h / 2, borderColor: hexRgb(a.color), borderWidth: a.width });
          break;
        case 'line': case 'arrow': case 'ink':
          page.drawSvgPath(pathD(a), { x: 0, y: H, borderColor: hexRgb(a.color), borderWidth: a.width, borderLineCap: LineCapStyle.Round });
          break;
        case 'text': {
          if (a.cover) page.drawRectangle({ x: a.cover.x, y: H - a.cover.y - a.cover.h, width: a.cover.w, height: a.cover.h, color: rgb(1, 1, 1) });
          const f = await textFont(a);
          const lines = textLines(a);
          for (let i = 0; i < lines.length; i++) {
            if (lines[i]) await drawLine(page, lines[i], lineX(a, lines[i]), H - (a.y + a.size * TEXT_ASC + i * a.size * lh(a)), a.size, f, hexRgb(a.color));
          }
          break;
        }
        case 'image':
          page.drawImage(await embedImage(a.data), { x: a.x, y: H - a.y - a.h, width: a.w, height: a.h });
          break;
        case 'mark':
          if (a.kind === 'dot') page.drawCircle({ x: a.x + a.w / 2, y: H - a.y - a.h / 2, size: (a.w * 5) / 24, color: hexRgb(a.color) });
          else page.drawSvgPath(MARK_PATHS[a.kind], { x: a.x, y: H - a.y, scale: a.w / 24, borderColor: hexRgb(a.color), borderWidth: 2.6, borderLineCap: LineCapStyle.Round });
          break;
        default:
          await Folio.annotTypes[a.type]?.export?.(page, a, ctx);
      }
    }
    for (const f of Folio.exportPage) await f(page, pg, ctx);
    page.pushOperators(popGraphicsState());
  }
  flatDocs.forEach((doc) => doc.destroy());
  for (const f of Folio.afterExport) await f(out, layout, pageList);
  exportPdf.layout = layout;
  return out.save();
}

async function save(pages, name) {
  if (!pages.length) { toast('There are no pages to save', true); return; }
  if (S.editing) commitEdit();
  if (Folio.beforeSave && !(await Folio.beforeSave(pages))) return;
  try {
    const bytes = await exportPdf(pages);
    busy(null);
    if (native) {
      const r = await native.saveDialog(name, bytes, S.docDir);
      if (!r) return;
      if (pages === S.pages) { setDirty(false); S.docName = r.name; S.docDir = r.path.replace(/[\\/][^\\/]*$/, ''); setDirty(false); }
      toast(`Saved ${r.name}`);
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      if (pages === S.pages) setDirty(false);
      toast(`Downloaded ${name}`);
    }
  } catch (e) {
    console.error(e);
    toast('Save failed: ' + (e.message || e), true);
  } finally { busy(null); }
}
const baseName = () => S.docName.replace(/\.pdf$/i, '');

// ---------------------------------------------------------------- wiring
hydrateIcons();
$$('#modes [role="tab"]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
$('#btnOpen').onclick = () => pickFiles('replace');
$('#emptyOpen').onclick = () => pickFiles('replace');
$('#btnAdd').onclick = () => pickFiles('add');
$('#fileOpen').onchange = async (e) => { ingest(await filesFromInput(e.target.files), 'replace'); e.target.value = ''; };
$('#fileAdd').onchange = async (e) => { ingest(await filesFromInput(e.target.files), 'add'); e.target.value = ''; };
$('#btnSave').onclick = () => save(S.pages, S.dirty || !/-edited$/.test(baseName()) ? `${baseName().replace(/-edited$/, '')}-edited.pdf` : S.docName);
$('#btnUndo').onclick = undo;
$('#btnRedo').onclick = redo;
$('#zoomIn').onclick = () => zoomStep(1);
$('#zoomOut').onclick = () => zoomStep(-1);
$('#zoomSel').onchange = (e) => setZoom(e.target.value === 'fit' ? 'fit' : +e.target.value);
$('#pgRotL').onclick = () => rotatePages(-1);
$('#pgRotR').onclick = () => rotatePages(1);
$('#pgDel').onclick = deletePages;
$('#pgDup').onclick = duplicatePages;
$('#pgBlank').onclick = insertBlank;
$('#pgExtract').onclick = () => {
  const list = targetPages();
  const nums = list.map((p) => pageIndex(p.id) + 1);
  const label = nums.length === 1 ? `p${nums[0]}` : `p${nums[0]}-${nums[nums.length - 1]}`;
  save(list, `${baseName()}-${label}.pdf`);
};
$('#btnTheme').onclick = () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('folio.theme', root.dataset.theme); } catch { /* ignore */ }
};
try { const th = localStorage.getItem('folio.theme'); if (th) document.documentElement.dataset.theme = th; } catch { /* ignore */ }

let searchTimer;
$('#searchInput').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 220); });
$('#searchInput').addEventListener('keydown', (e) => { if (e.key === 'Escape') { clearSearch(); e.target.blur(); } e.stopPropagation(); });
$('#searchCase').addEventListener('change', runSearch);
$('#hitHighlight').onclick = () => hitsToAnnots('highlight');
$('#hitRedact').onclick = () => hitsToAnnots('redact');

$('#viewer').addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setZoom(S.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
}, { passive: false });
window.addEventListener('resize', () => { if (S.fit) setZoom('fit'); });

// drag & drop files from Explorer
let dragDepth = 0;
const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (isFileDrag(e)) { dragDepth++; $('#dropVeil').hidden = false; } });
window.addEventListener('dragleave', (e) => { if (isFileDrag(e) && --dragDepth <= 0) { dragDepth = 0; $('#dropVeil').hidden = true; } });
window.addEventListener('dragover', (e) => { if (isFileDrag(e)) e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth = 0; $('#dropVeil').hidden = true;
  const files = await filesFromInput(e.dataTransfer.files);
  ingest(files, S.pages.length ? 'add' : 'replace');
});

document.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || $('dialog[open]')) return;
  const k = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  if (Folio.onKey?.(e, k, mod)) return;
  if (mod) {
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
    else if (k === 's') { e.preventDefault(); $('#btnSave').click(); }
    else if (k === 'o') { e.preventDefault(); pickFiles(e.shiftKey ? 'add' : 'replace'); }
    else if (k === 'f') { e.preventDefault(); showTab('search'); $('#searchInput').focus(); $('#searchInput').select(); }
    else if (k === '=' || k === '+') { e.preventDefault(); zoomStep(1); }
    else if (k === '-') { e.preventDefault(); zoomStep(-1); }
    else if (k === '0') { e.preventDefault(); setZoom('fit'); }
    else if (k === 'd') { e.preventDefault(); duplicateSelected(); }
    return;
  }
  if (e.target.closest?.('#thumbs') && (k === 'delete' || k === 'backspace')) { e.preventDefault(); deletePages(); return; }
  if ((k === 'delete' || k === 'backspace') && S.sel) { e.preventDefault(); deleteSelected(); return; }
  if (k === 'escape') { if (S.sel) select(null); else setTool('select'); return; }
  if (S.sel && k.startsWith('arrow')) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const a = getAnnot(S.sel.pid, S.sel.aid);
    checkpoint();
    nudge(a, k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0, k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0);
    drawAnnots(getPage(S.sel.pid));
    return;
  }
  const map = { v: 'select', t: 'text', h: 'highlight', d: 'ink', a: 'arrow', l: 'line', r: 'rect', e: 'ellipse', w: 'whiteout', x: 'redact', s: 'sign', i: 'image' };
  if (map[k]) { e.preventDefault(); setTool(map[k]); }
  else if (k === 'pagedown' || k === 'pageup') {
    const i = pageIndex(S.current) + (k === 'pagedown' ? 1 : -1);
    if (S.pages[i]) { e.preventDefault(); scrollToPage(S.pages[i].id); }
  }
});

// ---------------------------------------------------------------- sample document
async function makeSample() {
  const d = await PDFDocument.create();
  d.setTitle('Folio sample');
  const font = await d.embedFont(StandardFonts.Helvetica);
  const bold = await d.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.09, 0.1, 0.13), grey = rgb(0.38, 0.41, 0.46), teal = rgb(0.04, 0.43, 0.42);
  const annots = [[], [], []];

  // Page 1 — orientation
  let p = d.addPage([612, 792]);
  p.drawRectangle({ x: 0, y: 752, width: 612, height: 40, color: teal });
  p.drawText('SAMPLE DOCUMENT', { x: 60, y: 767, size: 10, font: bold, color: rgb(1, 1, 1) });
  p.drawText('Welcome to Folio', { x: 60, y: 690, size: 30, font: bold, color: ink });
  p.drawText('Open your own PDF with Ctrl+O, or drop files anywhere in the window.', { x: 60, y: 662, size: 12, font, color: grey });
  const tips = [
    ['Highlight (H)', 'drag across any line of text.'],
    ['Text (T)', 'click anywhere to type; double-click text to edit it.'],
    ['Draw, Arrow, Box, Ellipse', 'mark up drawings and photos.'],
    ['Signature (S)', 'draw or type it once, then click to place it.'],
    ['Redact (X)', 'boxes are burned in on save. Text underneath is removed.'],
    ['Pages panel', 'drag thumbnails to reorder; rotate, duplicate, extract, delete.'],
    ['Search (Ctrl+F)', 'find text, then highlight or redact every match at once.'],
    ['Forms', 'fill the fields below from the Forms tab.'],
  ];
  let y = 600;
  for (const [h, t] of tips) {
    p.drawText(h, { x: 60, y, size: 12, font: bold, color: ink });
    const hw = bold.widthOfTextAtSize(h, 12);
    p.drawText(' — ' + t, { x: 60 + hw, y, size: 12, font, color: ink });
    if (h.startsWith('Redact')) annots[0].push({ id: uid(), type: 'highlight', color: '#ffd400', x: 57, y: n2(792 - y - 11.5), w: n2(hw + font.widthOfTextAtSize(' — ' + t, 12) + 6), h: 16 });
    y -= 28;
  }
  p.drawLine({ start: { x: 60, y: 342 }, end: { x: 552, y: 342 }, thickness: 0.6, color: rgb(0.8, 0.82, 0.85) });
  p.drawText('Sample form', { x: 60, y: 314, size: 14, font: bold, color: ink });
  const form = d.getForm();
  p.drawText('Reviewer', { x: 60, y: 284, size: 10, font, color: grey });
  const f1 = form.createTextField('Reviewer'); f1.addToPage(p, { x: 60, y: 254, width: 240, height: 24, font, borderColor: rgb(0.7, 0.72, 0.76) });
  p.drawText('Date', { x: 320, y: 284, size: 10, font, color: grey });
  const f2 = form.createTextField('Date'); f2.addToPage(p, { x: 320, y: 254, width: 140, height: 24, font, borderColor: rgb(0.7, 0.72, 0.76) });
  const cb = form.createCheckBox('Approved'); cb.addToPage(p, { x: 60, y: 214, width: 16, height: 16, borderColor: rgb(0.7, 0.72, 0.76) });
  p.drawText('Approved', { x: 84, y: 218, size: 11, font, color: ink });
  p.drawText('Signature', { x: 60, y: 160, size: 10, font, color: grey });
  p.drawLine({ start: { x: 60, y: 120 }, end: { x: 300, y: 120 }, thickness: 0.8, color: ink });
  annots[0].push({ id: uid(), type: 'text', color: '#d92f2f', size: 13, x: 316, y: 656, text: '← Press S to sign here' });

  // Page 2 — searchable text
  p = d.addPage([612, 792]);
  p.drawText('Sample text', { x: 60, y: 720, size: 20, font: bold, color: ink });
  p.drawText('Use this page to try search, highlight and redaction.', { x: 60, y: 696, size: 11, font, color: grey });
  const para = [
    'The Portable Document Format was designed so that a document looks the same on every screen and printer. Each page is a fixed canvas of text, vector graphics and images, which is why PDF became the standard for contracts, reports and records that must not change shape when they are shared.',
    'Because PDF keeps text as real characters, it can be searched and copied. That is also why covering text with a white or black box is not a redaction: the characters are still in the file. Folio removes them by flattening any page that carries a redaction mark when you save.',
    'Reference number SAMPLE-0042 appears twice on this page so you can try Redact all. Search for SAMPLE-0042, press Redact all, save, and then try to find it in the saved copy.',
    'Contact: records desk, reference SAMPLE-0042, extension 1234.',
  ];
  y = 650;
  for (const txt of para) {
    const words = txt.split(' ');
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (font.widthOfTextAtSize(test, 11.5) > 492) { p.drawText(line, { x: 60, y, size: 11.5, font, color: ink }); y -= 17; line = w; }
      else line = test;
    }
    p.drawText(line, { x: 60, y, size: 11.5, font, color: ink });
    y -= 30;
  }
  annots[1].push({ id: uid(), type: 'text', color: '#1f5fd6', size: 12, x: 60, y: n2(792 - y + 10), text: 'Notes like this one are added with the Text tool (T).' });

  // Page 3 — a simple drawing to mark up
  p = d.addPage([792, 612]);
  p.drawText('Sample drawing', { x: 60, y: 560, size: 20, font: bold, color: ink });
  p.drawText('Mark up this plan with arrows, boxes and freehand drawing.', { x: 60, y: 536, size: 11, font, color: grey });
  const wall = { thickness: 3, color: ink };
  p.drawRectangle({ x: 80, y: 90, width: 630, height: 400, borderColor: ink, borderWidth: 3 });
  p.drawLine({ start: { x: 380, y: 90 }, end: { x: 380, y: 400 }, ...wall });
  p.drawLine({ start: { x: 80, y: 290 }, end: { x: 300, y: 290 }, ...wall });
  p.drawLine({ start: { x: 380, y: 260 }, end: { x: 710, y: 260 }, ...wall });
  for (const [t, x, yy] of [['Room A', 190, 390], ['Room B', 190, 185], ['Room C', 520, 380], ['Room D', 520, 170]]) {
    p.drawText(t, { x: x - font.widthOfTextAtSize(t, 12) / 2, y: yy, size: 12, font, color: grey });
  }
  annots[2].push({ id: uid(), type: 'ellipse', color: '#d92f2f', width: 2, x: 440, y: 250, w: 170, h: 90 });

  return { bytes: await d.save(), annots };
}

// ---------------------------------------------------------------- boot
// Runs after every feature module has loaded and registered with Folio.
window.addEventListener('DOMContentLoaded', () => boot().catch((e) => { console.error(e); toast('Folio failed to start: ' + e.message, true); }));
async function boot() {
  let mode = 'comment';
  try { mode = localStorage.getItem('folio.mode') || mode; } catch { /* ignore */ }
  setMode(MODES[mode] ? mode : 'comment');
  await Folio.fonts?.init();
  setTool('select');
  syncHistoryButtons();
  renderHitList();
  native?.onOpenFiles((files) => ingest(files, S.pages.length ? 'add' : 'replace'));
  const pending = native ? await native.takePending() : [];
  if (pending.length) {
    await ingest(pending, 'replace');
  } else {
    const { bytes, annots } = await makeSample();
    const pages = await addSource(bytes, 'Folio sample.pdf');
    pages.forEach((pg, i) => { pg.annots = annots[i] || []; pg.annots.filter((a) => a.type === 'text').forEach(measureText); });
    S.pages = pages;
    S.docName = 'Folio sample.pdf';
    rebuild();
    renderForms();
    setDirty(false);
    Folio.onIngest.forEach((f) => f(pages));
  }
  setZoom('fit');
  renderInspector();
}
