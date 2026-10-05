/* Folio — Convert: export to Word / Excel / PowerPoint / images / text, create PDFs from other files,
   recognize text in scans (OCR, fully offline), and compress. Exports work from the document exactly as it
   would be saved, so edits, comments, stamps and OCR text are included. */
'use strict';

(() => {
  const { PDFDocument, PDFName, PDFRawStream, PDFArray, PDFNumber } = PDFLib;

  Object.assign(TOOL_BUTTONS, {
    toword: { icon: 'toword', label: 'Word', title: 'Export to Microsoft Word (.docx)', action: () => exportDialog('docx') },
    toexcel: { icon: 'toexcel', label: 'Excel', title: 'Export tables to Microsoft Excel (.xlsx)', action: () => exportDialog('xlsx') },
    toppt: { icon: 'toppt', label: 'PowerPoint', title: 'Export to Microsoft PowerPoint (.pptx)', action: () => exportDialog('pptx') },
    toimage: { icon: 'toimage', label: 'Image', title: 'Export pages as PNG or JPEG images', action: () => exportDialog('image') },
    totext: { icon: 'totext', label: 'Text', title: 'Export plain text (.txt)', action: () => exportDialog('text') },
    create: { icon: 'create', label: 'Create PDF', title: 'Create a PDF from Office files, web pages, text or images', action: () => createDialog() },
    ocr: { icon: 'ocr', label: 'Recognize text', title: 'Make scanned pages searchable and editable (OCR)', action: () => ocrDialog() },
    compress: { icon: 'compress', label: 'Compress', title: 'Reduce file size', action: () => compressDialog() },
  });

  // ------------------------------------------------------------ helpers
  function parseRange(str, total) {
    const s = (str || '').trim();
    if (!s || /^all$/i.test(s)) return [...Array(total).keys()];
    const out = new Set();
    for (const part of s.split(',')) {
      const m = part.trim().match(/^(\d+)\s*(?:-\s*(\d+))?$/);
      if (!m) throw new Error(`“${part.trim()}” is not a page or range like 2-5`);
      const a = +m[1], b = m[2] ? +m[2] : a;
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= total) out.add(i - 1);
    }
    if (!out.size) throw new Error('No pages in that range');
    return [...out].sort((p, q) => p - q);
  }
  const rangeField = (id = 'cvRange') => `<label class="form-field"><span>Pages</span><input class="form-input" type="text" id="${id}" placeholder="All pages, or e.g. 1-3, 7" spellcheck="false"></label>`;
  const canvasBytes = (c, type, q) => new Promise((res) => c.toBlob(async (b) => res(new Uint8Array(await b.arrayBuffer())), type, q));
  const fileBase = () => baseName().replace(/-(edited|signed)$/, '');

  async function savedDoc(indices) {
    const pages = indices.map((i) => S.pages[i]);
    const bytes = await exportPdf(pages);
    busy('Reading pages…');
    return loadPdfjs(bytes);
  }

  // Render without any text, for page artwork behind editable text (PowerPoint) and clean image crops (Word).
  async function renderNoText(page, scale) {
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillText = () => {}; ctx.strokeText = () => {};
    await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
    return c;
  }
  async function renderFull(page, scale) {
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
    return c;
  }

  // ------------------------------------------------------------ page structure
  async function pageStructure(page) {
    const vp = page.getViewport({ scale: 1 });
    const ops = await page.getOperatorList();
    const tc = await page.getTextContent();
    const fontName = (id) => { try { return page.commonObjs.get(id)?.name || ''; } catch { return ''; } };
    const styleCache = new Map();
    const styleOf = (id) => {
      if (!styleCache.has(id)) styleCache.set(id, Folio.fonts.match(fontName(id), tc.styles[id]?.fontFamily || ''));
      return styleCache.get(id);
    };
    const items = [];
    for (const it of tc.items) {
      if (!it.str) continue;
      const [a, b, c, d, e, f] = it.transform;
      const len = Math.hypot(a, b) || 1;
      const size = Math.hypot(c, d) || len;
      const [x0, y0] = vp.convertToViewportPoint(e, f);
      const [x1, y1] = vp.convertToViewportPoint(e + (a / len) * it.width, f + (b / len) * it.width);
      if (Math.abs(y1 - y0) > size * 0.3 || x1 < x0 - 0.5) continue;
      if (!it.str.trim()) continue; // pdf.js marks wide gaps with blank items; keep gaps as gaps so columns survive
      items.push({ str: it.str, x0, x1: Math.max(x1, x0 + 0.5), y: y0, size, style: styleOf(it.fontName) });
    }
    items.sort((p, q) => (Math.abs(p.y - q.y) < Math.min(p.size, q.size) * 0.4 ? p.x0 - q.x0 : p.y - q.y));

    // lines made of styled runs
    const lines = [];
    for (const it of items) {
      const ln = lines[lines.length - 1];
      const sameLine = ln && Math.abs(it.y - ln.y) < Math.min(it.size, ln.size) * 0.4 && it.x0 >= ln.x1 - it.size * 0.5;
      if (sameLine) {
        const gap = it.x0 - ln.x1;
        ln.gaps.push(gap);
        let text = it.str;
        if (gap > it.size * 0.15 && !/\s$/.test(ln.runs[ln.runs.length - 1].text) && !/^\s/.test(text)) text = ' ' + text;
        const last = ln.runs[ln.runs.length - 1];
        const st = it.style;
        if (last.font === st.font && last.bold === st.bold && last.italic === st.italic && Math.abs(last.size - it.size) < 0.6) last.text += text;
        else ln.runs.push({ text, ...st, size: n2(it.size) });
        ln.x1 = Math.max(ln.x1, it.x1);
        ln.size = Math.max(ln.size, it.size);
        ln.items.push(it);
      } else {
        lines.push({ y: it.y, x0: it.x0, x1: it.x1, size: it.size, runs: [{ text: it.str, ...it.style, size: n2(it.size) }], gaps: [], items: [it] });
      }
    }
    lines.forEach((l) => { l.text = l.runs.map((r) => r.text).join(''); });

    // images on the page, in display coordinates
    const OPS = pdfjsLib.OPS;
    const images = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i], args = ops.argsArray[i];
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      else if (fn === OPS.transform) ctm = CS.mul(ctm, args);
      else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageXObjectRepeat) {
        const M = CS.mul(vp.transform, ctm);
        const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => CS.apply(M, u, v));
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
        const r = { x: Math.max(0, Math.min(...xs)), y: Math.max(0, Math.min(...ys)) };
        r.w = Math.min(vp.width, Math.max(...xs)) - r.x; r.h = Math.min(vp.height, Math.max(...ys)) - r.y;
        if (r.w > 8 && r.h > 8) images.push(r);
      }
    }
    return { w: vp.width, h: vp.height, lines, images };
  }

  // Group lines into paragraphs (consistent with how Edit groups text).
  function paragraphs(lines, pageW) {
    const sorted = [...lines].sort((p, q) => p.y - q.y || p.x0 - q.x0);
    const blocks = [];
    for (const ln of sorted) {
      const b = blocks[blocks.length - 1];
      const last = b?.lines[b.lines.length - 1];
      const ok = last && ln.y - last.y > last.size * 0.6 && ln.y - last.y < last.size * 1.75 && ln.size / last.size > 0.8 && ln.size / last.size < 1.25 &&
        ln.x0 < b.x1 + last.size && ln.x1 > b.x0 - last.size && Math.abs(ln.x0 - b.x0) < last.size * 3;
      if (ok) { b.lines.push(ln); b.x0 = Math.min(b.x0, ln.x0); b.x1 = Math.max(b.x1, ln.x1); }
      else blocks.push({ lines: [ln], x0: ln.x0, x1: ln.x1 });
    }
    for (const b of blocks) {
      const first = b.lines[0], last = b.lines[b.lines.length - 1];
      b.y = first.y - first.size * 0.9;
      b.bottom = last.y + last.size * 0.25;
      b.size = first.size;
      const gaps = b.lines.slice(1).map((l, i) => l.y - b.lines[i].y);
      b.lineGap = gaps.length ? gaps.reduce((s, g) => s + g, 0) / gaps.length : first.size * 1.17;
      const centers = b.lines.map((l) => (l.x0 + l.x1) / 2);
      const centered = centers.every((c) => Math.abs(c - pageW / 2) < pageW * 0.04) && b.lines.some((l) => l.x1 - l.x0 < pageW * 0.7);
      const rightAligned = b.lines.length > 1 && b.lines.every((l) => Math.abs(l.x1 - b.x1) < first.size) && b.lines.some((l) => Math.abs(l.x0 - b.x0) > first.size * 2);
      b.align = centered ? 'center' : rightAligned ? 'right' : 'left';
      // hard line breaks where a line stops well short of the paragraph's right edge
      b.paras = [[]];
      b.lines.forEach((l, i) => {
        const cur = b.paras[b.paras.length - 1];
        if (cur.length) cur.push({ text: ' ' });
        cur.push(...l.runs.map((r) => ({ ...r })));
        if (i < b.lines.length - 1 && (l.x1 - b.x0) < (b.x1 - b.x0) * 0.8 && b.align === 'left') b.paras.push([]);
      });
    }
    return blocks;
  }
  const mergeRuns = (runs) => runs.reduce((out, r) => {
    const last = out[out.length - 1];
    if (last && r.text === ' ') { last.text += ' '; return out; }
    if (last && last.font === r.font && last.bold === r.bold && last.italic === r.italic && last.size === r.size) last.text += r.text;
    else out.push({ ...r });
    return out;
  }, []);

  // ------------------------------------------------------------ export dialog
  const FORMATS = {
    docx: { title: 'Export to Word', ext: 'docx' },
    xlsx: { title: 'Export to Excel', ext: 'xlsx' },
    pptx: { title: 'Export to PowerPoint', ext: 'pptx' },
    image: { title: 'Export as images' },
    text: { title: 'Export as text', ext: 'txt' },
  };

  function exportDialog(kind) {
    if (!S.pages.length) { toast('Open a document first', true); return; }
    if (!native && kind !== 'text' && kind !== 'image') { toast('This export needs the Folio desktop app', true); return; }
    const scanned = scannedHint();
    const extra = {
      docx: `<label class="check"><input type="checkbox" id="cvImages" checked> Include images</label>`,
      xlsx: `<div class="field"><label class="check"><input type="radio" name="cvSheets" value="page" checked> One worksheet per page</label>
             <label class="check"><input type="radio" name="cvSheets" value="one"> One worksheet for the whole document</label></div>`,
      pptx: '',
      image: `<div class="grid-3"><label class="form-field"><span>Format</span><select class="form-input" id="cvFmt"><option value="png">PNG</option><option value="jpeg">JPEG</option></select></label>
             <label class="form-field"><span>Resolution</span><select class="form-input" id="cvDpi"><option>72</option><option selected>150</option><option>300</option><option>600</option></select></label></div>`,
      text: '',
    }[kind];
    openPanel({
      title: FORMATS[kind].title,
      body: `${rangeField()}${extra}
        ${scanned ? `<p class="note warn">${scanned} page${scanned > 1 ? 's look' : ' looks'} scanned and ${scanned > 1 ? 'have' : 'has'} no text. Run <b>Recognize text</b> first to get editable text from ${scanned > 1 ? 'them' : 'it'}.</p>` : ''}
        <p class="note">${{
          docx: 'Text keeps its fonts, sizes, bold and italic, paragraphs and spacing. Complex layouts (columns, text over images) are simplified.',
          xlsx: 'Columns and rows are detected from the position of text on each page. Numbers become real numbers you can calculate with.',
          pptx: 'Each page becomes a slide: the page artwork as the background, with its text as editable text boxes on top.',
          image: 'Each page is saved as a separate image file in a folder you choose.',
          text: 'Saves the text of each page in reading order.',
        }[kind]}</p>`,
      actions: [{ label: 'Cancel' }, {
        label: 'Export…', primary: true,
        run: async (form) => {
          let idx;
          try { idx = parseRange(form.querySelector('#cvRange').value, S.pages.length); } catch (e) { toast(e.message, true); return false; }
          const opts = {
            images: form.querySelector('#cvImages')?.checked,
            sheets: form.querySelector('[name="cvSheets"]:checked')?.value,
            fmt: form.querySelector('#cvFmt')?.value,
            dpi: +form.querySelector('#cvDpi')?.value || 150,
          };
          setTimeout(() => runExport(kind, idx, opts), 0);
          return true;
        },
      }],
    });
  }

  function scannedHint() {
    let n = 0;
    for (const pg of S.pages) { const t = textCache.get(`${pg.src}:${S.sources.get(pg.src).ver}:${pg.idx}`); if (t && t.reduce((s, i) => s + i.str.trim().length, 0) < 20) n++; }
    return n;
  }

  async function runExport(kind, idx, opts) {
    try {
      busy('Preparing pages…');
      const doc = await savedDoc(idx);
      const name = `${fileBase()}.${FORMATS[kind].ext || ''}`;
      let r;
      if (kind === 'docx') r = await native.exportDoc('docx', await wordModel(doc, opts), name, S.docDir);
      else if (kind === 'xlsx') r = await native.exportDoc('xlsx', await excelModel(doc, opts), name, S.docDir);
      else if (kind === 'pptx') r = await native.exportDoc('pptx', await pptModel(doc), name, S.docDir);
      else if (kind === 'text') {
        const text = await textOf(doc);
        if (native) r = await native.saveText(text, name, S.docDir);
        else { downloadBlob(new Blob(['﻿' + text], { type: 'text/plain' }), name); r = { name }; }
      } else if (kind === 'image') {
        const imgs = [];
        for (let i = 1; i <= doc.numPages; i++) {
          busy(`Rendering page ${i} of ${doc.numPages}…`);
          const c = await renderFull(await doc.getPage(i), opts.dpi / 72);
          imgs.push({ ext: opts.fmt === 'png' ? 'png' : 'jpg', data: await canvasBytes(c, `image/${opts.fmt}`, 0.92) });
        }
        busy(null);
        if (native) {
          r = await native.saveImages(imgs, fileBase(), S.docDir);
          if (r && !r.error) { toast(`Saved ${r.count} image${r.count > 1 ? 's' : ''}`); native.showInFolder(r.path); return; }
        } else { imgs.forEach((im, i) => downloadBlob(new Blob([im.data]), `${fileBase()}_${i + 1}.${im.ext}`)); r = { name: `${imgs.length} images` }; }
      }
      doc.destroy();
      busy(null);
      if (!r) return;
      if (r.error) throw new Error(r.error);
      toast(`Exported ${r.name}`);
      if (r.path && native) native.showInFolder(r.path);
    } catch (e) {
      console.error(e);
      toast('Export failed: ' + e.message, true);
    } finally { busy(null); }
  }
  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  async function textOf(doc) {
    const out = [];
    for (let i = 1; i <= doc.numPages; i++) {
      busy(`Reading text, page ${i} of ${doc.numPages}…`);
      const st = await pageStructure(await doc.getPage(i));
      const blocks = paragraphs(st.lines, st.w);
      out.push(blocks.map((b) => b.paras.map((p) => p.map((r) => r.text).join('').replace(/\s+$/, '')).join('\n')).join('\n\n'));
    }
    return out.join('\n\n\f\n').replace(/\r?\n/g, '\r\n');
  }

  async function wordModel(doc, opts) {
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      busy(`Rebuilding page ${i} of ${doc.numPages} for Word…`);
      const page = await doc.getPage(i);
      const st = await pageStructure(page);
      const tables = findTables(st.lines, st.w);
      const inTable = new Set(tables.flatMap((t) => t.lines));
      const blocks = paragraphs(st.lines.filter((l) => !inTable.has(l)), st.w);
      const hasText = st.lines.length > 0;
      const items = blocks.map((b) => ({ kind: 'text', y: b.y, bottom: b.bottom, b }));
      for (const t of tables) items.push({ kind: 'table', y: t.y, bottom: t.bottom, t });
      if (opts.images !== false) {
        const imgs = st.images.filter((r) => !(hasText && r.w * r.h > st.w * st.h * 0.8)); // drop full-page scan backgrounds once text exists
        if (imgs.length) {
          const scale = 2;
          const canvas = await renderNoText(page, scale);
          for (const r of imgs) {
            const c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(r.w * scale)); c.height = Math.max(1, Math.round(r.h * scale));
            c.getContext('2d').drawImage(canvas, r.x * scale, r.y * scale, r.w * scale, r.h * scale, 0, 0, c.width, c.height);
            items.push({ kind: 'image', y: r.y, bottom: r.y + r.h, r, png: await canvasBytes(c, 'image/png') });
          }
        }
      }
      items.sort((p, q) => p.y - q.y);
      const left = Math.max(36, Math.min(108, ...items.map((it) => (it.kind === 'text' ? it.b.x0 : it.kind === 'table' ? it.t.x0 : it.r.x))));
      const top = Math.max(24, Math.min(96, items.length ? items[0].y : 72));
      const margin = { top, bottom: 36, left, right: 36 };
      let prevBottom = top;
      const out = [];
      for (const it of items) {
        const spaceBefore = Math.max(0, it.y - prevBottom);
        if (it.kind === 'image') {
          const maxW = st.w - margin.left - margin.right;
          const k = Math.min(1, maxW / it.r.w);
          out.push({ type: 'image', png: it.png, x: it.r.x, w: it.r.w * k, h: it.r.h * k, spaceBefore });
        } else if (it.kind === 'table') {
          const t = it.t;
          // column widths from where each column starts to where the next one starts
          const widths = t.cols.map((c, i) => (i < t.cols.length - 1 ? t.cols[i + 1].x0 - c.x0 : Math.max(c.x1 - c.x0 + 12, 48)));
          const rowGap = t.lines.length > 1 ? (t.lines[t.lines.length - 1].y - t.lines[0].y) / (t.lines.length - 1) : t.lines[0].size * 1.4;
          out.push({
            type: 'table', x: t.x0, spaceBefore, widths, rowHeight: rowGap,
            rows: t.rows.map((r) => r.map((c) => ({ text: c.text, bold: !!c.bold, italic: !!c.italic, font: c.font || 'Arial', size: n2(c.size || 11) }))),
          });
        } else {
          const b = it.b;
          b.paras.forEach((runs, j) => {
            out.push({
              type: 'para', runs: mergeRuns(runs).filter((r) => r.text), align: b.align, x: b.align === 'left' ? b.x0 : margin.left,
              spaceBefore: j === 0 ? spaceBefore : 0, lineHeight: Math.max(0.8, Math.min(2.5, b.lineGap / (b.size * 1.17))),
            });
          });
        }
        prevBottom = Math.max(prevBottom, it.bottom);
      }
      pages.push({ w: st.w, h: st.h, margin, blocks: out });
    }
    busy('Writing the Word document…');
    return { title: fileBase(), pages };
  }

  async function excelModel(doc, opts) {
    const sheets = [];
    const all = [];
    for (let i = 1; i <= doc.numPages; i++) {
      busy(`Finding tables, page ${i} of ${doc.numPages}…`);
      const st = await pageStructure(await doc.getPage(i));
      const rows = tableRows(st);
      if (opts.sheets === 'one') { if (all.length && rows.length) all.push([]); all.push(...rows); }
      else sheets.push({ name: `Page ${i}`, rows });
    }
    if (opts.sheets === 'one') sheets.push({ name: fileBase().slice(0, 31) || 'Sheet1', rows: all });
    return { sheets };
  }

  // Cells of one line: runs of text separated by gaps wider than about a character.
  function segmentsOf(ln) {
    const segs = [];
    for (const it of ln.items) {
      const last = segs[segs.length - 1];
      if (last && it.x0 - last.x1 < it.size * 0.9) {
        if (it.x0 - last.x1 > it.size * 0.15 && !/\s$/.test(last.text)) last.text += ' ';
        last.text += it.str; last.x1 = it.x1;
      } else segs.push({ text: it.str, x0: it.x0, x1: it.x1, size: it.size, ...it.style });
    }
    return segs.filter((s) => s.text.trim()).map((s) => ({ ...s, text: s.text.trim() }));
  }

  // Column x-ranges that line up across rows (wide paragraph-like runs don't define columns).
  function columnsOf(segRows, pageW) {
    const cols = [];
    for (const s of segRows.flat()) {
      if (s.x1 - s.x0 > pageW * 0.45) continue;
      const c = cols.find((iv) => s.x0 <= iv.x1 + 2 && s.x1 >= iv.x0 - 2);
      if (c) { c.x0 = Math.min(c.x0, s.x0); c.x1 = Math.max(c.x1, s.x1); } else cols.push({ x0: s.x0, x1: s.x1 });
    }
    cols.sort((p, q) => p.x0 - q.x0);
    for (let i = 1; i < cols.length;) {
      if (cols[i].x0 <= cols[i - 1].x1) { cols[i - 1].x1 = Math.max(cols[i - 1].x1, cols[i].x1); cols.splice(i, 1); } else i++;
    }
    return cols;
  }
  const colIndex = (cols, s) => {
    const mid = (s.x0 + Math.min(s.x1, s.x0 + 20)) / 2;
    let ci = cols.findIndex((c) => mid >= c.x0 - 2 && mid <= c.x1 + 2);
    if (ci < 0) ci = cols.reduce((best, c, k) => (Math.abs(c.x0 - s.x0) < Math.abs(cols[best].x0 - s.x0) ? k : best), 0);
    return ci;
  };

  // Runs of 2+ consecutive lines that each have 2+ cells become tables (used for Word).
  function findTables(lines, pageW) {
    const sorted = [...lines].sort((p, q) => p.y - q.y);
    const groups = [];
    let cur = [];
    const close = () => { if (cur.length >= 2) groups.push(cur); cur = []; };
    for (const ln of sorted) {
      const segs = segmentsOf(ln);
      const prev = cur[cur.length - 1];
      if (segs.length >= 2 && (!prev || ln.y - prev.ln.y < Math.max(ln.size, prev.ln.size) * 3.2)) cur.push({ ln, segs });
      else { close(); if (segs.length >= 2) cur.push({ ln, segs }); }
    }
    close();
    return groups.map((g) => {
      const cols = columnsOf(g.map((r) => r.segs), pageW);
      const rows = g.map((r) => {
        const row = cols.map(() => null);
        for (const s of r.segs) {
          const ci = colIndex(cols, s);
          row[ci] = row[ci] ? { ...row[ci], text: `${row[ci].text} ${s.text}` } : s;
        }
        return row.map((c) => c || { text: '' });
      });
      const first = g[0].ln, last = g[g.length - 1].ln;
      return { lines: g.map((r) => r.ln), cols, rows, y: first.y - first.size * 0.9, bottom: last.y + last.size * 0.3, x0: cols[0].x0, x1: cols[cols.length - 1].x1 };
    }).filter((t) => t.cols.length >= 2);
  }

  // Rows from text lines; columns from x-ranges that line up across rows.
  // Table regions keep their cells; text outside tables goes in column A, in reading order.
  function tableRows(st) {
    const tables = findTables(st.lines, st.w);
    const where = new Map();
    tables.forEach((t) => t.lines.forEach((l, i) => where.set(l, t.rows[i])));
    const rows = [];
    for (const ln of [...st.lines].sort((p, q) => p.y - q.y)) {
      const cells = where.get(ln);
      const row = cells ? cells.map((c) => c.text) : [segmentsOf(ln).map((s) => s.text).join(' ')];
      if (row.some((v) => v)) rows.push(row);
    }
    return rows;
  }

  async function pptModel(doc) {
    const slides = [];
    for (let i = 1; i <= doc.numPages; i++) {
      busy(`Building slide ${i} of ${doc.numPages}…`);
      const page = await doc.getPage(i);
      const st = await pageStructure(page);
      const bg = (await renderNoText(page, 2)).toDataURL('image/jpeg', 0.9);
      const blocks = paragraphs(st.lines, st.w);
      const IN = (pt) => n2(pt / 72);
      slides.push({
        w: IN(st.w), h: IN(st.h), bg,
        texts: blocks.map((b) => {
          const r0 = b.lines[0].runs[0];
          return {
            text: b.paras.map((p) => p.map((r) => r.text).join('')).join('\n'),
            x: IN(b.x0), y: IN(b.y), w: IN(b.x1 - b.x0 + b.size), h: IN(b.bottom - b.y + b.size * 0.3),
            size: n2(b.size), font: r0.font, bold: r0.bold, italic: r0.italic, lineHeight: Math.max(0.8, Math.min(2.5, b.lineGap / (b.size * 1.17))),
          };
        }),
      });
    }
    return { slides };
  }

  // ------------------------------------------------------------ create PDF from other files
  const CREATE_RE = /\.(docx?|docm|rtf|odt|xlsx?|xlsm|xlsb|csv|ods|pptx?|pptm|ppsx?|odp|html?|txt|md)$/i;
  Folio.createPdf = {
    handles: (name) => CREATE_RE.test(name),
    async convert(f) {
      if (!native) throw new Error(`Creating a PDF from ${f.name} needs the Folio desktop app.`);
      let r;
      if (/\.html?$/i.test(f.name)) r = await native.htmlToPdf(f.path ? { filePath: f.path } : { html: new TextDecoder().decode(f.data) });
      else if (/\.(txt|md)$/i.test(f.name)) {
        const text = new TextDecoder().decode(f.data).replace(/^﻿/, '');
        r = await native.htmlToPdf({ html: `<!doctype html><meta charset="utf-8"><title>${esc(f.name)}</title><pre style="font:10pt Consolas,'Courier New',monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:0">${esc(text)}</pre>` });
      } else r = await native.officeToPdf({ name: f.name, path: f.path, data: f.data });
      if (r.error) throw new Error(r.error);
      return new Uint8Array(r.data);
    },
  };

  async function createDialog() {
    const info = native ? await native.converterInfo() : {};
    const row = (label, ok, how) => `<li><span class="pill ${ok ? 'ok' : 'warn'}">${ok ? 'Ready' : 'Unavailable'}</span> ${label}${ok ? ` <span class="note">via ${how}</span>` : ''}</li>`;
    const office = (k, app) => row(app.replace('Microsoft ', ''), info[k] || info.libreoffice, info[k] ? app : 'LibreOffice');
    openPanel({
      title: 'Create PDF',
      body: `<p class="note">Choose one or more files. Folio converts each one to PDF and opens the result. Several files are combined into one document.</p>
        <ul class="conv-list">
          ${row('Images (PNG, JPEG, WebP, GIF)', true, 'Folio')}
          ${row('Web pages (HTML) and text files', !!native, 'Folio')}
          ${office('word', 'Microsoft Word')}
          ${office('excel', 'Microsoft Excel')}
          ${office('powerpoint', 'Microsoft PowerPoint')}
        </ul>
        ${native && !(info.word && info.excel && info.powerpoint) && !info.libreoffice ? '<p class="note">Office files are converted by Microsoft Office or LibreOffice, so one of them must be installed on this PC. Nothing is uploaded.</p>' : ''}`,
      actions: [{ label: 'Cancel' }, { label: 'Choose files…', primary: true, run: () => { setTimeout(() => pickFiles('replace'), 0); return true; } }],
    });
  }

  // ------------------------------------------------------------ OCR
  let tess = null;
  async function ocrWorker(progress) {
    if (!window.Tesseract) {
      await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'vendor/tesseract/tesseract.min.js'; s.onload = res; s.onerror = () => rej(new Error('OCR engine missing')); document.head.appendChild(s); });
    }
    if (!tess) {
      const abs = (p) => new URL(p, location.href).href;
      tess = await Tesseract.createWorker('eng', 1, {
        workerPath: abs('vendor/tesseract/worker.min.js'),
        corePath: abs('vendor/tesseract/core/'),
        langPath: abs('vendor/tesseract/lang'),
        workerBlobURL: false, gzip: true, cacheMethod: 'none',
        logger: (m) => progress?.(m),
      });
    }
    return tess;
  }

  function ocrDialog() {
    if (!S.pages.length) { toast('Open a document first', true); return; }
    openPanel({
      title: 'Recognize text (OCR)',
      body: `<p class="note">Finds the words in scanned pages and adds an invisible text layer, so you can search, select, copy, edit and export them. The page image is unchanged. Runs entirely on this PC.</p>
        <div class="field"><label class="check"><input type="radio" name="ocrScope" value="scanned" checked> Pages without text (scans)</label>
        <label class="check"><input type="radio" name="ocrScope" value="range"> These pages:</label></div>
        ${rangeField('ocrRange')}
        <label class="form-field"><span>Language</span><select class="form-input" id="ocrLang"><option value="eng">English</option></select></label>`,
      actions: [{ label: 'Cancel' }, {
        label: 'Recognize text', primary: true,
        run: async (form) => {
          const scope = form.querySelector('[name="ocrScope"]:checked').value;
          let idx;
          try { idx = scope === 'range' ? parseRange(form.querySelector('#ocrRange').value, S.pages.length) : null; } catch (e) { toast(e.message, true); return false; }
          setTimeout(() => runOcr(idx), 0);
          return true;
        },
      }],
      onOpen: (form) => { form.querySelector('#ocrRange').addEventListener('focus', () => { form.querySelector('[value="range"]').checked = true; }); },
    });
  }

  async function runOcr(indices) {
    const before = snap();
    let done = 0, words = 0;
    try {
      busy('Starting the text recognizer…');
      let targets = indices ? indices.map((i) => S.pages[i]) : [];
      if (!indices) {
        for (const pg of S.pages) {
          const items = await pageText(pg);
          if (items.reduce((s, i) => s + i.str.trim().length, 0) < 20) targets.push(pg);
        }
      }
      if (!targets.length) { toast('Every page already has text. Choose specific pages to recognize them again.'); return; }
      let current = 0;
      const worker = await ocrWorker((m) => {
        if (m.status === 'recognizing text') busy(`Recognizing text — page ${current} of ${targets.length} (${Math.round(m.progress * 100)}%)`);
      });
      for (const pg of targets) {
        current++;
        busy(`Recognizing text — page ${current} of ${targets.length}`);
        const page = await S.sources.get(pg.src).doc.getPage(pg.idx + 1);
        const rot = (pg.base + pg.rot) % 360;
        const scale = 300 / 72;
        const vpHi = page.getViewport({ scale, rotation: rot });
        const vp = page.getViewport({ scale: 1, rotation: rot });
        const c = document.createElement('canvas');
        c.width = Math.ceil(vpHi.width); c.height = Math.ceil(vpHi.height);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: ctx, viewport: vpHi, intent: 'print' }).promise;
        const { data } = await worker.recognize(c);
        const list = [];
        for (const w of data.words || []) {
          const t = (w.text || '').trim();
          if (!t || w.confidence < 35) continue;
          const bx0 = w.bbox.x0 / scale, bx1 = w.bbox.x1 / scale, top = w.bbox.y0 / scale;
          const base = (w.baseline && Number.isFinite(w.baseline.y0) && w.baseline.y0 > 0) ? w.baseline.y0 / scale : (w.bbox.y1 / scale) - (w.bbox.y1 - w.bbox.y0) / scale * 0.2;
          const p0 = vp.convertToPdfPoint(bx0, base), p1 = vp.convertToPdfPoint(bx1, base), pt = vp.convertToPdfPoint(bx0, top);
          const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
          if (len < 1) continue;
          const ux = (p1[0] - p0[0]) / len, uy = (p1[1] - p0[1]) / len;
          const size = clamp(Math.hypot(pt[0] - p0[0], pt[1] - p0[1]) / 0.72, 3, 200);
          list.push({ t, w: n2(len), size: n2(size), m: [ux, uy, -uy, ux, p0[0], p0[1]] });
        }
        await Folio.edit.setOcr(pg, list);
        words += list.length;
        done++;
      }
      checkpoint(before);
      rebuild();
      toast(`Recognized ${words.toLocaleString()} words on ${done} page${done > 1 ? 's' : ''}. Search, edit and export now work on them.`);
    } catch (e) {
      console.error(e);
      if (done) { checkpoint(before); rebuild(); }
      toast('Text recognition stopped: ' + e.message, true);
    } finally { busy(null); }
  }

  // ------------------------------------------------------------ compress
  const PRESETS = {
    high: { label: 'High quality', maxPx: 2400, q: 0.85 },
    medium: { label: 'Balanced', maxPx: 1600, q: 0.75 },
    low: { label: 'Smallest file', maxPx: 1100, q: 0.6 },
  };
  function compressDialog() {
    if (!S.pages.length) { toast('Open a document first', true); return; }
    openPanel({
      title: 'Compress PDF',
      body: `<p class="note">Re-encodes large photos and scans at a lower resolution and removes unused data. Text, vector drawings and form content are not changed.</p>
        <div class="field">${Object.entries(PRESETS).map(([k, p], i) => `<label class="check"><input type="radio" name="cmp" value="${k}" ${i === 1 ? 'checked' : ''}> ${p.label} <span class="note">(images up to ${p.maxPx}px, quality ${Math.round(p.q * 100)})</span></label>`).join('')}</div>`,
      actions: [{ label: 'Cancel' }, {
        label: 'Compress and save…', primary: true,
        run: async (form) => { const k = form.querySelector('[name="cmp"]:checked').value; setTimeout(() => runCompress(PRESETS[k]), 0); return true; },
      }],
    });
  }

  async function runCompress(preset) {
    try {
      const original = await exportPdf(S.pages);
      busy('Compressing images…');
      const lib = await PDFDocument.load(original, { updateMetadata: false });
      let changed = 0, n = 0;
      const objs = lib.context.enumerateIndirectObjects();
      for (const [ref, obj] of objs) {
        if (!(obj instanceof PDFRawStream)) continue;
        const d = obj.dict;
        if (d.get(PDFName.of('Subtype'))?.toString() !== '/Image') continue;
        const filter = d.get(PDFName.of('Filter'));
        const fname = filter instanceof PDFArray ? (filter.size() === 1 ? filter.get(0).toString() : '') : filter?.toString();
        if (fname !== '/DCTDecode') continue;
        if (d.get(PDFName.of('SMask')) || d.get(PDFName.of('Mask')) || d.get(PDFName.of('Decode'))) continue;
        const cs = d.lookup(PDFName.of('ColorSpace'));
        const csName = cs?.toString() || '';
        if (/CMYK/.test(csName) || (cs instanceof PDFArray && /ICCBased/.test(cs.get(0)?.toString()) && lib.context.lookup(cs.get(1))?.dict?.lookup(PDFName.of('N'))?.asNumber?.() === 4)) continue;
        const w = d.lookup(PDFName.of('Width'))?.asNumber?.() || 0, h = d.lookup(PDFName.of('Height'))?.asNumber?.() || 0;
        if (!w || !h) continue;
        n++;
        busy(`Compressing images… (${n})`);
        const bytes = obj.contents;
        const k = Math.min(1, preset.maxPx / Math.max(w, h));
        if (k === 1 && bytes.length < 150 * 1024) continue;
        let bmp;
        try { bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' })); } catch { continue; }
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
        const ctx = c.getContext('2d');
        ctx.drawImage(bmp, 0, 0, c.width, c.height);
        bmp.close?.();
        // canvas always encodes RGB JPEGs, so grayscale sources become RGB too
        const out = await canvasBytes(c, 'image/jpeg', preset.q);
        if (out.length >= bytes.length * 0.9) continue;
        const stream = lib.context.stream(out, {
          Type: 'XObject', Subtype: 'Image', Width: c.width, Height: c.height,
          ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode',
        });
        lib.context.assign(ref, stream);
        changed++;
      }
      busy('Saving…');
      const result = await lib.save({ useObjectStreams: true });
      busy(null);
      const mb = (x) => (x / 1048576).toFixed(x > 10485760 ? 1 : 2) + ' MB';
      const pct = Math.round((1 - result.length / original.length) * 100);
      const summary = `${mb(original.length)} → ${mb(result.length)}${pct > 0 ? ` (${pct}% smaller)` : ''}. ${changed} of ${n} images re-encoded.`;
      if (result.length >= original.length * 0.98) { toast(`Already compact: ${summary}`); return; }
      const name = `${fileBase()}-compressed.pdf`;
      if (native) {
        const r = await native.saveDialog(name, result, S.docDir);
        if (r) toast(`Saved ${r.name}: ${summary}`);
      } else { downloadBlob(new Blob([result], { type: 'application/pdf' }), name); toast(summary); }
    } catch (e) {
      console.error(e);
      toast('Compression failed: ' + e.message, true);
    } finally { busy(null); }
  }

  Folio.convert = { pageStructure, paragraphs, tableRows, parseRange, savedDoc, wordModel, excelModel, pptModel, textOf };
})();
