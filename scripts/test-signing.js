const os = require('os'), path = require('path'), fs = require('fs');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { createStore, verifyPdf } = require('../lib/signing');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-ids-'));
  const store = createStore(dir);
  let t = Date.now();
  const id = store.create({ name: 'Test Signer', org: 'Folio QA', email: 'qa@example.com', password: 'secret123' });
  console.log('created', id.name, id.selfSigned, `${Date.now() - t}ms`);
  const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
  d.addPage([612, 792]).drawText('Contract text', { x: 72, y: 700, size: 14, font: f });
  const signed = await store.sign({ data: await d.save(), pageIndex: 0, rect: [72, 100, 252, 148], id: id.id, password: 'secret123', reason: 'Approval', location: 'Office' });
  fs.writeFileSync(path.join(dir, 'signed.pdf'), signed);
  console.log('verify signed:', JSON.stringify(verifyPdf(signed)));
  // wrong password
  try { await store.sign({ data: await d.save(), pageIndex: 0, rect: [0,0,10,10], id: id.id, password: 'nope' }); } catch (e) { console.log('wrong pw ->', e.message); }
  // tamper one byte inside signed range
  const bad = Buffer.from(signed); const at = bad.indexOf('/MediaBox'); bad[at + 12] = bad[at + 12] === 48 ? 49 : 48; console.log('tamper at', at);
  const vb = verifyPdf(bad)[0]; console.log('tampered: intact=', vb.intact, 'error=', vb.error || '');
  // incremental update appended after signing
  const inc = Buffer.concat([signed, Buffer.from('\n1 0 obj\n<<>>\nendobj\n%%EOF\n')]);
  const vi = verifyPdf(inc)[0]; console.log('appended: intact=', vi.intact, 'coversAll=', vi.coversAll);
  // import roundtrip
  const p12 = fs.readFileSync(path.join(dir, id.id + '.p12'));
  console.log('import ok:', store.importFile(p12, 'secret123').name);
  try { store.importFile(p12, 'bad'); } catch (e) { console.log('import bad pw ->', e.message); }
  console.log('ids:', store.list().length);
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
