/* Folio — fonts.
   Text is drawn with the matching Windows TrueType font (embedded, subset) so it looks the same as on screen
   and any character the font has can be used. Falls back to the PDF standard fonts when a file is missing. */
'use strict';

(() => {
  // [regular, bold, italic, bold italic] file names in C:\Windows\Fonts
  const FAMILIES = [
    { name: 'Arial', css: 'Arial, Helvetica, sans-serif', files: ['arial.ttf', 'arialbd.ttf', 'ariali.ttf', 'arialbi.ttf'], std: 'sans' },
    { name: 'Calibri', css: 'Calibri, Carlito, Arial, sans-serif', files: ['calibri.ttf', 'calibrib.ttf', 'calibrii.ttf', 'calibriz.ttf'], std: 'sans' },
    { name: 'Times New Roman', css: '"Times New Roman", Times, serif', files: ['times.ttf', 'timesbd.ttf', 'timesi.ttf', 'timesbi.ttf'], std: 'serif' },
    { name: 'Georgia', css: 'Georgia, serif', files: ['georgia.ttf', 'georgiab.ttf', 'georgiai.ttf', 'georgiaz.ttf'], std: 'serif' },
    { name: 'Garamond', css: 'Garamond, serif', files: ['GARA.TTF', 'GARABD.TTF', 'GARAIT.TTF', 'GARAIT.TTF'], std: 'serif' },
    { name: 'Book Antiqua', css: '"Book Antiqua", Palatino, serif', files: ['BKANT.TTF', 'ANTQUAB.TTF', 'ANTQUAI.TTF', 'ANTQUABI.TTF'], std: 'serif' },
    { name: 'Courier New', css: '"Courier New", Courier, monospace', files: ['cour.ttf', 'courbd.ttf', 'couri.ttf', 'courbi.ttf'], std: 'mono' },
    { name: 'Consolas', css: 'Consolas, monospace', files: ['consola.ttf', 'consolab.ttf', 'consolai.ttf', 'consolaz.ttf'], std: 'mono' },
    { name: 'Verdana', css: 'Verdana, sans-serif', files: ['verdana.ttf', 'verdanab.ttf', 'verdanai.ttf', 'verdanaz.ttf'], std: 'sans' },
    { name: 'Tahoma', css: 'Tahoma, sans-serif', files: ['tahoma.ttf', 'tahomabd.ttf', 'tahoma.ttf', 'tahomabd.ttf'], std: 'sans' },
    { name: 'Trebuchet MS', css: '"Trebuchet MS", sans-serif', files: ['trebuc.ttf', 'trebucbd.ttf', 'trebucit.ttf', 'trebucbi.ttf'], std: 'sans' },
    { name: 'Segoe UI', css: '"Segoe UI", sans-serif', files: ['segoeui.ttf', 'segoeuib.ttf', 'segoeuii.ttf', 'segoeuiz.ttf'], std: 'sans' },
    { name: 'Century Gothic', css: '"Century Gothic", sans-serif', files: ['GOTHIC.TTF', 'GOTHICB.TTF', 'GOTHICI.TTF', 'GOTHICBI.TTF'], std: 'sans' },
    { name: 'Arial Narrow', css: '"Arial Narrow", Arial, sans-serif', files: ['ARIALN.TTF', 'ARIALNB.TTF', 'ARIALNI.TTF', 'ARIALNBI.TTF'], std: 'sans' },
  ];
  const STD = {
    sans: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'],
    serif: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'],
    mono: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'],
  };
  const byName = new Map(FAMILIES.map((f) => [f.name, f]));
  let available = new Set(); // file names present on this PC
  const bytesCache = new Map();

  const variant = (a) => (a.bold ? 1 : 0) + (a.italic ? 2 : 0);

  async function init() {
    if (!native?.fontList) return;
    try {
      available = new Set((await native.fontList(FAMILIES.flatMap((f) => f.files))).map((s) => s.toLowerCase()));
    } catch (e) { console.warn('font list', e); }
  }

  function families() {
    const list = FAMILIES.filter((f) => !native || available.has(f.files[0].toLowerCase())).map((f) => f.name);
    return list.length ? list : ['Arial', 'Times New Roman', 'Courier New'];
  }

  function css(name) { return (byName.get(name) || byName.get('Arial')).css; }

  function fileFor(fam, v) {
    const order = [v, v & 1, v & 2, 0]; // fall back from bold-italic to bold, italic, regular
    for (const i of order) { const f = fam.files[i]; if (available.has(f.toLowerCase())) return f; }
    return null;
  }

  async function embed(out, a) {
    const fam = byName.get(a.font) || byName.get('Arial');
    const v = variant(a);
    const file = native && fileFor(fam, v);
    if (file && typeof fontkit !== 'undefined') {
      try {
        if (!bytesCache.has(file)) bytesCache.set(file, await native.fontRead(file));
        return await out.embedFont(bytesCache.get(file), { subset: true });
      } catch (e) { console.warn('embed font', file, e); }
    }
    return out.embedFont(PDFLib.StandardFonts[STD[fam.std][v]]);
  }

  // Map a PDF BaseFont name (e.g. "ABCDEF+Calibri-BoldItalic", "TimesNewRomanPS-BoldMT") to a family + style.
  function match(baseFont = '', hint = '') {
    const raw = baseFont.replace(/^[A-Z]{6}\+/, '');
    const n = raw.toLowerCase().replace(/[\s_-]/g, '');
    const bold = /bold|black|heavy|semibold|demi|,bold/.test(n);
    const italic = /italic|oblique|,italic/.test(n);
    const table = [
      [/arialnarrow/, 'Arial Narrow'], [/arial|helvetica|liberationsans|nimbussans/, 'Arial'], [/calibri|carlito/, 'Calibri'],
      [/timesnewroman|times|liberationserif|nimbusroman|tinos/, 'Times New Roman'], [/georgia|cambria/, 'Georgia'],
      [/garamond/, 'Garamond'], [/bookantiqua|palatino/, 'Book Antiqua'], [/couriernew|courier|liberationmono|nimbusmono|cousine/, 'Courier New'],
      [/consolas/, 'Consolas'], [/verdana/, 'Verdana'], [/tahoma/, 'Tahoma'], [/trebuchet/, 'Trebuchet MS'], [/segoe/, 'Segoe UI'],
      [/centurygothic/, 'Century Gothic'],
    ];
    let family = table.find(([re]) => re.test(n))?.[1];
    if (!family) family = /serif/.test(hint) && !/sans/.test(hint) ? 'Times New Roman' : /mono/.test(hint) ? 'Courier New' : 'Arial';
    if (native && !families().includes(family)) family = byName.get(family).std === 'serif' ? 'Times New Roman' : byName.get(family).std === 'mono' ? 'Courier New' : 'Arial';
    return { font: family, bold, italic };
  }

  // Font for characters the chosen font lacks (symbols, arrows, checkmarks...).
  const FALLBACKS = ['seguisym.ttf', 'segoeui.ttf', 'arial.ttf'];
  async function embedFallback(out) {
    if (!native || typeof fontkit === 'undefined') return null;
    if (!available.size) await init();
    for (const file of FALLBACKS) {
      if (!available.has(file) && !(await native.fontList([file])).length) continue;
      try {
        if (!bytesCache.has(file)) bytesCache.set(file, await native.fontRead(file));
        return await out.embedFont(bytesCache.get(file), { subset: true });
      } catch (e) { console.warn('fallback font', file, e); }
    }
    return null;
  }

  // Split text into runs drawable by the main font, using the fallback for missing glyphs.
  function runs(text, font, fallback) {
    const fk = font.embedder?.font;
    if (!fk?.hasGlyphForCodePoint || !fallback) return [{ text, font }];
    const fb = fallback.embedder?.font;
    const out = [];
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      const f = fk.hasGlyphForCodePoint(cp) || !fb?.hasGlyphForCodePoint(cp) ? font : fallback;
      const last = out[out.length - 1];
      if (last && last.font === f) last.text += ch; else out.push({ text: ch, font: f });
    }
    return out;
  }

  Folio.fonts = { init, families, css, embed, match, embedFallback, runs };
})();
