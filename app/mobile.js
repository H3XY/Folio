/* Folio — mobile bridge (iOS / iPadOS / Android via Capacitor).
   Provides the same window.folio API the Electron preload exposes, so the rest of the UI is unchanged.
   Files are picked with the system document picker and saved through the share sheet ("Save to Files",
   Drive, AirDrop...). Nothing leaves the device unless the user picks a destination in that sheet.
   Loaded before app.js; does nothing outside a Capacitor native shell. */
'use strict';

(() => {
  const Cap = window.Capacitor;
  if (!Cap?.isNativePlatform?.() || window.folio) return;
  const Filesystem = Cap.registerPlugin('Filesystem');
  const Share = Cap.registerPlugin('Share');
  const App = Cap.registerPlugin('App');

  function fromBase64(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // A file handed to Folio by the system ("Open in Folio", Files, Drive, Mail...). iOS gives a file:// URL
  // to a copy in the app's Inbox; Android gives a content:// URI, which usually has no readable file name.
  async function readOpenedUrl(url) {
    if (!url || !/^(file|content):/i.test(url)) return null;
    const { data } = await Filesystem.readFile({ path: url });
    const last = decodeURIComponent(url.split(/[/?#]/).filter(Boolean).pop() || '');
    const name = /\.pdf$/i.test(last) ? last : 'Document.pdf';
    return { name, path: null, data: typeof data === 'string' ? fromBase64(data) : new Uint8Array(await data.arrayBuffer()) };
  }

  const OPEN_ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.gif,.html,.htm,.txt,application/pdf,image/*';
  const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

  function toBase64(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const safeName = (n) => String(n).replace(/[\\/:*?"<>|]/g, '_') || 'document';

  // Write files to the cache, then hand them to the share sheet. Resolves false if the user dismisses it.
  async function shareFiles(files, title) {
    const dir = `export-${Date.now()}`;
    const uris = [];
    for (const f of files) {
      const r = await Filesystem.writeFile({ path: `${dir}/${safeName(f.name)}`, data: f.base64, directory: 'CACHE', recursive: true });
      uris.push(r.uri);
    }
    try {
      await Share.share({ title, files: uris });
      return true;
    } catch (e) {
      if (/cancel/i.test(e?.message || e)) return false;
      throw e;
    } finally {
      Filesystem.rmdir({ path: dir, directory: 'CACHE', recursive: true }).catch(() => {});
    }
  }

  function pick({ images = false, accept = null, multiple = true } = {}) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = multiple;
      input.accept = accept || (images ? IMAGE_ACCEPT : OPEN_ACCEPT);
      input.style.display = 'none';
      const done = async () => {
        input.remove();
        resolve(await Promise.all([...(input.files || [])].map(async (f) => ({ name: f.name, path: null, data: new Uint8Array(await f.arrayBuffer()) }))));
      };
      input.addEventListener('change', done, { once: true });
      input.addEventListener('cancel', () => { input.remove(); resolve([]); }, { once: true });
      document.body.appendChild(input);
      input.click();
    });
  }

  let metricMapP = null;
  const metricMap = () => (metricMapP ||= fetch('vendor/fonts/metric/map.json').then((r) => r.json()).catch(() => ({})));

  // Export and signing code is bundled separately (scripts/build-mobile.js) and loaded the first time it's needed.
  const loaded = {};
  const loadScript = (src) => (loaded[src] ||= new Promise((ok, bad) => {
    const el = document.createElement('script');
    el.src = src; el.onload = ok; el.onerror = () => { delete loaded[src]; bad(new Error(`Could not load ${src}`)); };
    document.head.appendChild(el);
  }));
  const safe = (fn) => async (...args) => { try { return await fn(...args); } catch (e) { return { error: e.message || String(e) }; } };

  // Digital IDs live in the app's private storage as password-protected .p12 files plus JSON metadata.
  const ID_DIR = 'digital-ids';
  let signStore = null;
  async function ids() {
    if (signStore) return signStore;
    await loadScript('vendor/folio-sign.js');
    const fs = { directory: 'DATA' };
    signStore = window.FolioSign.createStore({
      async list() {
        let files = [];
        try { files = (await Filesystem.readdir({ ...fs, path: ID_DIR })).files; } catch { return []; }
        const metas = await Promise.all(files.map((f) => f.name || f).filter((n) => n.endsWith('.json')).map(async (n) => {
          try { return JSON.parse((await Filesystem.readFile({ ...fs, path: `${ID_DIR}/${n}`, encoding: 'utf8' })).data); } catch { return null; }
        }));
        return metas;
      },
      async read(id) {
        try { return fromBase64((await Filesystem.readFile({ ...fs, path: `${ID_DIR}/${id}.p12` })).data); } catch { return null; }
      },
      async write(id, p12, meta) {
        await Filesystem.writeFile({ ...fs, path: `${ID_DIR}/${id}.p12`, data: toBase64(p12), recursive: true });
        await Filesystem.writeFile({ ...fs, path: `${ID_DIR}/${id}.json`, data: JSON.stringify(meta), encoding: 'utf8', recursive: true });
      },
      async remove(id) {
        for (const ext of ['p12', 'json']) await Filesystem.deleteFile({ ...fs, path: `${ID_DIR}/${id}.${ext}` }).catch(() => {});
      },
    });
    return signStore;
  }

  const OFFICE_NAMES = { docx: 'Word document', xlsx: 'Excel workbook', pptx: 'PowerPoint presentation' };

  const unavailable = (what) => ({ error: `${what} isn't available in Folio for mobile yet.` });
  const openListeners = [];

  window.folio = {
    platform: Cap.getPlatform(), // 'ios' | 'android'
    // The file Folio was launched with, if any.
    async takePending() {
      try {
        const launch = await App.getLaunchUrl();
        const f = await readOpenedUrl(launch?.url);
        return f ? [f] : [];
      } catch (e) { console.warn('launch file', e); return []; }
    },
    openDialog: (opts) => pick(opts),
    async saveDialog(name, data) {
      const ok = await shareFiles([{ name, base64: toBase64(data) }], 'Save PDF');
      return ok ? { name, path: name } : null;
    },
    showInFolder: () => {},
    setDirty: () => {},
    setTitle: () => {},
    onOpenFiles: (cb) => openListeners.push(cb),
    // System fonts can't be read on mobile, so Folio ships metric-compatible stand-ins (Arimo for Arial,
    // Tinos for Times New Roman, Cousine for Courier New, Carlito for Calibri). Other families fall back to
    // the PDF standard fonts.
    async fontList(names) {
      const map = await metricMap();
      return (names || []).filter((n) => map[String(n).toLowerCase()]);
    },
    async fontRead(name) {
      const file = (await metricMap())[String(name).toLowerCase()];
      if (!file) throw new Error('font not available');
      return new Uint8Array(await (await fetch(`vendor/fonts/metric/${file}`)).arrayBuffer());
    },
    // Digital IDs and certificate signatures (same code as desktop, see lib/signing-core.js)
    idList: async () => { try { return await (await ids()).list(); } catch (e) { console.warn('ids', e); return []; } },
    idCreate: safe(async (info) => (await ids()).create(info)),
    idImport: safe(async (password) => {
      const [file] = await pick({ accept: '.p12,.pfx,application/x-pkcs12', multiple: false });
      if (!file) return null;
      return (await ids()).importFile(file.data, password);
    }),
    idRemove: async (id) => (await ids()).remove(id),
    signPdf: safe(async (req) => ({ data: new Uint8Array(await (await ids()).sign(req)) })),
    async verifyPdf(data) {
      try { await loadScript('vendor/folio-sign.js'); return window.FolioSign.verifyPdf(data); } catch (e) { console.warn('verify', e); return []; }
    },
    converterInfo: async () => ({ word: false, excel: false, powerpoint: false, libreoffice: null, mobile: true }),
    officeToPdf: async () => unavailable('Converting Office files'),
    htmlToPdf: async () => unavailable('Converting web pages'),
    // PDF -> Word / Excel / PowerPoint (same writers as desktop, see lib/export.js)
    exportDoc: safe(async (kind, model, name) => {
      await loadScript('vendor/folio-export.js');
      const bytes = await window.FolioExport.exportDoc(kind, model);
      const ok = await shareFiles([{ name, base64: toBase64(bytes) }], `Export ${OFFICE_NAMES[kind] || kind}`);
      return ok ? { name, path: null } : null;
    }),
    async saveText(text, name) {
      const ok = await shareFiles([{ name, base64: toBase64(new TextEncoder().encode('﻿' + text)) }], 'Export text');
      return ok ? { name, path: null } : null;
    },
    async saveImages(images, base) {
      const width = Math.max(3, String(images.length).length);
      const files = images.map((im, i) => ({
        name: `${safeName(base)}_${String(i + 1).padStart(width, '0')}.${im.ext === 'png' ? 'png' : 'jpg'}`,
        base64: toBase64(im.data),
      }));
      const ok = await shareFiles(files, 'Save images');
      return ok ? { path: null, count: images.length } : null;
    },
  };
  // Files opened while Folio is already running.
  App.addListener('appUrlOpen', async ({ url }) => {
    try {
      const f = await readOpenedUrl(url);
      if (f) openListeners.forEach((cb) => cb([f]));
    } catch (e) { console.warn('open file', e); }
  });

  document.documentElement.classList.add('mobile', `mobile-${Cap.getPlatform()}`);
  // Dialogs open without popping up the keyboard (browsers focus the first field on showModal).
  const showModal = HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal = function () {
    showModal.call(this);
    const el = document.activeElement;
    if (el && this.contains(el) && el.matches('input:not([type]), input[type="text"], input[type="password"], input[type="number"], textarea')) el.blur();
  };
  // Pinch zooms the document (app.js), not the whole interface.
  document.querySelector('meta[name="viewport"]')?.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');
  document.addEventListener('DOMContentLoaded', () => {
    const off = document.querySelector('.offline');
    if (off) {
      off.title = 'Folio has no network access. Your files never leave this device unless you share them.';
      off.lastChild.textContent = 'Offline · files stay on this device';
    }
  });
})();
