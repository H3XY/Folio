// Feeds export models captured from the UI into the real writers, then reads the files back.
const fs = require('fs'), path = require('path');
const Module = require('module');
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'electron' ? { BrowserWindow: class {} } : origLoad.call(this, req, ...rest); };
const { exportDoc } = require('../lib/convert');
const JSZip = require('jszip');
const ExcelJS = require('exceljs');
const dir = path.join(__dirname, '..', '.dump');
const load = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'), (k, v) => (v && v.__u8 ? Uint8Array.from(Buffer.from(v.__u8, 'base64')) : v));
(async () => {
  const docx = await exportDoc('docx', load('word.json'));
  fs.writeFileSync(path.join(dir, 'out.docx'), docx);
  const zx = await JSZip.loadAsync(docx);
  const xml = await zx.file('word/document.xml').async('string');
  console.log('docx', docx.length, 'bytes; sections:', (xml.match(/<w:sectPr/g) || []).length, 'tables:', (xml.match(/<w:tbl>/g) || []).length,
    'images:', Object.keys(zx.files).filter((f) => f.startsWith('word/media/')).length,
    'bold runs:', (xml.match(/<w:b\/>/g) || []).length, 'has "CASE"/"Invoice":', xml.includes('Invoice 2026-114'), 'fonts:', [...new Set([...xml.matchAll(/w:ascii="([^"]+)"/g)].map((m) => m[1]))].join(','));
  const xlsx = await exportDoc('xlsx', load('excel.json'));
  fs.writeFileSync(path.join(dir, 'out.xlsx'), xlsx);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(xlsx);
  const ws = wb.worksheets[1];
  const vals = [];
  ws.eachRow((r) => vals.push(r.values.slice(1)));
  console.log('xlsx sheets:', wb.worksheets.map((w) => w.name).join(', '));
  console.log('invoice rows:', JSON.stringify(vals.slice(2, 8)));
  const sum = vals.slice(3, 7).reduce((s, r) => s + (typeof r[3] === 'number' ? r[3] : 0), 0);
  console.log('amounts are numbers, sum =', sum);
  const pptx = await exportDoc('pptx', load('ppt.json'));
  fs.writeFileSync(path.join(dir, 'out.pptx'), pptx);
  const zp = await JSZip.loadAsync(pptx);
  const slides = Object.keys(zp.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
  const s2 = await zp.file('ppt/slides/slide2.xml').async('string');
  console.log('pptx slides:', slides.length, 'slide2 text boxes:', (s2.match(/<p:sp>/g) || []).length, 'has invoice text:', s2.includes('Invoice 2026-114'), 'bg image:', s2.includes('<p:pic>'));
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
