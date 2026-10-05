/* Folio — E-Sign: certificate-based digital signatures and signature validation.
   Fill & Sign tools (signature, initials, date, marks) live in app.js; this adds the
   "Sign with certificate" flow (PKCS#7 detached, the format Acrobat validates) and the Signatures panel. */
'use strict';

(() => {
  Object.assign(TOOL_BUTTONS, {
    certsign: { icon: 'certsign', label: 'Sign with certificate' },
    verify: { icon: 'verify', label: 'Signatures', action: () => { showTab('sigs'); renderSigPanel(); } },
  });
  Object.assign(TOOL_INFO, {
    certsign: { name: 'Sign with certificate', hint: 'Drag a box where the signature should appear, then choose your digital ID.' },
  });

  // ------------------------------------------------------------ signature box tool
  let draft = null;
  Folio.tools.certsign = {
    deactivate() { draft = null; S.pages.forEach(drawAnnots); },
    down(e, pid, pt, before) {
      if (!native) { toast('Digital signatures need the Folio desktop app', true); return null; }
      draft = { pid, x: pt.x, y: pt.y, w: 0, h: 0 };
      return {
        drag: {
          onMove(p) {
            draft.x = Math.min(pt.x, p.x); draft.y = Math.min(pt.y, p.y);
            draft.w = Math.abs(p.x - pt.x); draft.h = Math.abs(p.y - pt.y);
            drawAnnots(getPage(pid));
          },
          onUp(d) {
            if (!d.moved || draft.w < 40 || draft.h < 16) {
              // a click: use a standard-size box at that point
              draft = { pid, x: pt.x - 90, y: pt.y - 24, w: 180, h: 48 };
            }
            drawAnnots(getPage(pid));
            chooseId(getPage(pid), { ...draft });
          },
        },
      };
    },
  };
  Folio.overlays.push((pg, layer) => {
    if (layer !== 'over' || !draft || draft.pid !== pg.id) return '';
    return `<rect x="${draft.x}" y="${draft.y}" width="${draft.w}" height="${draft.h}" fill="rgba(26,115,232,.08)" stroke="var(--sel)" stroke-width="${1.4 / S.zoom}" stroke-dasharray="${5 / S.zoom} ${3 / S.zoom}" pointer-events="none"/>`;
  });

  // Visible appearance of a certificate signature (drawn into the page; the cryptographic signature covers it).
  Folio.annotTypes.certsig = {
    name: 'Digital signature',
    svg(a, interactive) {
      const lines = sigLines(a);
      const nameSize = Math.min(a.h * 0.42, (a.w * 0.5) / Math.max(4, a.name.length) * 1.9);
      const small = Math.min(a.h / 6.2, 8);
      const half = a.x + a.w * 0.48;
      return `<g pointer-events="none"><text x="${a.x + 4}" y="${a.y + a.h / 2 + nameSize * 0.35}" font-family="Arial, sans-serif" font-size="${n2(nameSize)}" fill="#1d2b6b">${esc(a.name)}</text>
        ${lines.map((ln, i) => `<text x="${half + 4}" y="${n2(a.y + small * 1.3 * (i + 1) + 2)}" font-family="Arial, sans-serif" font-size="${n2(small)}" fill="#161a20">${esc(ln)}</text>`).join('')}</g>` +
        (interactive ? `<rect data-aid="${a.id}" x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" fill="transparent" stroke="#1d2b6b" stroke-width=".5" stroke-dasharray="2 2"/>` : '');
    },
    async export(page, a, ctx) {
      const f = await ctx.textFont({ font: 'Arial' });
      const lines = sigLines(a);
      const nameSize = Math.min(a.h * 0.42, (a.w * 0.5) / Math.max(4, a.name.length) * 1.9);
      const small = Math.min(a.h / 6.2, 8);
      const half = a.x + a.w * 0.48;
      page.drawText(ctx.safe(f, a.name), { x: a.x + 4, y: ctx.H - (a.y + a.h / 2 + nameSize * 0.35), size: nameSize, font: f, color: ctx.hexRgb('#1d2b6b') });
      lines.forEach((ln, i) => page.drawText(ctx.safe(f, ln), { x: half + 4, y: ctx.H - (a.y + small * 1.3 * (i + 1) + 2), size: small, font: f, color: ctx.hexRgb('#161a20') }));
    },
  };
  function sigLines(a) {
    const out = ['Digitally signed by', a.name];
    if (a.date) out.push(`Date: ${a.date}`);
    if (a.reason) out.push(`Reason: ${a.reason}`);
    if (a.location) out.push(`Location: ${a.location}`);
    return out;
  }

  // ------------------------------------------------------------ digital ID chooser
  async function chooseId(pg, box) {
    let ids = await native.idList();
    let chosen = ids[0]?.id || null;
    const listHtml = () => ids.length
      ? ids.map((d) => `<label class="id-card"><input type="radio" name="idPick" value="${d.id}" ${d.id === chosen ? 'checked' : ''}>
          <span><b>${esc(d.name)}</b>${d.email ? ` &lt;${esc(d.email)}&gt;` : ''}<br><span class="note">${d.selfSigned ? 'Self-signed' : `Issued by ${esc(d.issuer)}`} · valid until ${esc(d.notAfter.slice(0, 10))}</span></span>
          <button type="button" class="icon-btn sm danger" data-rm="${d.id}" title="Remove this ID from Folio"><i data-i="trash"></i></button></label>`).join('')
      : '<p class="note">No digital IDs yet. Create one, or import a .pfx / .p12 file from your organization.</p>';
    openPanel({
      title: 'Sign with a digital ID',
      wide: true,
      body: `<div class="id-list" id="idList">${listHtml()}</div>
        <div class="row"><button type="button" class="btn sm" id="idNew"><i data-i="plus"></i><span>Create new ID</span></button>
        <button type="button" class="btn sm" id="idImport"><i data-i="open"></i><span>Import .pfx / .p12</span></button></div>
        <div class="grid-3">
          <label class="form-field"><span>Password for this ID</span><input class="form-input" type="password" id="idPass" autocomplete="off"></label>
          <label class="form-field"><span>Reason (optional)</span><input class="form-input" type="text" id="sgReason" placeholder="I approve this document"></label>
          <label class="form-field"><span>Location (optional)</span><input class="form-input" type="text" id="sgLoc"></label>
        </div>
        <p class="note">Signing saves a new copy of the document. Any change made to that copy afterwards will show the signature as broken, so make all edits first.</p>`,
      actions: [{ label: 'Cancel' }, {
        label: 'Sign and save…', primary: true,
        run: async (form) => {
          const id = form.querySelector('[name="idPick"]:checked')?.value;
          if (!id) { toast('Choose or create a digital ID first', true); return false; }
          const pass = form.querySelector('#idPass').value;
          const reason = form.querySelector('#sgReason').value.trim();
          const location = form.querySelector('#sgLoc').value.trim();
          const meta = ids.find((d) => d.id === id);
          return signAndSave(pg, box, { id, pass, reason, location, meta });
        },
      }],
      onOpen: (form) => {
        const refresh = async (pick) => {
          ids = await native.idList();
          if (pick) chosen = pick;
          form.querySelector('#idList').innerHTML = listHtml();
          hydrateIcons(form);
          wireList();
        };
        const wireList = () => {
          form.querySelectorAll('[name="idPick"]').forEach((r) => r.addEventListener('change', () => { chosen = r.value; }));
          form.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', async (e) => {
            e.preventDefault();
            const d = ids.find((x) => x.id === b.dataset.rm);
            if (await inlineConfirm(form, `Remove “${d.name}” from Folio? The certificate file is deleted from Folio's storage; copies you exported elsewhere are not affected.`)) {
              await native.idRemove(d.id); await refresh();
            }
          }));
        };
        wireList();
        form.querySelector('#idNew').onclick = () => createIdForm(form, refresh);
        form.querySelector('#idImport').onclick = async () => {
          const pass = form.querySelector('#idPass').value;
          if (!pass) { toast('Enter the .pfx password in “Password for this ID” first', true); form.querySelector('#idPass').focus(); return; }
          const r = await native.idImport(pass);
          if (r?.error) toast(r.error, true);
          else if (r?.id) { toast(`Imported ${r.name}`); await refresh(r.id); }
        };
        setTimeout(() => form.querySelector('#idPass').focus(), 0);
      },
      onClose: () => { draft = null; S.pages.forEach(drawAnnots); },
    });
  }

  function inlineConfirm(form, text) {
    return new Promise((res) => {
      const box = document.createElement('div');
      box.className = 'inline-confirm';
      box.innerHTML = `<p>${esc(text)}</p><div class="row"><button type="button" class="btn sm" data-no>Keep</button><button type="button" class="btn sm danger-outline" data-yes>Remove</button></div>`;
      form.querySelector('#panelBody').prepend(box);
      box.querySelector('[data-yes]').onclick = () => { box.remove(); res(true); };
      box.querySelector('[data-no]').onclick = () => { box.remove(); res(false); };
    });
  }

  function createIdForm(form, refresh) {
    if (form.querySelector('.new-id')) return;
    const box = document.createElement('fieldset');
    box.className = 'new-id';
    box.innerHTML = `<legend>New self-signed digital ID</legend>
      <div class="grid-3">
        <label class="form-field"><span>Name</span><input class="form-input" type="text" id="nName" autocomplete="off"></label>
        <label class="form-field"><span>Organization</span><input class="form-input" type="text" id="nOrg" autocomplete="off"></label>
        <label class="form-field"><span>Email</span><input class="form-input" type="text" id="nEmail" autocomplete="off"></label>
        <label class="form-field"><span>Password</span><input class="form-input" type="password" id="nPass" autocomplete="new-password"></label>
        <label class="form-field"><span>Confirm password</span><input class="form-input" type="password" id="nPass2" autocomplete="new-password"></label>
      </div>
      <p class="note">A self-signed ID proves the document hasn't changed since you signed it. Others will see your identity as “not verified” unless they trust your certificate. Your organization may issue IDs that are trusted automatically.</p>
      <div class="row"><button type="button" class="btn sm primary" id="nCreate">Create ID</button></div>`;
    form.querySelector('#idList').after(box);
    box.querySelector('#nName').focus();
    box.querySelector('#nCreate').onclick = async () => {
      const name = box.querySelector('#nName').value.trim();
      const pass = box.querySelector('#nPass').value;
      if (!name) { toast('Enter a name for the ID', true); return; }
      if (pass.length < 6) { toast('Use a password of at least 6 characters', true); return; }
      if (pass !== box.querySelector('#nPass2').value) { toast('The passwords do not match', true); return; }
      busy('Creating digital ID…');
      try {
        const r = await native.idCreate({ name, org: box.querySelector('#nOrg').value.trim(), email: box.querySelector('#nEmail').value.trim(), password: pass });
        if (r.error) throw new Error(r.error);
        box.remove();
        form.querySelector('#idPass').value = pass;
        toast(`Created digital ID for ${name}`);
        await refresh(r.id);
      } catch (e) { toast('Could not create the ID: ' + e.message, true); } finally { busy(null); }
    };
  }

  async function signAndSave(pg, box, { id, pass, reason, location, meta }) {
    if (S.editing) commitEdit();
    const a = { id: uid(), type: 'certsig', x: n2(box.x), y: n2(box.y), w: n2(box.w), h: n2(box.h), name: meta.name, reason, location, date: new Date().toLocaleString() };
    pg.annots.push(a);
    try {
      const bytes = await exportPdf(S.pages);
      const lay = exportPdf.layout.find((l) => l.pid === pg.id);
      // display-frame box -> PDF user space of the output page
      const pts = [[a.x, a.y], [a.x + a.w, a.y + a.h]].map(([x, y]) => CS.apply(lay.ctm, x, lay.H - y));
      const rect = [Math.min(pts[0][0], pts[1][0]), Math.min(pts[0][1], pts[1][1]), Math.max(pts[0][0], pts[1][0]), Math.max(pts[0][1], pts[1][1])];
      busy('Signing…');
      const r = await native.signPdf({ data: bytes, pageIndex: lay.index, rect, id, password: pass, reason, location });
      if (r.error) { toast(r.error, true); return false; }
      busy(null);
      const name = `${baseName().replace(/-(edited|signed)$/, '')}-signed.pdf`;
      const saved = await native.saveDialog(name, r.data, S.docDir);
      if (!saved) { toast('Not saved. The signature was discarded.'); return false; }
      draft = null;
      // Reopen the signed file so what's on screen is exactly what was signed.
      await ingest([{ name: saved.name, path: saved.path, data: r.data }], 'replace');
      setTool('select');
      showTab('sigs');
      toast(`Signed and saved ${saved.name}`);
      return true;
    } catch (e) {
      console.error(e);
      toast('Signing failed: ' + e.message, true);
      return false;
    } finally {
      const p = getPage(pg.id);
      if (p) { p.annots = p.annots.filter((x) => x.id !== a.id); drawAnnots(p); }
      busy(null);
    }
  }

  // ------------------------------------------------------------ validation
  const results = new Map(); // source id -> { name, sigs }
  Folio.onIngest.push(async (pages, mode) => {
    if (!native) return;
    if (mode === 'replace' || mode === undefined) results.clear();
    for (const sid of new Set(pages.map((p) => p.src))) {
      const src = S.sources.get(sid);
      if (!src || results.has(sid)) continue;
      try {
        const sigs = await native.verifyPdf(src.orig);
        if (sigs.length) results.set(sid, { name: src.name, sigs });
      } catch (e) { console.warn('verify', e); }
    }
    renderSigPanel();
  });

  function status(sig) {
    if (sig.error) return { cls: 'bad', label: 'Cannot be validated', text: sig.error };
    if (!sig.intact) return { cls: 'bad', label: 'Invalid', text: 'The document has been altered or corrupted since it was signed.' };
    if (!sig.coversAll) return { cls: 'warn', label: 'Valid, document changed later', text: 'This signature is valid for the version it signed, but the document was modified afterwards.' };
    if (!sig.trusted) return { cls: 'warn', label: 'Valid, identity not verified', text: 'The document has not been modified since it was signed. The signer’s certificate is not from a trusted authority.' };
    return { cls: 'ok', label: 'Valid', text: 'The document has not been modified since it was signed, and the signer’s certificate is trusted.' };
  }

  function renderSigPanel() {
    const body = $('#sigsBody');
    const all = [...results.values()].flatMap((r) => r.sigs.map((s) => ({ ...s, file: r.name })));
    $('#sigCount').hidden = !all.length;
    $('#sigCount').textContent = all.length;
    const banner = $('#banner');
    if (!all.length) {
      banner.hidden = true;
      body.innerHTML = `<p class="note">${native ? 'This document has no digital signatures.' : 'Signature validation needs the Folio desktop app.'}</p>
        <p class="note">To sign with a certificate, open <b>E-Sign</b> and choose <b>Sign with certificate</b>.</p>`;
      return;
    }
    const st = all.map(status);
    const worst = st.some((s) => s.cls === 'bad') ? 'bad' : st.some((s) => s.cls === 'warn') ? 'warn' : 'ok';
    banner.hidden = false;
    banner.className = `banner ${worst}`;
    banner.innerHTML = `<i data-i="verify"></i><span>${worst === 'ok' ? 'Signed, and all signatures are valid.' : worst === 'warn' ? 'Signed. At least one signature needs your review.' : 'At least one signature is invalid.'}</span><button class="btn sm" id="bannerOpen">Signature panel</button>`;
    hydrateIcons(banner);
    banner.querySelector('#bannerOpen').onclick = () => showTab('sigs');
    body.innerHTML = all.map((s, i) => {
      const v = st[i];
      return `<div class="sig-item ${v.cls}">
        <div class="sig-head"><span class="pill ${v.cls}">${v.label}</span><span class="note">#${s.index + 1}</span></div>
        <b>${esc(s.signer || 'Unknown signer')}</b>${s.email ? `<span class="note">${esc(s.email)}</span>` : ''}
        <p class="note">${esc(v.text)}</p>
        <dl class="kv">
          ${s.time ? `<dt>Signed</dt><dd>${esc(new Date(s.time).toLocaleString())}</dd>` : ''}
          ${s.reason ? `<dt>Reason</dt><dd>${esc(s.reason)}</dd>` : ''}
          ${s.location ? `<dt>Location</dt><dd>${esc(s.location)}</dd>` : ''}
          <dt>Issued by</dt><dd>${esc(s.selfSigned ? 'Self-signed' : s.issuer || '—')}</dd>
          <dt>Certificate</dt><dd>${esc((s.notBefore || '').slice(0, 10))} to ${esc((s.notAfter || '').slice(0, 10))}</dd>
          <dt>Digest</dt><dd>${esc(s.digest || '—')}</dd>
          ${s.file ? `<dt>File</dt><dd>${esc(s.file)}</dd>` : ''}
        </dl>
      </div>`;
    }).join('') + '<p class="note">Saving edits creates a new file without these signatures. The signed original is not changed.</p>';
  }

  // Warn before saving over a signed document's signatures.
  Folio.beforeSave = async () => {
    if (!results.size) return true;
    return confirmBox('Save without signatures?', 'This document is digitally signed. Saving your changes creates a new file without the existing signatures. The signed original is not changed.', 'Save copy');
  };

  Folio.esign = { renderSigPanel };
})();
