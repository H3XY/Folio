// Folio — desktop digital-ID storage (password-protected .p12 files plus JSON metadata in the user's app-data
// folder) around the shared signing code in lib/signing-core.js.
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const core = require('./signing-core');

function createStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const metaPath = (id) => path.join(dir, `${id}.json`);
  const p12Path = (id) => path.join(dir, `${id}.p12`);
  return core.createStore({
    async list() {
      return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
        try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; }
      });
    },
    async read(id) { return fs.existsSync(p12Path(id)) ? fs.readFileSync(p12Path(id)) : null; },
    async write(id, der, meta) {
      fs.writeFileSync(p12Path(id), der);
      fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));
    },
    async remove(id) {
      fs.rmSync(p12Path(id), { force: true });
      fs.rmSync(metaPath(id), { force: true });
    },
  });
}

const verifyPdf = (buf) => core.verifyPdf(buf, tls.rootCertificates);

module.exports = { createStore, verifyPdf };
