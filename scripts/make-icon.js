// Draws the Folio icon (teal sheet with folded corner) and writes build/icon.ico with PNG frames.
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
// Shape in unit coords (0..1): page body with a folded top-right corner and three text lines.
function sample(u, v) {
  const L = 0.2, R = 0.8, T = 0.1, B = 0.9, F = 0.2, r = 0.05;
  const inside = u >= L && u <= R && v >= T && v <= B;
  if (!inside) return null;
  // rounded bottom corners
  for (const [cx, cy] of [[L + r, B - r], [R - r, B - r], [L + r, T + r]]) {
    if ((u < L + r && cx === L + r || u > R - r && cx === R - r) && ((v > B - r && cy === B - r) || (v < T + r && cy === T + r))) {
      if (Math.hypot(u - cx, v - cy) > r) return null;
    }
  }
  const du = R - u, dv = v - T; // distance from top-right corner
  if (du + dv < F) return null; // cut corner
  if (du < F && dv < F && du + dv >= F && du + dv < F + 0.001) return [255, 255, 255, 255];
  if (du < F && dv < F) return [134, 214, 209, 255]; // fold flap
  // text lines
  for (const [y0, x1] of [[0.48, 0.7], [0.6, 0.7], [0.72, 0.56]]) {
    if (v > y0 && v < y0 + 0.045 && u > 0.3 && u < x1) return [232, 248, 246, 255];
  }
  return [11, 110, 108, 255];
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
console.log('icon written');
