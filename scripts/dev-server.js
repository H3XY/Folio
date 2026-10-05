// Tiny static server for testing the UI in a browser: node scripts/dev-server.js
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', 'app');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.gz': 'application/gzip' };
const dumpDir = process.env.FOLIO_DUMP_DIR;
http.createServer((req, res) => {
  // test hook: POST /__dump/<name> saves the body (used to hand export models to the Node writers)
  if (req.method === 'POST' && req.url.startsWith('/__dump/') && dumpDir) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { fs.writeFileSync(path.join(dumpDir, path.basename(req.url)), Buffer.concat(chunks)); res.end('ok'); });
    return;
  }
  const p = path.normalize(path.join(root, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0])));
  if (!p.startsWith(root) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(p).pipe(res);
}).listen(5178, () => console.log('http://localhost:5178'));
