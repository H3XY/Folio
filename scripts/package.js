// Builds dist/Folio-win32-x64, or with --mac dist/Folio-darwin-<arch>/Folio.app.
// (Kept in JS: cmd.exe would eat the ^ in CLI ignore patterns.)
const path = require('path');
const fs = require('fs');
const { packager } = require('@electron/packager');

const root = path.join(__dirname, '..');
fs.copyFileSync(path.join(root, 'build', 'icon.png'), path.join(root, 'app', 'icon.png'));

const mac = process.argv.includes('--mac');
const OPENS = ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'doc', 'docx', 'rtf', 'odt', 'xls', 'xlsx', 'csv', 'ods', 'ppt', 'pptx', 'odp', 'html', 'htm', 'txt'];

packager({
  dir: root,
  name: 'Folio',
  platform: mac ? 'darwin' : 'win32',
  arch: mac ? process.arch : 'x64',
  out: path.join(root, 'dist'),
  overwrite: true,
  icon: path.join(root, 'build', mac ? 'icon.icns' : 'icon.ico'),
  appBundleId: 'com.h3xy.folio',
  appCategoryType: 'public.app-category.productivity',
  // "Open With > Folio" in Finder; PDFs list Folio as an editor
  extendInfo: mac ? {
    CFBundleDocumentTypes: [
      { CFBundleTypeName: 'PDF document', CFBundleTypeRole: 'Editor', LSHandlerRank: 'Alternate', LSItemContentTypes: ['com.adobe.pdf'] },
      { CFBundleTypeName: 'Document', CFBundleTypeRole: 'Viewer', LSHandlerRank: 'Alternate', CFBundleTypeExtensions: OPENS.filter((e) => e !== 'pdf') },
    ],
  } : undefined,
  prune: true,
  ignore: [/^\/dist(\/|$)/, /^\/release(\/|$)/, /^\/scripts(\/|$)/, /^\/build(\/|$)/, /^\/\.dump(\/|$)/, /^\/\.claude(\/|$)/, /^\/README\.md$/, /^\/ios(\/|$)/, /^\/android(\/|$)/, /^\/capacitor\.config\.json$/, /^\/ROADMAP\.md$/],
  win32metadata: { CompanyName: 'Folio', FileDescription: 'Folio PDF editor', ProductName: 'Folio' },
  appCopyright: `Copyright © ${new Date().getFullYear()} Folio`,
}).then((paths) => console.log('Wrote', paths.join(', '))).catch((e) => { console.error(e); process.exit(1); });
