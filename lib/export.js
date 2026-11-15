// Folio — PDF -> Word / Excel / PowerPoint writers. Platform-neutral: used by the desktop main process and
// bundled for iOS/Android (scripts/build-mobile.js). Each returns the file as a Uint8Array.
'use strict';

function fromBase64(b64) {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

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
          children: [new D.ImageRun({ type: 'png', data: Uint8Array.from(b.png), transformation: { width: Math.round((b.w * 96) / 72), height: Math.round((b.h * 96) / 72) } })],
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
  // toBase64String works in Node and in browsers alike (toBuffer is Node-only)
  return fromBase64(await D.Packer.toBase64String(doc));
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
  return new Uint8Array(await wb.xlsx.writeBuffer());
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
  return new Uint8Array(await p.write({ outputType: 'uint8array' }));
}

async function exportDoc(kind, model) {
  if (kind === 'docx') return toDocx(model);
  if (kind === 'xlsx') return toXlsx(model);
  if (kind === 'pptx') return toPptx(model);
  throw new Error('Unknown format ' + kind);
}

module.exports = { exportDoc };
