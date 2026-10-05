// Builds dist/Folio-win32-x64. (Kept in JS: cmd.exe would eat the ^ in CLI ignore patterns.)
const path = require('path');
const fs = require('fs');
const { packager } = require('@electron/packager');

const root = path.join(__dirname, '..');
fs.copyFileSync(path.join(root, 'build', 'icon.png'), path.join(root, 'app', 'icon.png'));

packager({
  dir: root,
  name: 'Folio',
  platform: 'win32',
  arch: 'x64',
  out: path.join(root, 'dist'),
  overwrite: true,
  icon: path.join(root, 'build', 'icon.ico'),
  prune: true,
  ignore: [/^\/dist(\/|$)/, /^\/release(\/|$)/, /^\/scripts(\/|$)/, /^\/build(\/|$)/, /^\/\.dump(\/|$)/, /^\/README\.md$/],
  win32metadata: { CompanyName: 'Folio', FileDescription: 'Folio PDF editor', ProductName: 'Folio' },
}).then((paths) => console.log('Wrote', paths.join(', '))).catch((e) => { console.error(e); process.exit(1); });
