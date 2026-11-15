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

## Platforms

| Platform | Shell | Store | Status |
|---|---|---|---|
| Windows | Electron | GitHub release now; **Microsoft Store** next (MS signs the package, which ends the SmartScreen warning) | shipping |
| macOS | Electron (`npm start`) | Mac App Store (sandboxed MAS build) + notarized DMG | runs; store build TODO |
| iPhone / iPad | Capacitor (`npm run ios`) | App Store | runs in simulator |
| Android | Capacitor (`npm run android`) | Google Play | project generated |

All platforms share the same UI in `app/`. Native access goes through one bridge, `window.folio`:
`preload.js` + `lib/` on desktop, `app/mobile.js` on iOS/Android.

## Phase 1 — mobile parity for the core (next)

- [ ] **Signing on mobile**: bundle `lib/signing.js` (node-forge + @signpdf) for the browser with esbuild; keep
      digital IDs in the iOS Keychain / Android Keystore.
- [ ] **Office export on mobile**: bundle `lib/convert.js` `exportDoc` (docx, exceljs, pptxgenjs are browser-safe).
- [ ] **Open from Files / "Open in Folio"**: register PDF document types (iOS `CFBundleDocumentTypes`,
      Android intent filters) and feed them to `onOpenFiles`.
- [ ] **Fonts on mobile**: bundle metric-compatible OFL fonts (Liberation Sans/Serif/Mono, Carlito) so edited text
      matches Arial/Times/Courier/Calibri without the system fonts.
- [ ] **Touch UX**: pinch-zoom on the page canvas, larger hit targets, long-press for "select more",
      bottom sheet instead of the right-hand inspector on phones.
- [ ] App icon and splash screens for iOS/Android (from `build/icon`).

## Phase 2 — store readiness

- [ ] Apple Developer Program ($99/yr), App Store Connect record, bundle id `com.h3xy.folio` (change before first
      upload if you want another), privacy nutrition label: "Data Not Collected".
- [ ] Google Play developer account ($25 once). New personal accounts must run a **closed test with 12+ testers
      for 14 days** before production access — start this early.
- [ ] Mac App Store build: `electron-builder`/`@electron/osx-sign` with the MAS entitlements (sandbox,
      user-selected files read/write), and a notarized DMG for direct download.
- [ ] Microsoft Store (MSIX) submission.
- [ ] Privacy policy page (short: no data collected, no network access).
- [ ] Store screenshots for each device class, made from Folio's own UI.

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
