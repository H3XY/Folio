// Folio — conversions that need the main process: Office/HTML -> PDF, and PDF -> Word/Excel/PowerPoint files.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { BrowserWindow } = require('electron');

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { windowsHide: true, timeout: 180000, maxBuffer: 1 << 24, ...opts }, (err, stdout, stderr) => {
    if (err) reject(Object.assign(err, { stdout, stderr })); else resolve({ stdout, stderr });
  });
});

// ---------------------------------------------------------------- what's installed
let info = null;
async function converterInfo() {
  if (info) return info;
  // Microsoft Office is driven over COM, which only exists on Windows; elsewhere only LibreOffice is used.
  const has = async (key) => {
    if (process.platform !== 'win32') return false;
    try { await run('reg', ['query', `HKCR\\${key}\\CLSID`]); return true; } catch { return false; }
  };
  const lo = [
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe', 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice', '/usr/bin/soffice', '/usr/local/bin/soffice',
  ].find((p) => fs.existsSync(p)) || null;
  info = { word: await has('Word.Application'), excel: await has('Excel.Application'), powerpoint: await has('PowerPoint.Application'), libreoffice: lo };
  return info;
}

const OFFICE_KIND = (ext) => (/^(docx?|docm|rtf|odt|wpd)$/.test(ext) ? 'word' : /^(xlsx?|xlsm|xlsb|csv|ods)$/.test(ext) ? 'excel' : /^(pptx?|pptm|ppsx?|odp)$/.test(ext) ? 'powerpoint' : null);

// Paths travel through environment variables, never through the script text.
const PS = {
  word: `$ErrorActionPreference='Stop'; $a=New-Object -ComObject Word.Application; $a.Visible=$false; $a.DisplayAlerts=0;
    try { $d=$a.Documents.Open($env:FOLIO_IN,$false,$true,$false); $d.ExportAsFixedFormat($env:FOLIO_OUT,17); $d.Close(0) } finally { $a.Quit() }`,
  excel: `$ErrorActionPreference='Stop'; $a=New-Object -ComObject Excel.Application; $a.Visible=$false; $a.DisplayAlerts=$false;
    try { $w=$a.Workbooks.Open($env:FOLIO_IN,0,$true); $w.ExportAsFixedFormat(0,$env:FOLIO_OUT); $w.Close($false) } finally { $a.Quit() }`,
  powerpoint: `$ErrorActionPreference='Stop'; $a=New-Object -ComObject PowerPoint.Application;
    try { $p=$a.Presentations.Open($env:FOLIO_IN,-1,0,0); $p.SaveAs($env:FOLIO_OUT,32); $p.Close() } finally { $a.Quit() }`,
};

async function officeToPdf({ name, path: srcPath, data }) {
  const ext = path.extname(name).slice(1).toLowerCase();
  const kind = OFFICE_KIND(ext);
  if (!kind) throw new Error(`Folio can't convert .${ext} files.`);
  const avail = await converterInfo();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-conv-'));
  try {
    const inPath = path.join(tmp, `input.${ext}`);
    fs.writeFileSync(inPath, Buffer.from(data));
    const outPath = path.join(tmp, 'output.pdf');
    if (avail[kind]) {
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS[kind]],
        { env: { ...process.env, FOLIO_IN: inPath, FOLIO_OUT: outPath } });
    } else if (avail.libreoffice) {
      await run(avail.libreoffice, ['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', tmp, inPath]);
      fs.renameSync(path.join(tmp, 'input.pdf'), outPath);
    } else {
      const app = { word: 'Microsoft Word', excel: 'Microsoft Excel', powerpoint: 'Microsoft PowerPoint' }[kind];
      throw new Error(process.platform === 'win32'
        ? `Converting ${name} needs ${app} or LibreOffice installed on this PC.`
        : `Converting ${name} needs LibreOffice installed on this Mac.`);
    }
    return fs.readFileSync(outPath);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// HTML (or text wrapped as HTML) -> PDF with Chromium's print engine. Runs offline: the session blocks the network.
async function htmlToPdf({ html, filePath }) {
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, offscreen: true } });
  try {
    if (filePath) await win.loadFile(filePath);
    else await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    return await win.webContents.printToPDF({
      pageSize: 'Letter', printBackground: true,
      margins: { marginType: 'custom', top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
    });
  } finally {
    win.destroy();
  }
}

// ---------------------------------------------------------------- PDF -> Office
// The exporters are platform-neutral (lib/export.js) so the mobile build can bundle them too.
const { exportDoc: exportBytes } = require('./export');
const exportDoc = async (kind, model) => Buffer.from(await exportBytes(kind, model));

module.exports = { converterInfo, officeToPdf, htmlToPdf, exportDoc, OFFICE_KIND };
