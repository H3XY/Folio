// Mobile signing bundle: the shared core plus the certificate authorities Node trusts, baked in at build time
// (iOS/Android don't expose their trust stores to the web view).
const core = require('../../lib/signing-core');
const roots = require('./roots.generated.json');

module.exports = { createStore: core.createStore, verifyPdf: (buf) => core.verifyPdf(buf, roots), Buffer };
