# Store listings and submission checklist

Everything here is ready to paste into App Store Connect, Google Play Console and Microsoft Partner Center.
Screenshots are in `store/screenshots/`. The privacy policy is `PRIVACY.md`; use its GitHub URL
(https://github.com/H3XY/Folio/blob/main/PRIVACY.md) as the privacy policy URL, or host it on a site of your own.

Wording rules (see ROADMAP.md "Ground rules"): no other company's product names in the title, subtitle, keywords or
screenshots. Before launch, settle the final name (the USPTO check in ROADMAP.md found a pending FOLIO mark for
note-taking software) and have the listing reviewed once.

## Listing text (all stores)

**Name** (App Store max 30 / Play max 30): `Folio: Offline PDF Editor`

**Subtitle** (App Store, max 30): `Edit, sign & fill PDFs offline`

**Short description** (Play, max 80):
`Edit, annotate, sign and fill PDFs on your device. No account, no uploads.`

**Promotional text** (App Store, max 170):
`Everything you need to work with PDFs — edit text, fill forms, sign, combine and convert — and your files never
leave your device.`

**Description** (App Store / Play / Microsoft Store, max 4000):

> Folio is a complete PDF editor that works entirely on your device. There's no account to create, nothing is
> uploaded, and it works without an internet connection.
>
> COMMENT AND MARK UP
> • Highlight, underline and add text, arrows, lines, boxes and freehand drawings
> • Select several marks and align or distribute them neatly
> • Redact: permanently remove sensitive text, not just cover it
>
> EDIT
> • Change existing text in place, keeping the original font and size
> • Move, resize and delete images; crop pages
> • Headers, footers, page numbers, Bates numbering and watermarks
> • Reorder, rotate, duplicate, extract and delete pages
>
> FILL AND SIGN
> • Fill in form fields, check boxes and dropdowns
> • Draw or type your signature in one of several handwriting styles, and add initials, dates and check marks
> • Sign with a digital ID (certificate) and check the signatures in documents you receive
>
> CONVERT
> • Export to Word, Excel, PowerPoint, images or text
> • Combine PDFs and images into one document
> • Recognize text in scanned pages (OCR)
>
> PRIVATE BY DESIGN
> Folio has no servers and collects no data. Your documents, signatures and digital IDs stay on your device unless
> you choose to share them.

**Keywords** (App Store, max 100, comma-separated, no spaces needed):
`pdf,editor,sign,signature,fill,form,annotate,redact,ocr,scan,merge,convert,offline,private,document`

**Category**: Productivity (secondary: Business)

**Support URL**: https://github.com/H3XY/Folio/issues  **Marketing URL** (optional): https://github.com/H3XY/Folio

**Copyright**: `2026 <your legal name or company>`

## Questionnaires

**Apple — App Privacy**: "Data Not Collected". (The bundled privacy manifest `ios/App/App/PrivacyInfo.xcprivacy`
declares no tracking and no collected data.)

**Apple — Export compliance**: Folio uses cryptography only to create and verify digital signatures and to protect
the user's own digital-ID file with a password. That is generally exempt (authentication / integrity), so
"Does your app use encryption?" → Yes, "exempt" → **confirm this with Apple's export guidance or a lawyer before
answering**; the Mac build already declares `ITSAppUsesNonExemptEncryption = NO`. Add the same key to the iOS
Info.plist once you've confirmed.

**Google Play — Data safety**: No data collected, no data shared. "Is all user data encrypted in transit?" →
Not applicable (no data leaves the device). "Can users request deletion?" → No data is collected.

**Content / age rating**: no user-generated content shared with others, no ads, no purchases → rated 4+ / Everyone.

**Microsoft Store — Privacy**: "This app does not access, collect or transmit personal information" is not quite
right because it reads documents the user opens; answer that it accesses the user's files only on the device and
link `PRIVACY.md`.

## What you need to do (accounts and signing are tied to you)

### Apple (iPhone, iPad, Mac App Store) — $99/year
1. Enrol at developer.apple.com/programs (individual, or an organization with a D-U-N-S number).
2. In Certificates, Identifiers & Profiles: register the App ID `com.h3xy.folio` (enable nothing extra), then create
   an **Apple Distribution** certificate, a **Mac Installer Distribution** certificate, and a
   **Mac App Store** provisioning profile for the App ID.
3. In App Store Connect: create one app record for iOS and macOS (same bundle ID), fill in the listing above.
4. iOS: open `ios/App/App.xcworkspace` (or `npm run ios`), choose your team under Signing & Capabilities, then
   Product › Archive › Distribute App › App Store Connect.
5. Mac: export the signing variables listed at the top of `scripts/package.js` and run `npm run package:mas`; upload
   `dist/Folio.pkg` with the Transporter app.
6. Optional direct download: create a **Developer ID Application** certificate and run `npm run package:dmg` with
   `FOLIO_DEVID_IDENTITY`, `APPLE_ID`, `APPLE_APP_PASSWORD` and `FOLIO_APPLE_TEAM_ID` set for a notarized DMG.

### Google Play — $25 once
1. Create a developer account at play.google.com/console (identity verification takes a few days).
2. Run `npm run android:keystore` once to make your upload key (keep the file and password safe), then
   `npm run android:bundle` → `android/app/build/outputs/bundle/release/app-release.aab`.
3. Create the app, opt in to Play App Signing, fill in the listing, Data safety and content rating.
4. New personal accounts must run a **closed test with at least 12 testers for 14 continuous days** before they can
   publish to production — upload the bundle to a closed testing track first and invite testers.

### Microsoft Store — free for individuals
1. Register at partner.microsoft.com (Windows apps).
2. Reserve the app name, then copy Package/Identity/Name, Publisher and Publisher display name from
   Product identity into repository variables `FOLIO_MSIX_NAME`, `FOLIO_MSIX_PUBLISHER`,
   `FOLIO_MSIX_PUBLISHER_DISPLAY` (GitHub › Settings › Secrets and variables › Actions › Variables).
3. Download the `Folio-msix-…` artifact from the next CI run and upload `Folio.msix` in a new submission. The Store
   signs it, which also removes the SmartScreen "unknown publisher" warning for Store installs.
