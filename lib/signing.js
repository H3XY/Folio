// Folio — digital IDs, PDF signing (PKCS#7 detached / adbe.pkcs7.detached) and signature validation.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');
const forge = require('node-forge');
const { PDFDocument } = require('pdf-lib');
const { SignPdf } = require('@signpdf/signpdf');
const { P12Signer } = require('@signpdf/signer-p12');
const { pdflibAddPlaceholder } = require('@signpdf/placeholder-pdf-lib');

function createStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const metaPath = (id) => path.join(dir, `${id}.json`);
  const p12Path = (id) => path.join(dir, `${id}.p12`);
  const validId = (id) => /^[a-f0-9]{16}$/.test(id);

  function describe(cert) {
    const field = (attrs, sn) => attrs.getField(sn)?.value || '';
    return {
      name: field(cert.subject, 'CN') || field(cert.subject, 'O') || 'Unnamed',
      email: field(cert.subject, 'E') || cert.subject.attributes.find((a) => a.name === 'emailAddress')?.value || '',
      org: field(cert.subject, 'O'),
      issuer: field(cert.issuer, 'CN') || field(cert.issuer, 'O'),
      selfSigned: cert.isIssuer(cert),
      notBefore: cert.validity.notBefore.toISOString(),
      notAfter: cert.validity.notAfter.toISOString(),
    };
  }

  function readP12(buf, password) {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(buf.toString('binary')));
    const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
    const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || [];
    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
    if (!keyBags.length) throw new Error('This file has no private key, so it cannot be used to sign.');
    const key = keyBags[0].key;
    // the signing certificate is the one whose public key matches the private key
    const cert = certBags.map((b) => b.cert).find((c) => c.publicKey.n?.equals?.(key.n)) || certBags[0]?.cert;
    if (!cert) throw new Error('This file has no certificate.');
    return { key, cert };
  }

  return {
    list() {
      return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
        try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; }
      }).filter(Boolean).sort((a, b) => (a.created < b.created ? 1 : -1));
    },

    create({ name, org, email, password }) {
      const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
      const cert = forge.pki.createCertificate();
      cert.publicKey = keys.publicKey;
      cert.serialNumber = '01' + crypto.randomBytes(15).toString('hex');
      cert.validity.notBefore = new Date(Date.now() - 60 * 1000);
      cert.validity.notAfter = new Date();
      cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 5);
      const attrs = [{ shortName: 'CN', value: name }];
      if (org) attrs.push({ shortName: 'O', value: org });
      if (email) attrs.push({ name: 'emailAddress', value: email });
      cert.setSubject(attrs);
      cert.setIssuer(attrs);
      cert.setExtensions([
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, nonRepudiation: true },
        { name: 'extKeyUsage', emailProtection: true, codeSigning: false },
        { name: 'subjectKeyIdentifier' },
      ]);
      cert.sign(keys.privateKey, forge.md.sha256.create());
      const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des', friendlyName: name });
      const der = Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary');
      return this.store(der, describe(cert));
    },

    importFile(buf, password) {
      let parsed;
      try { parsed = readP12(buf, password); } catch (e) {
        if (/password|Invalid|MAC/i.test(e.message)) throw new Error('The password is wrong for this certificate file.');
        throw e;
      }
      return this.store(buf, describe(parsed.cert));
    },

    store(der, meta) {
      const id = crypto.randomBytes(8).toString('hex');
      fs.writeFileSync(p12Path(id), der);
      const full = { id, ...meta, created: new Date().toISOString() };
      fs.writeFileSync(metaPath(id), JSON.stringify(full, null, 2));
      return full;
    },

    remove(id) {
      if (!validId(id)) return;
      fs.rmSync(p12Path(id), { force: true });
      fs.rmSync(metaPath(id), { force: true });
    },

    async sign({ data, pageIndex, rect, id, password, reason, location }) {
      if (!validId(id) || !fs.existsSync(p12Path(id))) throw new Error('That digital ID is no longer available.');
      const p12 = fs.readFileSync(p12Path(id));
      let parsed;
      try { parsed = readP12(p12, password); } catch { throw new Error('The password for this digital ID is wrong.'); }
      if (parsed.cert.validity.notAfter < new Date()) throw new Error('This digital ID has expired.');
      const meta = describe(parsed.cert);
      const pdfDoc = await PDFDocument.load(Buffer.from(data), { updateMetadata: false });
      pdflibAddPlaceholder({
        pdfDoc,
        pdfPage: pdfDoc.getPage(pageIndex),
        reason: reason || 'I am the author of this document',
        contactInfo: meta.email || '',
        name: meta.name,
        location: location || '',
        signingTime: new Date(),
        widgetRect: rect,
        signatureLength: 16384,
        appName: 'Folio',
      });
      const withPlaceholder = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
      const signer = new P12Signer(p12, { passphrase: password });
      return new SignPdf().sign(withPlaceholder, signer);
    },
  };
}

// ---------------------------------------------------------------- validation
const DIGESTS = {
  [forge.pki.oids.sha1]: 'sha1', [forge.pki.oids.sha256]: 'sha256', [forge.pki.oids.sha384]: 'sha384', [forge.pki.oids.sha512]: 'sha512',
};
let roots = null;
function trustedRoots() {
  if (!roots) {
    roots = [];
    for (const pem of tls.rootCertificates) { try { roots.push(forge.pki.certificateFromPem(pem)); } catch { /* skip unparsable */ } }
  }
  return roots;
}

function verifyPdf(buf) {
  buf = Buffer.from(buf);
  const text = buf.toString('latin1');
  const out = [];
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  let m;
  while ((m = re.exec(text))) {
    const [a, b, c, d] = m.slice(1).map(Number);
    const sig = { index: out.length };
    out.push(sig);
    try {
      // Signature dictionary fields near the ByteRange
      // (the hex Contents sits between ByteRange parts, so look both before it and after it)
      const around = text.slice(Math.max(0, m.index - 3000), m.index + 600) + text.slice(c, c + 3000);
      const lit = (k) => {
        const mm = new RegExp(`/${k}\\s*\\(((?:\\\\.|[^\\\\)])*)\\)`).exec(around);
        return mm ? mm[1].replace(/\\([()\\])/g, '$1') : '';
      };
      sig.reason = lit('Reason');
      sig.location = lit('Location');
      const signed = Buffer.concat([buf.subarray(a, a + b), buf.subarray(c, c + d)]);
      let hex = text.slice(a + b, c).replace(/[<>\s]/g, '');
      if (hex.length % 2) hex += '0';
      // The placeholder is zero-padded; parse the first DER object and ignore the padding.
      const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(forge.util.hexToBytes(hex), { strict: false, parseAllBytes: false }));
      const raw = p7.rawCapture;
      const certs = p7.certificates || [];
      const cert = certs.find((ct) => {
        try { return forge.util.bytesToHex(raw.serial || '') === ct.serialNumber || certs.length === 1; } catch { return false; }
      }) || certs[0];
      if (!cert) throw new Error('No signer certificate in signature');
      const algo = DIGESTS[forge.asn1.derToOid(raw.digestAlgorithm)];
      if (!algo) throw new Error('Unsupported digest algorithm');
      sig.digest = algo.toUpperCase();
      const docHash = crypto.createHash(algo).update(signed).digest();
      let intact = false;
      const attrs = raw.authenticatedAttributes;
      if (attrs) {
        let mdAttr = null;
        for (const at of attrs) {
          const oid = forge.asn1.derToOid(at.value[0].value);
          if (oid === forge.pki.oids.messageDigest) mdAttr = Buffer.from(at.value[1].value[0].value, 'binary');
          if (oid === forge.pki.oids.signingTime) {
            const v = at.value[1].value[0];
            sig.time = (v.type === forge.asn1.Type.UTCTIME ? forge.asn1.utcTimeToDate(v.value) : forge.asn1.generalizedTimeToDate(v.value)).toISOString();
          }
        }
        const set = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs);
        const md = forge.md[algo].create();
        md.update(forge.asn1.toDer(set).getBytes());
        const sigOk = cert.publicKey.verify(md.digest().bytes(), raw.signature);
        intact = !!mdAttr && mdAttr.equals(docHash) && sigOk;
      } else {
        intact = cert.publicKey.verify(docHash.toString('binary'), raw.signature);
      }
      if (!sig.time) {
        const mm = /\/M\s*\(D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(around);
        if (mm) sig.time = new Date(Date.UTC(+mm[1], +mm[2] - 1, +mm[3], +mm[4], +mm[5], +mm[6])).toISOString();
      }
      sig.intact = intact;
      const tail = text.slice(c + d).trim();
      sig.coversAll = c + d >= buf.length - 2 || tail === '' || tail === '%%EOF';
      const f = (attrsObj, sn) => attrsObj.getField(sn)?.value || '';
      sig.signer = f(cert.subject, 'CN') || f(cert.subject, 'O');
      sig.email = cert.subject.attributes.find((x) => x.name === 'emailAddress')?.value || '';
      sig.issuer = f(cert.issuer, 'CN') || f(cert.issuer, 'O');
      sig.selfSigned = cert.isIssuer(cert);
      sig.notBefore = cert.validity.notBefore.toISOString();
      sig.notAfter = cert.validity.notAfter.toISOString();
      // Trusted if the chain in the signature leads to a well-known root authority.
      let trusted = false;
      try {
        const store = forge.pki.createCaStore(trustedRoots());
        const chain = [cert, ...certs.filter((x) => x !== cert)];
        trusted = forge.pki.verifyCertificateChain(store, chain);
      } catch { trusted = false; }
      sig.trusted = trusted;
    } catch (e) {
      sig.error = e.message;
    }
  }
  return out;
}

module.exports = { createStore, verifyPdf };
