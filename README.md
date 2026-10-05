# Folio

Offline PDF editor for Windows (Electron + pdf.js + pdf-lib). No network access: the app blocks all web requests,
and every library, font lookup and the OCR engine run locally.

## Tool sets

- **Comment** – text, highlight, draw, arrows, lines, boxes, ellipses, images, whiteout, redaction.
- **Edit** – edit existing text in place (the original text operators are removed from the page and the
  replacement uses the matching installed font), move/resize/delete existing images, crop, header & footer
  with page numbers, Bates numbering, watermarks.
- **E-Sign** – Fill & Sign (signature, initials, text, date, ✓ ✗ ●) and certificate signatures
  (PKCS#7 detached / `adbe.pkcs7.detached`). Create a self-signed digital ID or import a `.pfx`/`.p12`.
  The Signatures panel validates signatures in opened files (integrity, signer, time, later changes, trust).
- **Convert** – export to Word, Excel, PowerPoint, PNG/JPEG, text; combine files (PDFs, images, Office,
  HTML, text) into one PDF with per-file page ranges and bookmarks; create PDFs from Office files, HTML and
  text; recognize text in scans (OCR, English); compress images.
- **Forms** – fill checkboxes, radio buttons, text fields and dropdowns directly on the page (or from the Forms tab).

## Build

    npm install
    npm run vendor     # copy pdf.js, pdf-lib, fontkit, Tesseract into app/vendor
    npm run icon       # regenerate build/icon.ico
    npm run package    # -> dist/Folio-win32-x64/Folio.exe

Install by copying `dist/Folio-win32-x64` to `%LOCALAPPDATA%\Programs\Folio` and pointing a shortcut at `Folio.exe`.

Tests: `npm run test:signing` (sign, tamper, append, import; cross-check with `openssl cms -verify`).

## Layout

- `main.js` – window, `app://` file server, network lockdown, open/save dialogs, unsaved-changes prompt
- `lib/ipc.js` – fonts, digital IDs, signing, conversion IPC
- `lib/signing.js` – digital ID store (`%APPDATA%\Folio\digital-ids`), signing, validation
- `lib/convert.js` – Office/HTML → PDF, PDF → .docx/.xlsx/.pptx writers
- `app/app.js` – viewer, annotations, pages, search, forms, export
- `app/contentstream.js` – content stream tokenizer/interpreter/rewriter used by Edit
- `app/edit.js`, `app/stamps.js`, `app/esign.js`, `app/convert.js`, `app/fonts.js` – feature modules

## Known limits

- Office → PDF needs Microsoft Office or LibreOffice on the PC (Folio drives it locally).
- Requesting signatures from other people by email (Acrobat Sign) needs a cloud service and is not included.
- Self-signed IDs show as "identity not verified" to others; IDs issued by a trusted authority validate fully.
  Windows certificate-store and smart-card IDs are not supported yet; export them to `.pfx` to use them.
- Edit text works on horizontal text drawn directly on the page; text inside form XObjects is covered and
  retyped instead. Edited paragraphs reflow inside their box; complex layouts may need manual adjustment.
- Word/PowerPoint export rebuilds layout heuristically (paragraphs, tables, images); multi-column pages are simplified.
- OCR is English only. Redacted pages are flattened to 200 dpi images on save. Form fields are flattened on save.
- Password-protected PDFs must be unlocked before opening.
