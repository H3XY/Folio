// Bundles the Node-side features the mobile apps need into browser scripts in app/vendor, loaded on demand by
// app/mobile.js: folio-export.js (PDF -> Word/Excel/PowerPoint) and folio-sign.js (digital IDs and signatures).
// The desktop app never loads these; it runs the same lib/ code in its main process.
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const out = path.join(root, 'app', 'vendor');

const common = {
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  target: ['safari15', 'chrome100'],
  legalComments: 'linked',
  logLevel: 'warning',
  // Node built-ins some libraries reach for; Buffer comes from the `buffer` package.
  inject: [path.join(__dirname, 'mobile-shims', 'buffer.js')],
  define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"' },
};

function build() {
  fs.writeFileSync(path.join(__dirname, 'mobile-shims', 'roots.generated.json'), JSON.stringify(tls.rootCertificates));
  esbuild.buildSync({ ...common, entryPoints: [path.join(root, 'lib', 'export.js')], globalName: 'FolioExport', outfile: path.join(out, 'folio-export.js') });
  esbuild.buildSync({
    ...common,
    entryPoints: [path.join(__dirname, 'mobile-shims', 'sign-entry.js')],
    globalName: 'FolioSign',
    outfile: path.join(out, 'folio-sign.js'),
    alias: { crypto: path.join(__dirname, 'mobile-shims', 'crypto.js') },
  });
}

module.exports = build;
if (require.main === module) { build(); console.log('mobile bundles written'); }
