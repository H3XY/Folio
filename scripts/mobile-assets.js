// Copies Folio's icon and launch screen into the iOS and Android projects (replacing Capacitor's placeholders).
// Run `npm run icon` first. Uses macOS `sips` for resizing.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const build = (f) => path.join(root, 'build', f);
const sips = (...args) => execFileSync('sips', args, { stdio: 'ignore' });
const resize = (src, size, out) => sips('-z', String(size), String(size), src, '--out', out);
// Scale the square splash to cover w x h, then centre-crop.
const cover = (src, w, h, out) => { const s = Math.max(w, h); resize(src, s, out); sips('--cropToHeightWidth', String(h), String(w), out); };

for (const f of ['icon-app.png', 'icon-fg.png', 'icon-round.png', 'splash.png']) {
  if (!fs.existsSync(build(f))) { console.error(`Missing build/${f}; run npm run icon first.`); process.exit(1); }
}

// ---- iOS: one 1024px universal icon + the launch image (light, dark and "any" slots)
const ios = path.join(root, 'ios', 'App', 'App', 'Assets.xcassets');
if (fs.existsSync(ios)) {
  fs.copyFileSync(build('icon-app.png'), path.join(ios, 'AppIcon.appiconset', 'AppIcon-512@2x.png'));
  for (const f of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
    fs.copyFileSync(build('splash.png'), path.join(ios, 'Splash.imageset', f));
  }
  console.log('iOS icon and splash updated');
}

// ---- Android: legacy + round launcher PNGs, adaptive foreground, background colour, splash per density
const res = path.join(root, 'android', 'app', 'src', 'main', 'res');
if (fs.existsSync(res)) {
  const DENSITY = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [d, k] of Object.entries(DENSITY)) {
    const dir = path.join(res, `mipmap-${d}`);
    resize(build('icon-app.png'), 48 * k, path.join(dir, 'ic_launcher.png'));
    resize(build('icon-round.png'), 48 * k, path.join(dir, 'ic_launcher_round.png'));
    resize(build('icon-fg.png'), 108 * k, path.join(dir, 'ic_launcher_foreground.png'));
  }
  fs.writeFileSync(path.join(res, 'values', 'ic_launcher_background.xml'),
    '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#0E7471</color>\n</resources>\n');
  for (const dir of fs.readdirSync(res).filter((d) => /^drawable/.test(d))) {
    const f = path.join(res, dir, 'splash.png');
    if (!fs.existsSync(f)) continue;
    const w = +execFileSync('sips', ['-g', 'pixelWidth', f]).toString().match(/pixelWidth: (\d+)/)[1];
    const h = +execFileSync('sips', ['-g', 'pixelHeight', f]).toString().match(/pixelHeight: (\d+)/)[1];
    cover(build('splash.png'), w, h, f);
  }
  console.log('Android icons and splash updated');
}
