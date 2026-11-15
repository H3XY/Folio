// Builds Folio's desktop packages into dist/. (Kept in JS: cmd.exe would eat the ^ in CLI ignore patterns.)
//
//   node scripts/package.js           Windows   dist/Folio-win32-x64/Folio.exe
//   node scripts/package.js --mac     macOS     dist/Folio-darwin-<arch>/Folio.app    (unsigned, for local use)
//   node scripts/package.js --mas     Mac App Store  dist/Folio-mas-universal/Folio.app (+ Folio.pkg when signed)
//   node scripts/package.js --dmg     macOS direct download  dist/Folio-darwin-universal/Folio.app + dist/Folio.dmg
//
// Signing is driven by environment variables (all optional; without them the build is unsigned):
//   FOLIO_APPLE_TEAM_ID          10-character team ID, used in the App Store entitlements
//   FOLIO_MAS_APP_IDENTITY       e.g. "Apple Distribution: Your Name (TEAMID)"
//   FOLIO_MAS_INSTALLER_IDENTITY e.g. "3rd Party Mac Developer Installer: Your Name (TEAMID)"
//   FOLIO_MAS_PROFILE            path to the Mac App Store .provisionprofile for com.h3xy.folio
//   FOLIO_DEVID_IDENTITY         e.g. "Developer ID Application: Your Name (TEAMID)"
//   APPLE_ID, APPLE_APP_PASSWORD notarization (an app-specific password from appleid.apple.com)
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { packager } = require('@electron/packager');

const root = path.join(__dirname, '..');
const env = process.env;
fs.copyFileSync(path.join(root, 'build', 'icon.png'), path.join(root, 'app', 'icon.png'));

const mode = process.argv.includes('--mas') ? 'mas' : process.argv.includes('--dmg') ? 'dmg' : process.argv.includes('--mac') ? 'mac' : 'win';
const apple = mode !== 'win';
const OPENS = ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'doc', 'docx', 'rtf', 'odt', 'xls', 'xlsx', 'csv', 'ods', 'ppt', 'pptx', 'odp', 'html', 'htm', 'txt'];
const VERSION = require(path.join(root, 'package.json')).version;

// Mac App Store entitlements need the real team ID in place of the TEAMID placeholder.
function masEntitlements() {
  const team = env.FOLIO_APPLE_TEAM_ID || 'TEAMID';
  const out = path.join(os.tmpdir(), 'folio-entitlements.mas.plist');
  fs.writeFileSync(out, fs.readFileSync(path.join(root, 'build', 'mac', 'entitlements.mas.plist'), 'utf8').replaceAll('TEAMID', team));
  return out;
}

function osxSign() {
  if (mode === 'mas' && env.FOLIO_MAS_APP_IDENTITY) {
    return {
      identity: env.FOLIO_MAS_APP_IDENTITY,
      provisioningProfile: env.FOLIO_MAS_PROFILE,
      optionsForFile: (file) => ({
        entitlements: file.endsWith('Folio.app') ? masEntitlements() : path.join(root, 'build', 'mac', 'entitlements.mas.inherit.plist'),
        hardenedRuntime: false,
      }),
    };
  }
  if (mode === 'dmg' && env.FOLIO_DEVID_IDENTITY) {
    return {
      identity: env.FOLIO_DEVID_IDENTITY,
      optionsForFile: () => ({ entitlements: path.join(root, 'build', 'mac', 'entitlements.dmg.plist'), hardenedRuntime: true }),
    };
  }
  return undefined;
}

const notarize = mode === 'dmg' && env.FOLIO_DEVID_IDENTITY && env.APPLE_ID && env.APPLE_APP_PASSWORD
  ? { appleId: env.APPLE_ID, appleIdPassword: env.APPLE_APP_PASSWORD, teamId: env.FOLIO_APPLE_TEAM_ID }
  : undefined;

packager({
  dir: root,
  name: 'Folio',
  platform: mode === 'mas' ? 'mas' : apple ? 'darwin' : 'win32',
  arch: mode === 'mac' ? process.arch : apple ? 'universal' : 'x64',
  out: path.join(root, 'dist'),
  overwrite: true,
  icon: path.join(root, 'build', apple ? 'icon.icns' : 'icon.ico'),
  appVersion: VERSION,
  buildVersion: env.FOLIO_BUILD_NUMBER || VERSION,
  appBundleId: 'com.h3xy.folio',
  appCategoryType: 'public.app-category.productivity',
  // "Open With > Folio" in Finder; PDFs list Folio as an editor
  extendInfo: apple ? {
    CFBundleDocumentTypes: [
      { CFBundleTypeName: 'PDF document', CFBundleTypeRole: 'Editor', LSHandlerRank: 'Alternate', LSItemContentTypes: ['com.adobe.pdf'] },
      { CFBundleTypeName: 'Document', CFBundleTypeRole: 'Viewer', LSHandlerRank: 'Alternate', CFBundleTypeExtensions: OPENS.filter((e) => e !== 'pdf') },
    ],
    ITSAppUsesNonExemptEncryption: false, // only signatures/hashes and password-protecting the user's own key file
    LSMinimumSystemVersion: '12.0',
  } : undefined,
  osxSign: osxSign(),
  osxNotarize: notarize,
  prune: true,
  ignore: [/^\/dist(\/|$)/, /^\/release(\/|$)/, /^\/scripts(\/|$)/, /^\/build(\/|$)/, /^\/\.dump(\/|$)/, /^\/\.claude(\/|$)/,
    /^\/README\.md$/, /^\/ROADMAP\.md$/, /^\/docs(\/|$)/, /^\/store(\/|$)/, /^\/ios(\/|$)/, /^\/android(\/|$)/, /^\/capacitor\.config\.json$/,
    // mobile-only bundles: the desktop runs the same code from lib/ in its main process
    /^\/app\/vendor\/(folio-export|folio-sign|capacitor)\.js/],
  win32metadata: { CompanyName: 'Folio', FileDescription: 'Folio PDF editor', ProductName: 'Folio' },
  appCopyright: `Copyright © ${new Date().getFullYear()} Folio`,
}).then((paths) => {
  console.log('Wrote', paths.join(', '));
  const app = path.join(paths[0], 'Folio.app');
  if (mode === 'mas' && env.FOLIO_MAS_INSTALLER_IDENTITY) {
    const pkg = path.join(root, 'dist', 'Folio.pkg');
    execFileSync('productbuild', ['--component', app, '/Applications', '--sign', env.FOLIO_MAS_INSTALLER_IDENTITY, pkg], { stdio: 'inherit' });
    console.log('Wrote', pkg, '- upload it with Transporter or `xcrun altool --upload-app`.');
  }
  if (mode === 'dmg') {
    const dmg = path.join(root, 'dist', 'Folio.dmg');
    fs.rmSync(dmg, { force: true });
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-dmg-'));
    fs.cpSync(app, path.join(stage, 'Folio.app'), { recursive: true, verbatimSymlinks: true });
    fs.symlinkSync('/Applications', path.join(stage, 'Applications'));
    execFileSync('hdiutil', ['create', '-volname', 'Folio', '-srcfolder', stage, '-ov', '-format', 'UDZO', dmg], { stdio: 'inherit' });
    fs.rmSync(stage, { recursive: true, force: true });
    if (env.FOLIO_DEVID_IDENTITY) execFileSync('codesign', ['--sign', env.FOLIO_DEVID_IDENTITY, '--timestamp', dmg], { stdio: 'inherit' });
    if (notarize) {
      execFileSync('xcrun', ['notarytool', 'submit', dmg, '--apple-id', env.APPLE_ID, '--password', env.APPLE_APP_PASSWORD, '--team-id', env.FOLIO_APPLE_TEAM_ID, '--wait'], { stdio: 'inherit' });
      execFileSync('xcrun', ['stapler', 'staple', dmg], { stdio: 'inherit' });
    }
    console.log('Wrote', dmg, notarize ? '(signed and notarized)' : '(unsigned)');
  }
}).catch((e) => { console.error(e); process.exit(1); });
