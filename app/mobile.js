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

  function pick({ images = false } = {}) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = images ? IMAGE_ACCEPT : OPEN_ACCEPT;
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

  const unavailable = (what) => ({ error: `${what} isn't available in Folio for mobile yet.` });
  const openListeners = [];

  window.folio = {
    platform: Cap.getPlatform(), // 'ios' | 'android'
    takePending: async () => [],
    openDialog: (opts) => pick(opts),
    async saveDialog(name, data) {
      const ok = await shareFiles([{ name, base64: toBase64(data) }], 'Save PDF');
      return ok ? { name, path: name } : null;
    },
    showInFolder: () => {},
    setDirty: () => {},
    setTitle: () => {},
    onOpenFiles: (cb) => openListeners.push(cb),
    // Installed fonts can't be read on mobile; the UI falls back to the PDF standard fonts.
    fontList: async () => [],
    fontRead: async () => { throw new Error('font not available'); },
    // Digital IDs: not yet (needs the signing code bundled for the browser and keychain storage).
    idList: async () => [],
    idCreate: async () => unavailable('Creating a digital ID'),
    idImport: async () => unavailable('Importing a digital ID'),
    idRemove: async () => {},
    signPdf: async () => unavailable('Certificate signing'),
    verifyPdf: async () => [],
    converterInfo: async () => ({ word: false, excel: false, powerpoint: false, libreoffice: null, mobile: true }),
    officeToPdf: async () => unavailable('Converting Office files'),
    htmlToPdf: async () => unavailable('Converting web pages'),
    exportDoc: async () => unavailable('Exporting to Word, Excel or PowerPoint'),
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
  document.documentElement.classList.add('mobile', `mobile-${Cap.getPlatform()}`);
  document.addEventListener('DOMContentLoaded', () => {
    const off = document.querySelector('.offline');
    if (off) {
      off.title = 'Folio has no network access. Your files never leave this device unless you share them.';
      off.lastChild.textContent = 'Offline · files stay on this device';
    }
  });
})();
