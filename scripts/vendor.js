// Copies the browser-side libraries into app/vendor so the app runs fully offline.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const out = path.join(root, 'app', 'vendor');
const nm = (p) => path.join(root, 'node_modules', p);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'tesseract', 'core'), { recursive: true });
fs.mkdirSync(path.join(out, 'tesseract', 'lang'), { recursive: true });
for (const [src, dst] of [
  ['pdfjs-dist/build/pdf.min.js', 'pdf.min.js'],
  ['pdfjs-dist/build/pdf.worker.min.js', 'pdf.worker.min.js'],
  ['pdf-lib/dist/pdf-lib.min.js', 'pdf-lib.min.js'],
  ['@pdf-lib/fontkit/dist/fontkit.umd.min.js', 'fontkit.umd.min.js'],
  ['tesseract.js/dist/tesseract.min.js', 'tesseract/tesseract.min.js'],
  ['tesseract.js/dist/worker.min.js', 'tesseract/worker.min.js'],
  ['@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'tesseract/lang/eng.traineddata.gz'],
]) fs.copyFileSync(nm(src), path.join(out, dst));
// OCR engine builds: the LSTM engine, with and without SIMD (the worker picks one at runtime)
for (const f of fs.readdirSync(nm('tesseract.js-core'))) {
  if (/^tesseract-core(-simd)?-lstm\.wasm\.js$/.test(f)) fs.copyFileSync(path.join(nm('tesseract.js-core'), f), path.join(out, 'tesseract', 'core', f));
}
fs.cpSync(nm('pdfjs-dist/cmaps'), path.join(out, 'cmaps'), { recursive: true });
fs.cpSync(nm('pdfjs-dist/standard_fonts'), path.join(out, 'standard_fonts'), { recursive: true });
console.log('vendored into', out);
