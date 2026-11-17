// Step 10: admin flows — certificate, transport-rule quarantine + release, out-of-office.
import tls from 'node:tls';
import { check, assert, creds, http, session, buildMime, imapCmd, imapQuote, waitFor, sleep, HOST, PORTS, DOMAIN } from '../lib.mjs';
import { imapLogin } from './imap.mjs';
import { submit } from './pop3.mjs';

async function findSubject(user, pass, subject, { folder = 'INBOX', wantRaw = false } = {}) {
  const im = await imapLogin(user, pass);
  try {
    await imapCmd(im, `EXAMINE ${folder}`);
    const x = await imapCmd(im, `UID SEARCH SUBJECT ${imapQuote(subject)}`);
    const ids = (x.lines.find((l) => l.startsWith('* SEARCH')) ?? '').split(' ').slice(2).filter(Boolean);
    if (!wantRaw || !ids.length) return ids;
    const f = await imapCmd(im, `UID FETCH ${ids.at(-1)} (BODY.PEEK[])`);
    return { ids, raw: f.literals[0].toString('latin1') };
  } finally { im.close(); }
}

export async function run(state) {
  const c = creds();
  const admin = await session(state, 'admin', state.adminEmail, c.admin);
  const A = state.users.a.email, B = state.users.b.email;
  const passA = state.mfaA ? state.appPwA : c.userA;

  // 9.3: scanner deployment state. Standard stack (incl. E2E_STORAGE=filesystem): rspamd and
  // ClamAV are deployed — rspamd available, ClamAV available or still loading signatures
  // (unavailable, but never host-not-found), never absent. E2E_SCANNERS=absent: a stack without
  // both containers that sets RSPAMD_ENABLED=false / CLAMAV_ENABLED=false (minimal compose) — the
  // env switch is the only way to absent; a missing host name is unavailable/host-not-found.
  await check('admin: /admin/security/capabilities reports the deployed scanners', async () => {
    const r = await http('GET', '/api/v1/admin/security/capabilities', { token: admin });
    assert(r.status === 200, `${r.status} ${r.text.slice(0, 200)}`);
    const { rspamd, clamav } = r.json ?? {};
    assert(rspamd?.state && clamav?.state, `shape: ${r.text.slice(0, 200)}`);
    assert(!/rspamd:|clamav:|https?:\/\//.test(r.text), `host or URL leaked: ${r.text.slice(0, 200)}`);
    if ((process.env.E2E_SCANNERS ?? 'deployed') === 'absent') {
      assert(rspamd.state === 'absent' && clamav.state === 'absent', r.text);
      assert(rspamd.reason === 'disabled-by-config' && clamav.reason === 'disabled-by-config', r.text);
    } else {
      assert(rspamd.state === 'available', `rspamd ${JSON.stringify(rspamd)}`);
      assert(clamav.state === 'available' || clamav.state === 'unavailable', `clamav ${JSON.stringify(clamav)}`);
      assert(clamav.reason !== 'host-not-found', `clamav container not resolvable: ${JSON.stringify(clamav)}`);
    }
    return `rspamd=${rspamd.state} clamav=${clamav.state}${clamav.detail ? ` (${clamav.detail})` : ''}`;
  });

  await check('admin: self-signed certificate present and served on 993', async () => {
    const r = await http('GET', '/api/v1/admin/certificates', { token: admin });
    const list = r.json?.certificates ?? r.json ?? [];
    const cert = list.find((x) => /SELF/i.test(x.type ?? '') || x.selfSigned);
    assert(r.status === 200 && cert, `${r.status} ${JSON.stringify(list).slice(0, 300)}`);
    const peer = await new Promise((res, rej) => {
      const s = tls.connect({ host: HOST, port: PORTS.imaps, rejectUnauthorized: false, servername: `mail.${DOMAIN}` }, () => { res(s.getPeerCertificate()); s.end(); });
      s.on('error', rej);
    });
    // setup creates a baseline self-signed cert for the public host name (9.3: mail.<domain>, was
    // mail.localhost) — 993 must serve exactly that one
    assert((cert.domains ?? []).includes(peer.subject?.CN), `993 presents ${peer.subject?.CN}, DB cert ${cert.domains}`);
    return `${cert.type} ${cert.domains?.join?.(',') ?? cert.commonName ?? ''} status=${cert.status} protocol=${cert.isActiveProtocol}; 993 CN=${peer.subject?.CN}`;
  });

  // ── Quarantine via transport rule ──────────────────────────────────────────
  const qSubject = `E2E QUARANTINE-ME ${Date.now()}`;
  let ruleId;
  await check('admin: transport rule (subject contains → quarantine) created', async () => {
    const r = await http('POST', '/api/v1/admin/transport-rules', { token: admin, body: {
      name: 'e2e quarantine', conditions: [{ field: 'subject', op: 'contains', value: 'QUARANTINE-ME' }], actions: [{ type: 'quarantine', value: '' }],
    } });
    assert(r.status === 201, `${r.status} ${r.text.slice(0, 200)}`);
    ruleId = r.json.id;
    return ruleId;
  });
  await submit(A, passA, B, buildMime({ from: A, to: B, subject: qSubject, text: 'should be quarantined' }));
  let qItem;
  await check('admin: matching mail lands in quarantine, not in the mailbox', async () => {
    qItem = await waitFor(async () => {
      const r = await http('GET', '/api/v1/admin/quarantine', { token: admin });
      const items = r.json?.items ?? r.json?.messages ?? r.json ?? [];
      return items.find((i) => (i.subject ?? '').includes(qSubject));
    }, { timeout: 30000, what: 'quarantine item' });
    const inBox = await findSubject(B, c.userB, qSubject);
    assert(inBox.length === 0, 'quarantined mail was ALSO delivered');
    return `item ${qItem.id} (${qItem.reason ?? qItem.status ?? ''})`;
  });
  await check('admin: quarantine release delivers the mail to B', async () => {
    const r = await http('POST', `/api/v1/admin/quarantine/${qItem.id}/release`, { token: admin });
    assert(r.status === 200, `${r.status} ${r.text}`);
    await waitFor(async () => (await findSubject(B, c.userB, qSubject)).length > 0, { timeout: 30000, what: 'released mail in B INBOX' });
    return `released → ${r.json.recipients?.join(',')}, delivered`;
  });
  if (ruleId) await http('DELETE', `/api/v1/admin/transport-rules/${ruleId}`, { token: admin });

  // ── Out of office ──────────────────────────────────────────────────────────
  const tokB = await session(state, 'b', B, c.userB);
  await check('oof: B enables out-of-office', async () => {
    const r = await http('PUT', '/api/v1/user/oof', { token: tokB, body: { enabled: true, internalMessage: 'Bob is away (internal e2e)', externalMessage: 'Bob is away (external e2e)', externalEnabled: true } });
    assert(r.status === 200, `${r.status} ${r.text}`);
    return 'enabled';
  });
  const o1 = `E2E oof trigger ${Date.now()}`;
  await submit(A, passA, B, buildMime({ from: A, to: B, subject: o1, text: 'are you there?' }));
  await sleep(1500);
  await submit(A, passA, B, buildMime({ from: A, to: B, subject: `${o1} second`, text: 'again' }));
  await check('oof: A receives exactly one auto-reply (RFC 3834 headers)', async () => {
    const got = await waitFor(async () => {
      const r = await findSubject(A, passA, `Auto: ${o1}`, { wantRaw: true });
      return r.ids?.length ? r : null;
    }, { timeout: 40000, what: 'auto-reply at A' });
    await sleep(8000);
    const all = await findSubject(A, passA, 'Auto:');
    const hdr = got.raw.split('\r\n\r\n')[0];
    assert(/^Auto-Submitted: auto-replied/im.test(hdr), 'Auto-Submitted header missing');
    assert(/internal e2e/.test(got.raw), 'internal OOF text not used');
    const mine = (await Promise.all(all.map(async () => 1))).length;
    assert(mine === 1, `${mine} auto-replies at A (expected 1)`);
    return 'one reply, Auto-Submitted: auto-replied, internal text';
  });
  await check('oof: external sender gets the external text via smarthost sink', async () => {
    await http('DELETE', '/messages', { base: `http://${HOST}:${PORTS.sink}` });
    const { smtpOpen, smtpSend } = await import('../lib.mjs');
    const s = await smtpOpen(PORTS.smtp, { ehlo: 'mx.external-e2e.test' });
    const ext = 'oof-tester@external-e2e.test';
    try {
      const r = await smtpSend(s, ext, [B], buildMime({ from: ext, to: B, subject: `E2E ext oof ${Date.now()}`, text: 'hi' }));
      assert(r.code === 250, `inbound ${r.text}`);
    } finally { s.close(); }
    const msgs = await waitFor(async () => {
      const r = await http('GET', '/messages', { base: `http://${HOST}:${PORTS.sink}` });
      return r.json?.filter((m) => m.to.includes(ext)).length ? r.json : null;
    }, { timeout: 60000, what: 'auto-reply at the sink' });
    const m = msgs.find((x) => x.to.includes(ext));
    assert(m.from === '', `envelope sender should be null path, got <${m.from}>`);
    assert(/external e2e/.test(m.raw), 'external text not used');
    return `sink got reply, MAIL FROM:<>, DKIM=${/DKIM-Signature/i.test(m.raw)}`;
  });
  await http('PUT', '/api/v1/user/oof', { token: tokB, body: { enabled: false } });
}
