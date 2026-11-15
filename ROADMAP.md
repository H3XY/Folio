# Folio roadmap

Goal: a full-featured PDF editor at parity with the big commercial suites — on Windows, macOS, iPhone/iPad and
Android — that stays offline and keeps files on the device.

## Ground rules (avoiding trademark and trade-dress trouble)

Matching *features* and *workflows* is fine: PDF is an open ISO standard (ISO 32000), and nobody owns "edit text",
"fill and sign" or "combine files". What we must not copy is a competitor's identity:

- **Names and marks.** Never use "Adobe", "Acrobat", "Reader", "Document Cloud" (or any other company's marks) in the
  app name, icon, store title, subtitle, keywords or screenshots. A plain factual line such as "opens PDFs created in
  any app" is fine; "Acrobat alternative" in store keywords is not.
- **Look.** No red PDF-glyph icon, no copied toolbar icons, illustrations, colour scheme or exact screen layouts.
  Folio keeps its own teal identity, its own folded-F logo and its own icon set (all drawn in `app/app.js` `ICONS`).
- **Assets.** Only fonts and libraries with permissive licences (MIT/Apache/OFL). No proprietary fonts
  (e.g. Myriad, Minion) bundled. Licences ship next to vendored files.
- **Claims.** No "certified", "compatible with X" or "approved" claims we can't back up; no comparisons that use
  another product's screenshots.
- Have a lawyer review the store listings and marketing copy once before the first public launch.

### USPTO check of the name "Folio" (2026-11-14, informal — not legal advice)

No live US mark "FOLIO" covers PDF or document-editing software. The ones nearest to our field:

| Mark | Serial | Status | Goods | Risk |
|---|---|---|---|---|
| FOLIO (Folio Works) | 50060413 | Pending (filed Aug 2026) | Class 9/42 note-taking and meeting software; organizing, searching, sharing business information | **Highest**: related productivity software |
| FOLIO (Bauer Types) | 98652990, 75942264 | Registered | Class 9/42 font software | Moderate: software, different purpose |
| PEPPER FOLIO (Vodori) | 87547408 | Registered | Class 42 SaaS for reviewing regulated content | Low: compound mark |
| FOLIO BOOKS / FOLIO SOCIETY | 79450248, 79451994 | Pending | Class 9 e-publications | Low |
| SMART FOLIO (Apple), other *FOLIO cases | — | Registered | Device cases | Low: unrelated goods |

Many other FOLIO marks are finance, fabric, cutlery, watches and so on (unrelated). Before filing or launching:
watch Folio Works' application, consider a distinctive store name such as "Folio PDF Editor" or a coined name, and
get a clearance opinion from a trademark attorney (also check the App Store and Google Play for apps named Folio).

## Platforms

| Platform | Shell | Store | Status |
|---|---|---|---|
| Windows | Electron | GitHub release now; **Microsoft Store** next (MS signs the package, which ends the SmartScreen warning) | shipping |
| macOS | Electron (`npm start`) | Mac App Store (sandboxed MAS build) + notarized DMG | runs; store build TODO |
| iPhone / iPad | Capacitor (`npm run ios`) | App Store | runs in simulator |
| Android | Capacitor (`npm run android`) | Google Play | project generated |

All platforms share the same UI in `app/`. Native access goes through one bridge, `window.folio`:
`preload.js` + `lib/` on desktop, `app/mobile.js` on iOS/Android.

## Phase 1 — mobile parity for the core

- [x] **Signing on mobile**: `lib/signing-core.js` is shared by desktop and a browser bundle
      (`app/vendor/folio-sign.js`, built by `scripts/build-mobile.js`) with Node's trusted roots baked in.
      Digital IDs (password-protected .p12) live in the iOS Keychain / Android Keystore-backed storage
      (`@aparajita/capacitor-secure-storage`, this-device-only, never synced); older file-based IDs migrate.
  - [ ] Create an ID and sign on a real phone (the bundle signs and verifies in a browser page, and the dialog reads
        the Keychain on the simulator, but simulator keyboard input was too unreliable to finish the flow).
- [x] **Office export on mobile**: `lib/export.js` (docx, exceljs, pptxgenjs) shared by desktop and
      `app/vendor/folio-export.js`; files go out through the share sheet. Verified on the iPhone simulator.
- [x] **Open from Files / "Open in Folio"**: iOS `CFBundleDocumentTypes` (Folio appears in the share sheet) and an
      Android VIEW intent filter; files arrive through the Capacitor App plugin. Verified on iOS, cold start.
  - [x] Appear under Files' "Open With" too: `LSSupportsOpeningDocumentsInPlace`, with the scene delegate copying
        the security-scoped original into a private temp copy (the original is never written).
- [x] **Fonts on mobile**: Arimo / Tinos / Cousine / Carlito (OFL, metric-compatible with Arial / Times New Roman /
      Courier New / Calibri) bundled; also fill in missing system fonts on desktop (Calibri on macOS).
- [x] **Touch UX**: pinch-zoom of the document (keeps the point under the fingers), one-finger scrolling with the
      Select tool, long-press to add marks to a selection, bottom-sheet inspector on phones, dialogs open without
      the keyboard.
- [x] App icon and splash screens for iOS/Android.
- [x] Text / Markdown → PDF on mobile (drawn with pdf-lib, no browser engine needed).
- [ ] HTML and Office → PDF on mobile: needs a layout engine phones don't offer offline (desktop uses Chromium,
      Office or LibreOffice). Desktop-only for now; the Create PDF dialog says so.

## Phase 2 — store readiness

Everything that can be prepared in the repo is done; what's left needs accounts, fees and signing identities that
belong to you. Step-by-step instructions and paste-ready listing text: `store/LISTING.md`.

- [x] Privacy policy: `PRIVACY.md` (no data collected, no network access).
- [x] Listing text, keywords, questionnaire answers and screenshots (`store/`): iPhone 6.9", iPad 13", Android
      phone, Mac 2880×1800.
- [x] iOS: privacy manifest (`PrivacyInfo.xcprivacy`, no tracking / no data), Release build compiles for devices,
      `npm run ios:archive`.
- [x] Android: release signing from an untracked `android/keystore.properties` (`npm run android:keystore` makes
      the upload key), backups off, `npm run android:bundle` → `.aab`.
- [x] Mac App Store: sandbox entitlements (`build/mac/`), universal `npm run package:mas` (+ signed `.pkg` when the
      certificates are set), and a notarizable `npm run package:dmg` for direct download. LibreOffice conversion is
      disabled inside the sandbox.
- [x] Microsoft Store: `build/appx/AppxManifest.xml` + `scripts/make-msix.ps1`; CI builds `Folio.msix` on every run.
- [ ] **You**: Apple Developer Program ($99/yr) → certificates, App Store Connect record, upload.
- [ ] **You**: Google Play account ($25) → upload key, closed test with **12+ testers for 14 days**, then production.
- [ ] **You**: Microsoft Partner Center → reserve the name, set the 3 identity variables, submit the MSIX.
- [ ] **You**: confirm the export-compliance answer (encryption exemption) and the final app name.
- [ ] Re-take the iPhone document screenshot after this change (the welcome text now says "Tap the folder button"
      on phones instead of "Cmd+O").

## Phase 3 — feature parity with commercial PDF suites

Brand: the folded-F mark (scripts/make-icon.js, also inline in app/index.html) is our own design; keep it distinct from other PDF apps.

Already in Folio: comments & markup, text/image editing, crop, header/footer, Bates, watermark, fill & sign,
certificate signatures + validation, forms filling, combine, convert to/from Office, OCR, redaction,
page organise, signature styles, align & distribute.

Gaps, roughly by user value:

- [ ] **Compare two PDFs** (text diff + visual overlay)
- [ ] **Form creation**: add text fields, checkboxes, dropdowns, signature fields; auto-detect fields
- [ ] **Request signatures / signing order** (offline: export a "sign here" package; online flows are out of scope
      while Folio stays offline)
- [ ] **Bookmarks / outline editing**, links, page labels
- [ ] **Comments panel**: list, reply, mark resolved, sticky notes, stamps (Approved, Draft...), import/export FDF/XFDF
- [ ] **Protect**: password open/permissions (AES-256), remove hidden info / sanitize metadata
- [ ] **Accessibility**: tag PDFs, reading order, alt text, accessibility checker
- [ ] **Print production**: preflight, PDF/A and PDF/X conversion and validation
- [ ] **Scan & enhance**: camera capture on mobile, perspective correction, OCR to searchable PDF
- [ ] **Reflow / "liquid mode"** reading view on phones
- [ ] **Measure tools** (distance, area, perimeter) for drawings
- [ ] **Batch actions** (watermark/OCR/compress many files)
- [ ] Multi-language OCR packs (downloaded as optional in-app assets)

## Engineering hygiene

- [ ] Pin Node 22 LTS (`.nvmrc`): on Node 26 Electron's postinstall silently fails to unpack its binary.
- [ ] `npm audit` reports issues in `node-forge` (used by signing) and `exceljs`' `uuid`; upgrade.
- [ ] CI: add macOS build, iOS simulator build and Android `assembleDebug` jobs next to the Windows build.
