// Folio — IPC for fonts, digital IDs/signatures and conversions.
const { app, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const signing = require('./signing');
const convert = require('./convert');

module.exports = function registerFeatureIpc({ getWin }) {
  // Errors come back as { error } so the UI can show a readable message.
  const safe = (fn) => async (...args) => { try { return await fn(...args); } catch (e) { return { error: e.message }; } };

  // ---- fonts: read-only access to installed fonts, by plain file name
  const FONT_DIRS = [
    path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Fonts'),
  ];
  const fontPath = (name) => {
    if (typeof name !== 'string' || !/^[\w\- ]+\.(ttf|otf)$/i.test(name)) return null;
    for (const d of FONT_DIRS) { const p = path.join(d, name); if (fs.existsSync(p)) return p; }
    return null;
  };
  ipcMain.handle('font-list', (_e, names) => (Array.isArray(names) ? names.filter((n) => fontPath(n)) : []));
  ipcMain.handle('font-read', (_e, name) => {
    const p = fontPath(name);
    if (!p) throw new Error('font not found');
    return fs.readFileSync(p);
  });

  // ---- digital IDs and signatures (stored in the user's app data folder, password-protected .p12)
  let store = null;
  const ids = () => (store ||= signing.createStore(path.join(app.getPath('userData'), 'digital-ids')));
  ipcMain.handle('id-list', () => ids().list());
  ipcMain.handle('id-create', safe((_e, info) => ids().create(info)));
  ipcMain.handle('id-remove', (_e, id) => ids().remove(id));
  ipcMain.handle('id-import', safe(async (_e, password) => {
    const r = await dialog.showOpenDialog(getWin(), { title: 'Import digital ID', properties: ['openFile'], filters: [{ name: 'Digital ID', extensions: ['pfx', 'p12'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    return ids().importFile(fs.readFileSync(r.filePaths[0]), password);
  }));
  ipcMain.handle('sign-pdf', safe(async (_e, req) => ({ data: await ids().sign(req) })));
  ipcMain.handle('verify-pdf', (_e, data) => { try { return signing.verifyPdf(data); } catch { return []; } });

  // ---- conversions
  ipcMain.handle('converter-info', () => convert.converterInfo());
  ipcMain.handle('office-to-pdf', safe(async (_e, file) => ({ data: await convert.officeToPdf(file) })));
  ipcMain.handle('html-to-pdf', safe(async (_e, req) => ({ data: await convert.htmlToPdf(req) })));

  const saveAs = async (title, name, dir, filters) => {
    const r = await dialog.showSaveDialog(getWin(), { title, defaultPath: path.join(dir || app.getPath('documents'), name), filters });
    return r.canceled ? null : r.filePath;
  };
  const FILTERS = {
    docx: [{ name: 'Word document', extensions: ['docx'] }],
    xlsx: [{ name: 'Excel workbook', extensions: ['xlsx'] }],
    pptx: [{ name: 'PowerPoint presentation', extensions: ['pptx'] }],
  };
  ipcMain.handle('export-doc', safe(async (_e, { kind, model, name, dir }) => {
    const out = await saveAs('Export', name, dir, FILTERS[kind]);
    if (!out) return null;
    fs.writeFileSync(out, await convert.exportDoc(kind, model));
    return { path: out, name: path.basename(out) };
  }));
  ipcMain.handle('save-text', safe(async (_e, { text, name, dir }) => {
    const out = await saveAs('Export text', name, dir, [{ name: 'Text', extensions: ['txt'] }]);
    if (!out) return null;
    fs.writeFileSync(out, '\ufeff' + text, 'utf8');
    return { path: out, name: path.basename(out) };
  }));
  ipcMain.handle('save-images', safe(async (_e, { images, base, dir }) => {
    const r = await dialog.showOpenDialog(getWin(), {
      title: 'Choose a folder for the images', defaultPath: dir || app.getPath('pictures'), properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const folder = r.filePaths[0];
    const width = Math.max(3, String(images.length).length);
    const safeBase = String(base).replace(/[\\/:*?"<>|]/g, '_');
    images.forEach((im, i) => fs.writeFileSync(path.join(folder, `${safeBase}_${String(i + 1).padStart(width, '0')}.${im.ext === 'png' ? 'png' : 'jpg'}`), Buffer.from(im.data)));
    return { path: folder, count: images.length };
  }));
};
