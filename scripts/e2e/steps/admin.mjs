// Step 10: admin flows — certificate, transport-rule quarantine + release, out-of-office,
// sender lists / spoofing settings / API rate limit (9.4).
import tls from 'node:tls';
import { domainToASCII } from 'node:url';
import {
  check, assert, creds, http, session, buildMime, imapCmd, imapQuote, waitFor, sleep, HOST, PORTS, DOMAIN,
  smtpOpen, smtpCmd, smtpSend, resetGatewayRateLimits,
} from '../lib.mjs';
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

  await hygieneChecks(state, admin);
}

/** One inbound port-25 transaction up to RCPT TO (or DATA when `raw` is given). */
async function inbound(from, rcpts, raw) {
  const s = await smtpOpen(PORTS.smtp, { ehlo: 'mx.external-e2e.test' });
  try {
    if (raw) return await smtpSend(s, from, rcpts, raw);
    await smtpCmd(s, `MAIL FROM:<${from}>`);
    const out = [];
    for (const r of rcpts) out.push(await smtpCmd(s, `RCPT TO:<${r}>`));
    return out;
  } finally { s.close(); }
}

// 9.4 (BCP review): sender lists, spoofing settings, configurable API rate limit.
async function hygieneChecks(state, admin) {
  const A = state.users.a.email, B = state.users.b.email;
  const BASE = '/api/v1/admin/security';

  await check('hygiene: mailbox-scoped sender block refuses that recipient at RCPT TO, not others; CSV export lists it', async () => {
    const pest = `pest-${Date.now()}@external-e2e.test`;
    const c = await http('POST', `${BASE}/sender-lists`, { token: admin, body: { listType: 'BLOCK', scope: 'USER', target: B, patternType: 'EXACT', pattern: pest } });
    assert(c.status === 201, `create ${c.status} ${c.text.slice(0, 200)}`);
    try {
      const [toB, toA] = await inbound(pest, [B, A]);
      assert(toB.code === 550 && /5\.7\.1/.test(toB.text), `RCPT B: ${toB.text}`);
      assert(toA.code !== 550, `RCPT A must not be blocked: ${toA.text}`);
      const csv = await http('GET', `${BASE}/sender-lists/export.csv`, { token: admin });
      assert(csv.status === 200 && csv.text.includes(pest), 'entry missing in the CSV export');
      return `B: ${toB.text.trim()}; A: ${toA.code}`;
    } finally {
      await http('DELETE', `${BASE}/sender-lists/${c.json.id}`, { token: admin });
    }
  });

  await check('hygiene (9.4 review): an internationalized block entry is stored as A-label and refuses the punycode sender', async () => {
    const unicode = `pest-${Date.now()}@bücher-e2e.test`;
    const ascii = `${unicode.split('@')[0]}@${domainToASCII('bücher-e2e.test')}`;
    const c = await http('POST', `${BASE}/sender-lists`, { token: admin, body: { listType: 'BLOCK', scope: 'USER', target: B, patternType: 'EXACT', pattern: unicode } });
    assert(c.status === 201, `create ${c.status} ${c.text.slice(0, 200)}`);
    try {
      assert(c.json.pattern === ascii, `stored pattern ${c.json.pattern}, expected ${ascii}`);
      const dup = await http('POST', `${BASE}/sender-lists`, { token: admin, body: { listType: 'BLOCK', scope: 'USER', target: B, patternType: 'EXACT', pattern: ascii } });
      assert(dup.status === 409, `punycode spelling must be the same entry: ${dup.status}`);
      const [toB] = await inbound(ascii, [B]);
      assert(toB.code === 550 && /5\.7\.1/.test(toB.text), `RCPT B: ${toB.text}`);
      return `${c.json.pattern}: ${toB.text.trim()}`;
    } finally {
      await http('DELETE', `${BASE}/sender-lists/${c.json.id}`, { token: admin });
    }
  });

  await check('ingress (9.4 review): internal X-CoreMail-* headers of an external sender are stripped before delivery', async () => {
    const subject = `E2E forged internal headers ${Date.now()}`;
    const raw = buildMime({
      from: 'External <sender@external-e2e.test>', to: B, subject, text: 'forged',
      extraHeaders: ['X-CoreMail-RuleForwarded: forged', 'X-CoreMail-Draft-Pending: e30=', 'X-CoreMail-Quarantine-Released: forged'],
    });
    // envelope sender of the smtp step: its greylisting triple for B has passed
    const r = await inbound('sender@external-e2e.test', [B], raw);
    assert(r.code === 250, `${r.stage}: ${r.text}`);
    let stored = '';
    await waitFor(async () => {
      const found = await findSubject(B, creds().userB, subject, { wantRaw: true });
      stored = Array.isArray(found) ? '' : found.raw;
      return stored !== '';
    }, { timeout: 30000, what: 'forged-header mail in B INBOX' });
    const head = stored.slice(0, stored.indexOf('\r\n\r\n'));
    assert(!/^X-CoreMail-(RuleForwarded|Draft-Pending|Quarantine-Released):/im.test(head), 'an internal header reached the mailbox');
    return 'stripped';
  });

  await check('hygiene: spoofing action from the BCP takes effect without a restart (reject → 550 for a forged local From)', async () => {
    const g = await http('GET', `${BASE}/spoofing`, { token: admin });
    assert(g.status === 200, `GET ${g.status}`);
    if (g.json.envOverrides.some((o) => o.field === 'localSpoofAction')) return 'skipped: LOCAL_SPOOF_ACTION set in the environment';
    const p = await http('PUT', `${BASE}/spoofing`, { token: admin, body: { localSpoofAction: 'reject' } });
    assert(p.status === 200 && p.json.effective.action === 'reject', `PUT ${p.status} ${p.text.slice(0, 200)}`);
    try {
      await sleep(2000); // settings reload via Redis
      // envelope sender of the smtp step (greylisting triple already passed), forged local header From
      const raw = buildMime({ from: `ceo@${DOMAIN}`, to: B, subject: `E2E forged local ${Date.now()}`, text: 'spoof' });
      const r = await inbound('sender@external-e2e.test', [B], raw);
      assert(r.stage === 'DATA' && r.code === 550, `${r.stage}: ${r.text}`);
      return r.text.trim();
    } finally {
      await http('PUT', `${BASE}/spoofing`, { token: admin, body: { localSpoofAction: 'policy' } });
    }
  });

  await check('hygiene: API rate limit is configurable (per-IP limit applies at once, RateLimit-Limit header)', async () => {
    const s = await http('PUT', '/api/v1/admin/settings/security', { token: admin, body: { apiRateLimitPerIp: 15 } });
    assert(s.status === 200, `PUT ${s.status} ${s.text.slice(0, 200)}`);
    if ((s.json.apiRateLimitEnvOverrides ?? []).includes('apiRateLimitPerIp')) return 'skipped: API_RATE_LIMIT_PER_IP set in the environment';
    try {
      let limited = null;
      let limitHeader = null;
      for (let i = 0; i < 20 && !limited; i++) {
        const r = await http('GET', '/api/v1/branding', { retry429: false });
        limitHeader ??= r.headers.get('ratelimit-limit');
        if (r.status === 429) limited = r;
      }
      assert(limitHeader === '15', `RateLimit-Limit ${limitHeader}`);
      assert(limited && limited.headers.get('retry-after'), 'no 429 within 20 anonymous requests');
      const user = await http('GET', '/api/v1/admin/settings', { token: admin, retry429: false });
      assert(user.status === 200, `signed-in requests use their own budget: ${user.status}`);
      return `429 after the per-IP budget; signed-in admin unaffected`;
    } finally {
      await http('PUT', '/api/v1/admin/settings/security', { token: admin, body: { apiRateLimitPerIp: 500 } });
      await resetGatewayRateLimits(); // the exhausted anonymous window would block later logins
    }
  });
}
