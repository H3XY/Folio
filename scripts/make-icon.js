// Draws the Folio icon (the folded-F mark) and writes build/icon.ico with PNG frames.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, px) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// The Folio mark, in unit coords (0..1): a geometric "F" whose top bar folds under at its end — a folio is a
// sheet folded once. onTile: drawn in white on the teal tile; otherwise in teal on a transparent background.
const TEAL = [11, 110, 108, 255], MINT = [134, 214, 209, 255], WHITE = [255, 255, 255, 255];
function inRound(u, v, x0, y0, x1, y1, r) {
  if (u < x0 || u > x1 || v < y0 || v > y1) return false;
  const cx = Math.min(Math.max(u, x0 + r), x1 - r), cy = Math.min(Math.max(v, y0 + r), y1 - r);
  return Math.hypot(u - cx, v - cy) <= r;
}
function inTri(u, v, [ax, ay], [bx, by], [cx, cy]) {
  const s1 = (bx - ax) * (v - ay) - (by - ay) * (u - ax);
  const s2 = (cx - bx) * (v - by) - (cy - by) * (u - bx);
  const s3 = (ax - cx) * (v - cy) - (ay - cy) * (u - cx);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
}
const R = 0.028;
function sample(u, v, onTile = false) {
  const ink = onTile ? WHITE : TEAL;
  if (inRound(u, v, 0.32, 0.2, 0.46, 0.8, R)) return ink; // stem
  if (inRound(u, v, 0.32, 0.2, 0.68, 0.34, R)) return ink; // top bar
  if (inRound(u, v, 0.32, 0.48, 0.6, 0.6, R)) return ink; // middle bar
  if (inTri(u, v, [0.545, 0.31], [0.68, 0.31], [0.68, 0.445])) return MINT; // the fold
  return null;
}
function render(size) {
  const ss = 4, px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const c = sample((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
      if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
    }
    const n = ss * ss, i = (y * size + x) * 4;
    if (a) { px[i] = r / (a / 255); px[i + 1] = g / (a / 255); px[i + 2] = b / (a / 255); }
    px[i + 3] = a / n;
  }
  return png(size, px);
}
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map(render);
const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const dir = sizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e[0] = s === 256 ? 0 : s; e[1] = s === 256 ? 0 : s; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(pngs[i].length, 8); e.writeUInt32LE(offset, 12); offset += pngs[i].length;
  return e;
});
const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.ico'), Buffer.concat([header, ...dir, ...pngs]));
fs.writeFileSync(path.join(outDir, 'icon.png'), pngs[pngs.length - 1]);

// ---- App-store style icons: the mark in white on a teal tile.
//  mac:  rounded tile inset on a transparent 1024 canvas (Apple's macOS icon grid: 824px tile, ~185px radius)
//  full: opaque full-bleed square for iOS and Android, which mask the corners themselves (iOS rejects alpha)
//  fg:     transparent white mark sized for Android's adaptive-icon safe zone (66 of 108dp), on a teal background
//  round:  circular legacy Android icon
//  splash: small teal mark centred on a pale square, for launch screens
const SHEET = { mac: 0.78, full: 0.9, fg: 0.66, round: 0.78, splash: 0.24 };
function tile(u, v, kind) {
  const inset = kind === 'mac' ? 100 / 1024 : 0, rad = kind === 'mac' ? 185 / 1024 : 0;
  const x0 = inset, x1 = 1 - inset;
  if (u < x0 || u > x1 || v < x0 || v > x1) return null;
  if (rad) {
    const cx = Math.min(Math.max(u, x0 + rad), x1 - rad), cy = Math.min(Math.max(v, x0 + rad), x1 - rad);
    if (Math.hypot(u - cx, v - cy) > rad) return null;
  }
  if (kind === 'round' && Math.hypot(u - 0.5, v - 0.5) > 0.5) return null;
  const k = SHEET[kind]; // mark size relative to the 0..1 glyph canvas
  const g = sample(0.5 + (u - 0.5) / k, 0.5 + (v - 0.5) / k, kind !== 'splash');
  if (g) return g;
  if (kind === 'fg') return null;
  if (kind === 'splash') return BG;
  const t = (v - x0) / (x1 - x0); // vertical gradient: brighter teal at the top to deep teal at the bottom
  return [Math.round(20 - 10 * t), Math.round(140 - 50 * t), Math.round(134 - 40 * t), 255];
}
const BG = [242, 249, 248, 255]; // launch-screen background (#F2F9F8)
function renderTile(size, kind, ss = 3) {
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const c = tile((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size, kind);
      if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
    }
    const n = ss * ss, i = (y * size + x) * 4;
    if (a) { px[i] = r / (a / 255); px[i + 1] = g / (a / 255); px[i + 2] = b / (a / 255); }
    const opaque = kind === 'full' || kind === 'splash';
    px[i + 3] = opaque ? 255 : a / n;
    if (opaque && !a) { px[i] = px[i + 1] = px[i + 2] = 255; }
  }
  return png(size, px);
}
fs.writeFileSync(path.join(outDir, 'icon-mac.png'), renderTile(1024, 'mac'));
fs.writeFileSync(path.join(outDir, 'icon-app.png'), renderTile(1024, 'full'));
fs.writeFileSync(path.join(outDir, 'icon-fg.png'), renderTile(432, 'fg'));
fs.writeFileSync(path.join(outDir, 'icon-round.png'), renderTile(192, 'round'));
fs.writeFileSync(path.join(outDir, 'splash.png'), renderTile(2732, 'splash', 2));

// macOS .icns (needs the macOS sips/iconutil tools; skipped elsewhere)
if (process.platform === 'darwin') {
  const { execFileSync } = require('child_process');
  const set = path.join(outDir, 'icon.iconset');
  fs.rmSync(set, { recursive: true, force: true });
  fs.mkdirSync(set);
  for (const s of [16, 32, 128, 256, 512]) {
    for (const [scale, suffix] of [[1, ''], [2, '@2x']]) {
      execFileSync('sips', ['-z', String(s * scale), String(s * scale), path.join(outDir, 'icon-mac.png'), '--out', path.join(set, `icon_${s}x${s}${suffix}.png`)], { stdio: 'ignore' });
    }
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(outDir, 'icon.icns')]);
  fs.rmSync(set, { recursive: true, force: true });
}
console.log('icon written');
