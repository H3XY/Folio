/* Folio — PDF content stream reader/rewriter.
   Tokenizes page content streams, replays the text and graphics state to find where every
   text-showing and image-drawing operator lands on the page, and rewrites streams so edited
   text is genuinely removed (not covered) and images can be moved or deleted. */
'use strict';

(() => {
  const { PDFName, PDFDict, PDFArray, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream } = PDFLib;

  // ------------------------------------------------------------ tokenizer
  const WS = new Set([0, 9, 10, 12, 13, 32]);
  const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]); // ( ) < > [ ] { } / %
  const isWS = (c) => WS.has(c);
  const isDelim = (c) => DELIM.has(c);

  function tokenize(b) {
    const ops = [];
    let args = [];
    let opStart = -1;
    let i = 0;
    const n = b.length;
    const stack = []; // open arrays / dicts

    const push = (tok, start) => {
      if (opStart < 0) opStart = start;
      if (stack.length) stack[stack.length - 1].push(tok);
      else args.push(tok);
    };

    while (i < n) {
      const c = b[i];
      if (isWS(c)) { i++; continue; }
      if (c === 37) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; continue; } // comment
      const start = i;
      if (c === 40) { // literal string
        let depth = 1; i++;
        const out = [];
        while (i < n && depth) {
          let ch = b[i++];
          if (ch === 92) {
            const e = b[i++];
            if (e === 110) out.push(10); else if (e === 114) out.push(13); else if (e === 116) out.push(9);
            else if (e === 98) out.push(8); else if (e === 102) out.push(12);
            else if (e === 13) { if (b[i] === 10) i++; }
            else if (e === 10) { /* line continuation */ }
            else if (e >= 48 && e <= 55) {
              let v = e - 48;
              for (let k = 0; k < 2 && b[i] >= 48 && b[i] <= 55; k++) v = v * 8 + (b[i++] - 48);
              out.push(v & 255);
            } else out.push(e);
            continue;
          }
          if (ch === 40) depth++;
          else if (ch === 41) { depth--; if (!depth) break; }
          out.push(ch);
        }
        push({ t: 's', v: Uint8Array.from(out) }, start);
        continue;
      }
      if (c === 60 && b[i + 1] === 60) { i += 2; stack.push(Object.assign([], { dict: true, start })); continue; }
      if (c === 62 && b[i + 1] === 62) {
        i += 2;
        const d = stack.pop() || [];
        push({ t: 'd', v: d }, d.start ?? start);
        continue;
      }
      if (c === 60) { // hex string
        i++;
        let hex = '';
        while (i < n && b[i] !== 62) { if (!isWS(b[i])) hex += String.fromCharCode(b[i]); i++; }
        i++;
        if (hex.length % 2) hex += '0';
        const out = new Uint8Array(hex.length / 2);
        for (let k = 0; k < out.length; k++) out[k] = parseInt(hex.substr(k * 2, 2), 16) || 0;
        push({ t: 's', v: out, hex: true }, start);
        continue;
      }
      if (c === 91) { i++; stack.push(Object.assign([], { start })); continue; }
      if (c === 93) { i++; const a = stack.pop() || []; push({ t: 'a', v: a }, a.start ?? start); continue; }
      if (c === 47) { // name
        i++;
        let s = '';
        while (i < n && !isWS(b[i]) && !isDelim(b[i])) s += String.fromCharCode(b[i++]);
        push({ t: 'n', v: s.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) }, start);
        continue;
      }
      // number or keyword
      let s = '';
      while (i < n && !isWS(b[i]) && !isDelim(b[i])) s += String.fromCharCode(b[i++]);
      if (!s) { i++; continue; }
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) { push({ t: 'num', v: parseFloat(s) }, start); continue; }
      if (s === 'true' || s === 'false') { push({ t: 'b', v: s === 'true' }, start); continue; }
      if (s === 'null') { push({ t: 'null' }, start); continue; }
      if (stack.length) { stack[stack.length - 1].push({ t: 'kw', v: s }); continue; } // malformed, keep going
      // operator
      if (s === 'BI') {
        // inline image: dictionary until ID, then binary data until EI
        const dictStart = opStart >= 0 ? opStart : start;
        while (i < n && !(b[i] === 73 && b[i + 1] === 68 && isWS(b[i + 2] ?? 32) && isWS(b[i - 1]))) i++;
        i += 3;
        while (i < n && !(isWS(b[i - 1]) && b[i] === 69 && b[i + 1] === 73 && (i + 2 >= n || isWS(b[i + 2]) || isDelim(b[i + 2])))) i++;
        i += 2;
        ops.push({ op: 'BI', args: [], start: dictStart, end: i });
        args = []; opStart = -1;
        continue;
      }
      ops.push({ op: s, args, start: opStart >= 0 ? opStart : start, end: i });
      args = []; opStart = -1;
    }
    return ops;
  }

  // ------------------------------------------------------------ matrices
  const mul = (A, B) => [
    A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5],
  ];
  const inv = ([a, b, c, d, e, f]) => { const k = a * d - b * c; return [d / k, -b / k, -c / k, a / k, (c * f - d * e) / k, (b * e - a * f) / k]; };
  const apply = (M, x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
  const I = [1, 0, 0, 1, 0, 0];

  // ------------------------------------------------------------ fonts (widths for advance calculation)
  let stdFonts = null;
  async function stdFont(baseFont) {
    if (!stdFonts) {
      const d = await PDFLib.PDFDocument.create();
      const SF = PDFLib.StandardFonts;
      stdFonts = {};
      for (const k of ['Helvetica', 'HelveticaBold', 'TimesRoman', 'TimesRomanBold', 'Courier', 'Symbol', 'ZapfDingbats']) stdFonts[k] = await d.embedFont(SF[k]);
    }
    const n = (baseFont || '').toLowerCase();
    const bold = /bold/.test(n);
    if (/courier/.test(n)) return stdFonts.Courier;
    if (/times/.test(n)) return bold ? stdFonts.TimesRomanBold : stdFonts.TimesRoman;
    if (/symbol/.test(n)) return stdFonts.Symbol;
    if (/dingbat/.test(n)) return stdFonts.ZapfDingbats;
    return bold ? stdFonts.HelveticaBold : stdFonts.Helvetica;
  }

  const num = (o) => (o instanceof PDFNumber ? o.asNumber() : typeof o?.asNumber === 'function' ? o.asNumber() : 0);
  const nameOf = (o) => (o ? (typeof o.decodeText === 'function' ? o.decodeText() : o.asString?.() || String(o)).replace(/^\//, '') : '');

  async function fontInfo(ctx, dict) {
    if (!dict) return { bpc: 1, width: () => 500, baseFont: '' };
    const L = (k, T) => (T ? dict.lookupMaybe(PDFName.of(k), T) : dict.lookup(PDFName.of(k)));
    const subtype = nameOf(dict.get(PDFName.of('Subtype')));
    const baseFont = nameOf(dict.get(PDFName.of('BaseFont')));
    if (subtype === 'Type0') {
      const desc = dict.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray)?.lookupMaybe(0, PDFDict);
      const dw = desc?.lookup(PDFName.of('DW')) ? num(desc.lookup(PDFName.of('DW'))) : 1000;
      const W = desc?.lookupMaybe(PDFName.of('W'), PDFArray);
      const map = new Map();
      if (W) {
        const arr = W.asArray().map((x) => ctx.lookup(x));
        for (let k = 0; k < arr.length;) {
          const first = num(arr[k]);
          const next = arr[k + 1];
          if (next instanceof PDFArray) {
            next.asArray().forEach((w, j) => map.set(first + j, num(ctx.lookup(w))));
            k += 2;
          } else {
            const last = num(next), w = num(arr[k + 2]);
            for (let c = first; c <= last && c - first < 65536; c++) map.set(c, w);
            k += 3;
          }
        }
      }
      return { bpc: 2, type0: true, baseFont: nameOf(desc?.get(PDFName.of('BaseFont'))) || baseFont, width: (c) => (map.has(c) ? map.get(c) : dw) };
    }
    const widths = L('Widths', PDFArray);
    const first = L('FirstChar') ? num(L('FirstChar')) : 0;
    const fd = L('FontDescriptor', PDFDict);
    const missing = fd?.lookup(PDFName.of('MissingWidth')) ? num(fd.lookup(PDFName.of('MissingWidth'))) : 0;
    if (widths) {
      const ws = widths.asArray().map((x) => num(ctx.lookup(x)));
      return { bpc: 1, baseFont, width: (c) => ws[c - first] ?? missing ?? 500 };
    }
    if (subtype === 'Type3') return { bpc: 1, baseFont, width: () => 500 };
    const sf = await stdFont(baseFont);
    return {
      bpc: 1, baseFont,
      width: (c) => { try { return sf.widthOfTextAtSize(String.fromCharCode(c), 1000); } catch { return 500; } },
    };
  }

  // ------------------------------------------------------------ streams
  function pageStreams(page) {
    const ctx = page.doc.context;
    const contents = page.node.get(PDFName.of('Contents'));
    const refs = [];
    if (contents instanceof PDFArray) contents.asArray().forEach((r) => refs.push(r));
    else if (contents) refs.push(contents);
    return refs.map((ref) => {
      const s = ref instanceof PDFRef ? ctx.lookup(ref) : ref;
      let bytes;
      if (s instanceof PDFRawStream) bytes = decodePDFRawStream(s).decode();
      else if (typeof s?.getUnencodedContents === 'function') bytes = s.getUnencodedContents();
      else bytes = s?.getContents?.() || new Uint8Array();
      return { ref, bytes };
    });
  }

  function cmykToHex(c, m, y, k) {
    const f = (v) => Math.round(255 * (1 - Math.min(1, v + k))).toString(16).padStart(2, '0');
    return '#' + f(c) + f(m) + f(y);
  }
  const grayHex = (g) => { const v = Math.round(clamp(g, 0, 1) * 255).toString(16).padStart(2, '0'); return '#' + v + v + v; };
  const rgbHex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0')).join('');

  // Replay a page's content. Returns text runs and images with user-space geometry.
  async function analyze(page) {
    const ctx = page.doc.context;
    const res = page.node.Resources();
    const fonts = res?.lookupMaybe(PDFName.of('Font'), PDFDict);
    const xobjs = res?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    const fontCache = new Map();
    const getFont = async (key) => {
      if (!fontCache.has(key)) {
        let d = null;
        try { d = fonts?.lookupMaybe(PDFName.of(key), PDFDict) || null; } catch { d = null; }
        fontCache.set(key, await fontInfo(ctx, d));
      }
      return fontCache.get(key);
    };

    const streams = pageStreams(page);
    const texts = [], images = [];
    let gs = { ctm: I, fill: '#000000', cs: 'DeviceGray', Tc: 0, Tw: 0, Th: 1, TL: 0, Tf: null, Tfs: 0, Ts: 0, Tr: 0 };
    const gstack = [];
    let Tm = I, Tlm = I;

    for (let si = 0; si < streams.length; si++) {
      const ops = tokenize(streams[si].bytes);
      streams[si].ops = ops;
      for (let oi = 0; oi < ops.length; oi++) {
        const { op, args } = ops[oi];
        const nums = () => args.map((a) => (a.t === 'num' ? a.v : 0));
        switch (op) {
          case 'q': gstack.push({ ...gs }); break;
          case 'Q': if (gstack.length) gs = gstack.pop(); break;
          case 'cm': { const m = nums(); if (m.length === 6) gs.ctm = mul(gs.ctm, m); break; }
          case 'g': gs.fill = grayHex(nums()[0]); gs.cs = 'DeviceGray'; break;
          case 'rg': { const [r, g, b] = nums(); gs.fill = rgbHex(r, g, b); gs.cs = 'DeviceRGB'; break; }
          case 'k': { const [c, m, y, k] = nums(); gs.fill = cmykToHex(c, m, y, k); gs.cs = 'DeviceCMYK'; break; }
          case 'cs': gs.cs = args[0]?.v || gs.cs; break;
          case 'sc': case 'scn': {
            const v = nums();
            if (v.length === 1) gs.fill = grayHex(v[0]);
            else if (v.length === 3) gs.fill = rgbHex(...v);
            else if (v.length === 4) gs.fill = cmykToHex(...v);
            break;
          }
          case 'BT': Tm = I; Tlm = I; break;
          case 'Tc': gs.Tc = nums()[0] || 0; break;
          case 'Tw': gs.Tw = nums()[0] || 0; break;
          case 'Tz': gs.Th = (nums()[0] ?? 100) / 100; break;
          case 'TL': gs.TL = nums()[0] || 0; break;
          case 'Ts': gs.Ts = nums()[0] || 0; break;
          case 'Tr': gs.Tr = nums()[0] || 0; break;
          case 'Tf': gs.Tf = args[0]?.v; gs.Tfs = args[1]?.v || 0; break;
          case 'Td': { const [tx, ty] = nums(); Tlm = mul(Tlm, [1, 0, 0, 1, tx, ty]); Tm = Tlm; break; }
          case 'TD': { const [tx, ty] = nums(); gs.TL = -ty; Tlm = mul(Tlm, [1, 0, 0, 1, tx, ty]); Tm = Tlm; break; }
          case 'Tm': { const m = nums(); if (m.length === 6) { Tlm = m; Tm = m; } break; }
          case 'T*': Tlm = mul(Tlm, [1, 0, 0, 1, 0, -gs.TL]); Tm = Tlm; break;
          case 'Tj': case "'": case '"': case 'TJ': {
            if (op === "'" || op === '"') {
              if (op === '"') { gs.Tw = args[0]?.v || 0; gs.Tc = args[1]?.v || 0; }
              Tlm = mul(Tlm, [1, 0, 0, 1, 0, -gs.TL]); Tm = Tlm;
            }
            const font = await getFont(gs.Tf);
            const startM = mul(gs.ctm, Tm);
            let adv = 0; // text-space horizontal advance, before Th
            const items = op === 'TJ' ? (args[0]?.v || []) : [args[args.length - 1]];
            let chars = 0;
            for (const it of items) {
              if (it?.t === 'num') { adv += (-it.v / 1000) * gs.Tfs; continue; }
              if (it?.t !== 's') continue;
              const s = it.v;
              for (let k = 0; k + font.bpc - 1 < s.length; k += font.bpc) {
                const code = font.bpc === 2 ? (s[k] << 8) | s[k + 1] : s[k];
                adv += (font.width(code) / 1000) * gs.Tfs + gs.Tc + (font.bpc === 1 && code === 32 ? gs.Tw : 0);
                chars++;
              }
            }
            Tm = mul(Tm, [1, 0, 0, 1, adv * gs.Th, 0]);
            const endM = mul(gs.ctm, Tm);
            const p0 = apply(startM, 0, gs.Ts), p1 = apply(endM, 0, gs.Ts);
            const up = apply([startM[0], startM[1], startM[2], startM[3], 0, 0], 0, gs.Tfs);
            texts.push({
              si, oi, op, p0, p1, up, size: Math.hypot(up[0], up[1]), chars,
              advUnits: gs.Tfs * gs.Th ? (adv * 1000) / gs.Tfs : 0,
              fontKey: gs.Tf, baseFont: font.baseFont, color: gs.fill, invisible: gs.Tr === 3,
              aw: op === '"' ? args[0]?.v : undefined, ac: op === '"' ? args[1]?.v : undefined,
            });
            break;
          }
          case 'Do': {
            const name = args[0]?.v;
            let x = null;
            try { x = xobjs?.lookup(PDFName.of(name)); } catch { x = null; }
            const sub = x?.dict ? nameOf(x.dict.get(PDFName.of('Subtype'))) : '';
            if (sub === 'Image') images.push({ si, oi, ctm: gs.ctm.slice(), name });
            break;
          }
          case 'BI': images.push({ si, oi, ctm: gs.ctm.slice(), inline: true }); break;
          default: break;
        }
      }
    }
    return { streams, texts, images };
  }

  // ------------------------------------------------------------ rewriting
  const fmt = (v) => (Math.abs(v) < 1e-6 ? '0' : String(Math.round(v * 10000) / 10000));
  const enc = new TextEncoder();

  // Replacement source for a removed text-show operator: advance the text position exactly as the
  // original would have, without drawing anything.
  function removalFor(t) {
    const move = `[${fmt(-t.advUnits)}] TJ`;
    if (t.op === "'") return `T* ${move}`;
    if (t.op === '"') return `${fmt(t.aw || 0)} Tw ${fmt(t.ac || 0)} Tc T* ${move}`;
    return move;
  }
  function transformFor(img, M, src) {
    return `q ${M.map(fmt).join(' ')} cm ${src} Q`;
  }

  // edits: Map<"si:oi", string|null> — replacement source text for that operator.
  function rewrite(stream, edits, si) {
    const parts = [];
    let pos = 0;
    const b = stream.bytes;
    stream.ops.forEach((o, oi) => {
      const k = `${si}:${oi}`;
      if (!edits.has(k)) return;
      parts.push(b.subarray(pos, o.start));
      const r = edits.get(k);
      const text = typeof r === 'function' ? r(new TextDecoder('latin1').decode(b.subarray(o.start, o.end))) : r;
      if (text) parts.push(enc.encode(' ' + text + ' '));
      pos = o.end;
    });
    parts.push(b.subarray(pos));
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }

  globalThis.CS = { tokenize, analyze, rewrite, removalFor, transformFor, pageStreams, mul, inv, apply };
})();
