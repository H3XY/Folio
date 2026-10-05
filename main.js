// Folio — offline PDF editor (Electron main process)
const { app, BrowserWindow, ipcMain, dialog, protocol, session, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const registerFeatureIpc = require('./lib/ipc');

const APP_DIR = path.join(__dirname, 'app');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.ttf': 'font/ttf', '.pfb': 'application/octet-stream', '.bcmap': 'application/octet-stream',
  '.wasm': 'application/wasm', '.gz': 'application/gzip', '.traineddata': 'application/octet-stream',
};
const OPENABLE = /\.(pdf|png|jpe?g|webp|gif|docx?|rtf|odt|xlsx?|csv|ods|pptx?|odp|html?|txt)$/i;

// Serve the UI from app:// so the pdf.js worker is same-origin and nothing touches file:// or the web.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let win = null;
let dirty = false;
let pendingPaths = pdfArgs(process.argv);

function pdfArgs(argv) {
  return argv.slice(1).filter((a) => OPENABLE.test(a) && fs.existsSync(a));
}

function readFiles(paths) {
  return paths.map((p) => ({ name: path.basename(p), path: p, data: fs.readFileSync(p) }));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const paths = pdfArgs(argv);
    if (paths.length) win.webContents.send('open-files', readFiles(paths));
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 720,
    minHeight: 480,
    title: 'Folio',
    backgroundColor: '#1a1d21',
    icon: path.join(APP_DIR, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  win.loadURL('app://folio/index.html');

  // Never navigate away or open new windows from inside the app.
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://')) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('close', (e) => {
    if (!dirty) return;
    const r = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Discard changes', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Unsaved changes',
      message: 'You have unsaved changes.',
      detail: 'Close Folio and discard them?',
    });
    if (r === 1) e.preventDefault();
  });
  win.on('closed', () => { win = null; });

  // Smoke test: FOLIO_SELFTEST=<dir> writes a screenshot and console log, then quits.
  const testDir = process.env.FOLIO_SELFTEST;
  if (testDir) {
    const logFile = path.join(testDir, 'folio-selftest.log');
    fs.writeFileSync(logFile, 'start\n');
    const log = { push: (s) => fs.appendFileSync(logFile, s + '\n') };
    win.webContents.on('console-message', (e) => log.push(`[${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`));
    setTimeout(() => { log.push('selftest timeout'); app.exit(1); }, +process.env.FOLIO_SELFTEST_TIMEOUT || 20000);
    session.defaultSession.webRequest.onCompleted((d) => log.push(`req ${d.statusCode} ${d.url}`));
    session.defaultSession.webRequest.onErrorOccurred((d) => log.push(`req-err ${d.error} ${d.url}`));
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      log.push('globals: ' + await win.webContents.executeJavaScript('JSON.stringify({pdfjs: typeof pdfjsLib, pdflib: typeof PDFLib, pages: typeof S === "object" ? S.pages.length : -1})'));
      // optional scripted checks (dev only): FOLIO_SELFTEST_JS=<file> is evaluated in the page; its result is logged
      if (process.env.FOLIO_SELFTEST_JS) {
        try {
          const code = fs.readFileSync(process.env.FOLIO_SELFTEST_JS, 'utf8');
          log.push('script: ' + JSON.stringify(await win.webContents.executeJavaScript(`(async () => { ${code} })()`), null, 1));
        } catch (e) { log.push('script error: ' + e.message); }
      }
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(testDir, 'folio-selftest.png'), img.toPNG());
      log.push('title: ' + win.getTitle());
      dirty = false;
      app.quit();
    }, 4000));
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);

  protocol.handle('app', async (req) => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(APP_DIR, decodeURIComponent(pathname)));
    if (!file.startsWith(APP_DIR + path.sep)) return new Response('Forbidden', { status: 403 });
    try {
      const body = await fs.promises.readFile(file);
      return new Response(body, { headers: { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  // Offline by design: block every request that is not the app itself or in-memory data.
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    const ok = /^(app|data|blob|devtools|chrome-extension|file):/.test(details.url);
    cb({ cancel: !ok });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  createWindow();
});

app.on('window-all-closed', () => app.quit());

// ---- IPC ----
ipcMain.handle('take-pending', () => {
  const files = readFiles(pendingPaths);
  pendingPaths = [];
  return files;
});

ipcMain.handle('open-dialog', async (_e, opts = {}) => {
  const r = await dialog.showOpenDialog(win, {
    title: opts.title || 'Open',
    properties: ['openFile', 'multiSelections'],
    filters: opts.images
      ? [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
      : [
          { name: 'All supported files', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'doc', 'docx', 'rtf', 'odt', 'xls', 'xlsx', 'csv', 'ods', 'ppt', 'pptx', 'odp', 'html', 'htm', 'txt'] },
          { name: 'PDF', extensions: ['pdf'] },
          { name: 'Office documents', extensions: ['doc', 'docx', 'rtf', 'odt', 'xls', 'xlsx', 'csv', 'ods', 'ppt', 'pptx', 'odp'] },
          { name: 'Web pages and text', extensions: ['html', 'htm', 'txt'] },
          { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
          { name: 'All files', extensions: ['*'] },
        ],
  });
  return r.canceled ? [] : readFiles(r.filePaths);
});

ipcMain.handle('save-dialog', async (_e, { name, data, dir }) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Save PDF',
    defaultPath: path.join(dir || app.getPath('documents'), name),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, Buffer.from(data));
  return { path: r.filePath, name: path.basename(r.filePath) };
});

ipcMain.on('set-dirty', (_e, v) => { dirty = !!v; });
ipcMain.on('set-title', (_e, t) => { if (win) win.setTitle(t); });
ipcMain.handle('show-in-folder', (_e, p) => shell.showItemInFolder(p));
registerFeatureIpc({ getWin: () => win });
