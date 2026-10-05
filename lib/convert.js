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
  const has = async (key) => { try { await run('reg', ['query', `HKCR\\${key}\\CLSID`]); return true; } catch { return false; } };
  const lo = ['C:\\Program Files\\LibreOffice\\program\\soffice.exe', 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'].find((p) => fs.existsSync(p)) || null;
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
      throw new Error(`Converting ${name} needs ${app} or LibreOffice installed on this PC.`);
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
async function toDocx(model) {
  const D = require('docx');
  const TW = (pt) => Math.round(pt * 20); // twentieths of a point
  const sections = model.pages.map((pg) => {
    const children = [];
    for (const b of pg.blocks) {
      if (b.type === 'table') {
        if (b.spaceBefore > 1) children.push(new D.Paragraph({ spacing: { before: 0, after: 0, line: TW(b.spaceBefore), lineRule: 'exact' }, children: [] }));
        const none = { style: D.BorderStyle.NONE, size: 0, color: 'FFFFFF' };
        const borders = { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none };
        children.push(new D.Table({
          columnWidths: b.widths.map(TW),
          indent: { size: TW(Math.max(0, b.x - pg.margin.left)), type: D.WidthType.DXA },
          borders,
          rows: b.rows.map((row) => new D.TableRow({
            height: { value: TW(b.rowHeight), rule: 'atLeast' },
            children: row.map((c, i) => new D.TableCell({
              width: { size: TW(b.widths[i]), type: D.WidthType.DXA },
              margins: { top: 0, bottom: 0, left: 0, right: TW(4) },
              borders: { top: none, bottom: none, left: none, right: none },
              children: [new D.Paragraph({ spacing: { before: 0, after: 0 }, children: [new D.TextRun({ text: c.text, bold: c.bold, italics: c.italic, font: c.font, size: Math.round(c.size * 2) })] })],
            })),
          })),
        }));
        continue;
      }
      if (b.type === 'image') {
        children.push(new D.Paragraph({
          indent: { left: TW(Math.max(0, b.x - pg.margin.left)) },
          spacing: { before: TW(b.spaceBefore || 0), after: 0 },
          children: [new D.ImageRun({ type: 'png', data: Buffer.from(b.png), transformation: { width: Math.round((b.w * 96) / 72), height: Math.round((b.h * 96) / 72) } })],
        }));
        continue;
      }
      const runs = b.runs.map((r) => new D.TextRun({
        text: r.text, bold: r.bold, italics: r.italic, size: Math.round(r.size * 2), font: r.font,
        color: (r.color || '#000000').replace('#', ''),
      }));
      children.push(new D.Paragraph({
        children: runs,
        alignment: b.align === 'center' ? D.AlignmentType.CENTER : b.align === 'right' ? D.AlignmentType.RIGHT : b.align === 'justify' ? D.AlignmentType.JUSTIFIED : D.AlignmentType.LEFT,
        indent: { left: TW(Math.max(0, b.x - pg.margin.left)) },
        spacing: { before: TW(Math.max(0, b.spaceBefore || 0)), after: 0, line: Math.round((b.lineHeight || 1.15) * 240), lineRule: 'auto' },
        heading: b.heading ? D.HeadingLevel[`HEADING_${b.heading}`] : undefined,
      }));
    }
    if (!children.length) children.push(new D.Paragraph(''));
    return {
      properties: {
        page: {
          size: { width: TW(pg.w), height: TW(pg.h) },
          margin: { top: TW(pg.margin.top), bottom: TW(pg.margin.bottom), left: TW(pg.margin.left), right: TW(pg.margin.right) },
        },
      },
      children,
    };
  });
  const doc = new D.Document({ creator: 'Folio', title: model.title || '', sections });
  return D.Packer.toBuffer(doc);
}

async function toXlsx(model) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Folio';
  for (const sh of model.sheets) {
    const ws = wb.addWorksheet(sh.name.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '));
    for (const row of sh.rows) {
      ws.addRow(row.map((v) => {
        const t = String(v).trim();
        const numLike = /^[-+(]?[$€£]?\s?\d{1,3}(,\d{3})*(\.\d+)?\)?%?$|^[-+]?\d+(\.\d+)?$/.test(t);
        if (!numLike) return v;
        const neg = /^\(.*\)$/.test(t) || t.startsWith('-');
        let n = parseFloat(t.replace(/[^\d.]/g, ''));
        if (Number.isNaN(n)) return v;
        if (t.endsWith('%')) n /= 100;
        return neg ? -n : n;
      }));
    }
    ws.columns.forEach((col) => {
      let max = 6;
      col.eachCell?.({ includeEmpty: false }, (c) => { max = Math.max(max, String(c.value ?? '').length + 2); });
      col.width = Math.min(60, max);
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function toPptx(model) {
  const PptxGenJS = require('pptxgenjs');
  const p = new PptxGenJS();
  const first = model.slides[0] || { w: 10, h: 7.5 };
  p.defineLayout({ name: 'FOLIO', width: first.w, height: first.h });
  p.layout = 'FOLIO';
  for (const s of model.slides) {
    const slide = p.addSlide();
    // page artwork without its text, then the text as editable boxes on top
    slide.addImage({ data: s.bg, x: 0, y: 0, w: first.w, h: first.h });
    for (const t of s.texts) {
      slide.addText(t.text, {
        x: t.x, y: t.y, w: t.w, h: t.h, fontSize: t.size, bold: t.bold, italic: t.italic, fontFace: t.font,
        color: (t.color || '#000000').replace('#', ''), margin: 0, valign: 'top', fit: 'none', paraSpaceAfter: 0, lineSpacingMultiple: t.lineHeight || 1,
      });
    }
  }
  return p.write({ outputType: 'nodebuffer' });
}

async function exportDoc(kind, model) {
  if (kind === 'docx') return toDocx(model);
  if (kind === 'xlsx') return toXlsx(model);
  if (kind === 'pptx') return toPptx(model);
  throw new Error('Unknown format ' + kind);
}

module.exports = { converterInfo, officeToPdf, htmlToPdf, exportDoc, OFFICE_KIND };
