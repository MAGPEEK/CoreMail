// Step (w1): old clients.
//  - "Ältere Clients erlauben (TLS 1.0/1.1)" on the IMAPS listener: off → a TLS 1.0 client is
//    refused; on → accepted (hot reload, no container restart); off again → refused;
//  - Autodiscover: 401 Basic challenge first, then IMAP/SMTP with an explicit IMAP Encryption,
//    lowercase path variant, never EXCH/EXPR blocks;
//  - device relay on port 25: off → external recipient refused; on for the private networks +
//    the e2e domain → accepted at RCPT for that sender domain only; settings validated (0.0.0.0/0
//    refused, also as the IPv4-mapped ::ffff:0:0/96); a relayed message with a blocked attachment
//    is refused at DATA (the relay runs the attachment filter + ClamAV, nothing is queued);
//    finally switched off again.
import tls from 'node:tls';
import { check, assert, creds, http, session, waitFor, smtpOpen, smtpCmd, smtpSend, basic, HOST, PORTS, DOMAIN } from '../lib.mjs';

/** TLS handshake pinned to one protocol version against an implicit-TLS port. */
function handshake(port, version) {
  return new Promise((resolve) => {
    const s = tls.connect({ host: HOST, port, rejectUnauthorized: false, minVersion: version, maxVersion: version, ciphers: 'DEFAULT:@SECLEVEL=0' });
    s.once('secureConnect', () => { const p = s.getProtocol(); s.destroy(); resolve(p); });
    s.once('error', () => resolve(null));
    s.setTimeout(10_000, () => { s.destroy(); resolve(null); });
  });
}

async function setImapsLegacy(admin, on) {
  const list = await http('GET', '/api/v1/admin/services/listeners/imap', { token: admin });
  assert(list.status === 200, `listeners ${list.status}`);
  const l = list.json.find((x) => x.port === 993);
  assert(l, 'IMAPS listener 993');
  const r = await http('PUT', `/api/v1/admin/services/listeners/${l.id}`, {
    token: admin, body: { address: l.address, port: l.port, ssl: l.ssl, active: l.active, allowLegacyTls: on },
  });
  assert(r.status === 200 && r.json.allowLegacyTls === on, `PUT ${r.status} ${r.text.slice(0, 200)}`);
}

async function relayRcpt(from, rcpt) {
  const c = await smtpOpen(PORTS.smtp, { ehlo: 'scanner.e2e.test' });
  try {
    const m = await smtpCmd(c, `MAIL FROM:<${from}>`);
    assert(m.code === 250, `MAIL ${m.text}`);
    return await smtpCmd(c, `RCPT TO:<${rcpt}>`);
  } finally {
    await smtpCmd(c, 'QUIT').catch(() => undefined);
    c.close();
  }
}

/** A relayed transaction up to the DATA reply (nothing is queued when DATA is refused). */
async function relayData(from, rcpt, raw) {
  const c = await smtpOpen(PORTS.smtp, { ehlo: 'scanner.e2e.test' });
  try {
    return await smtpSend(c, from, [rcpt], raw);
  } finally {
    await smtpCmd(c, 'QUIT').catch(() => undefined);
    c.close();
  }
}

/** Scan-to-mail with an executable attachment — blocked by the default attachment filter (.exe). */
function mailWithExe(from, to) {
  const b = 'e2e-relay-boundary';
  return [
    `From: Scanner <${from}>`, `To: <${to}>`, 'Subject: e2e device relay attachment', 'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${b}"`, '', `--${b}`, 'Content-Type: text/plain', '', 'scan', `--${b}`,
    'Content-Type: application/octet-stream; name="scan.exe"', 'Content-Disposition: attachment; filename="scan.exe"',
    'Content-Transfer-Encoding: base64', '', Buffer.from('MZ e2e').toString('base64'), `--${b}--`, '',
  ].join('\r\n');
}

const RELAY_OFF = { enabled: false, allowedNetworks: [], senderDomains: [], port: 25, maxMessagesPerMinute: 30 };

export async function run(state) {
  const c = creds();
  const admin = await session(state, 'admin', state.adminEmail, c.admin);
  const userA = state.users.a.email;
  const passA = state.mfaA ? state.appPwA : c.userA;

  await check('legacy TLS: IMAPS refuses TLS 1.0 by default', async () => {
    await setImapsLegacy(admin, false);
    await waitFor(async () => (await handshake(PORTS.imaps, 'TLSv1')) === null, { what: 'TLS 1.0 refused' });
    assert((await handshake(PORTS.imaps, 'TLSv1.2')) === 'TLSv1.2', 'TLS 1.2 works');
    return 'TLS 1.0 refused, TLS 1.2 ok';
  });

  await check('legacy TLS: switch on → TLS 1.0/1.1 accepted without restart; off → refused again', async () => {
    try {
      await setImapsLegacy(admin, true);
      await waitFor(async () => (await handshake(PORTS.imaps, 'TLSv1')) === 'TLSv1', { what: 'TLS 1.0 accepted', timeout: 30000 });
      assert((await handshake(PORTS.imaps, 'TLSv1.1')) === 'TLSv1.1', 'TLS 1.1');
      assert((await handshake(PORTS.imaps, 'TLSv1.3')) === 'TLSv1.3', 'TLS 1.3 still preferred');
    } finally {
      await setImapsLegacy(admin, false);
    }
    await waitFor(async () => (await handshake(PORTS.imaps, 'TLSv1')) === null, { what: 'TLS 1.0 refused again', timeout: 30000 });
    return 'hot reload both ways';
  });

  await check('autodiscover: Basic challenge first, then IMAP/SMTP with explicit encryption', async () => {
    const body = `<?xml version="1.0" encoding="utf-8"?><Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006"><Request><EMailAddress>${userA}</EMailAddress><AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a</AcceptableResponseSchema></Request></Autodiscover>`;
    const probe = await http('POST', '/autodiscover/autodiscover.xml', { body, headers: { 'Content-Type': 'text/xml' } });
    assert(probe.status === 401 && /Basic/i.test(probe.headers.get('www-authenticate') ?? ''), `probe ${probe.status}`);
    const r = await http('POST', '/AutoDiscover/AutoDiscover.xml', { body, headers: { 'Content-Type': 'text/xml', Authorization: basic(userA, passA) } });
    assert(r.status === 200, `auth ${r.status}`);
    assert(/<Type>IMAP<\/Type>/.test(r.text) && /<Encryption>(SSL|TLS)<\/Encryption>/.test(r.text), r.text.slice(0, 400));
    assert(!/<Type>(EXCH|EXPR)<\/Type>/.test(r.text), 'no Exchange RPC blocks');
    return 'ok';
  });

  await check('device relay: refused while off, validated, allowed only for configured sender domains', async () => {
    try {
      let r = await http('PUT', '/api/v1/admin/smtp-config/device-relay', { token: admin, body: RELAY_OFF });
      assert(r.status === 200, `off ${r.status} ${r.text.slice(0, 200)}`);
      const external = `someone@relay-target.invalid`;
      const offReply = await relayRcpt(`scanner@${DOMAIN}`, external);
      assert(offReply.code >= 500, `off: external RCPT must be refused, got ${offReply.text}`);

      for (const wide of ['0.0.0.0/0', '::ffff:0:0/96']) {
        r = await http('PUT', '/api/v1/admin/smtp-config/device-relay', { token: admin, body: { ...RELAY_OFF, enabled: true, allowedNetworks: [wide], senderDomains: [DOMAIN] } });
        assert(r.status === 400, `${wide} must be refused, got ${r.status}`);
      }

      r = await http('PUT', '/api/v1/admin/smtp-config/device-relay', {
        token: admin, body: { ...RELAY_OFF, enabled: true, allowedNetworks: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8'], senderDomains: [DOMAIN] },
      });
      assert(r.status === 200 && r.json.listenerActive === true, `on ${r.status} ${r.text.slice(0, 200)}`);
      await waitFor(async () => (await relayRcpt(`scanner@${DOMAIN}`, external)).code === 250, { what: 'device relay active', timeout: 45000 });
      const foreign = await relayRcpt('ceo@bank.example.org', external);
      assert(foreign.code === 550 && /5\.7\.1/.test(foreign.text), `foreign sender: ${foreign.text}`);
      const exe = await relayData(`scanner@${DOMAIN}`, external, mailWithExe(`scanner@${DOMAIN}`, external));
      assert(exe.stage === 'DATA' && exe.code === 550, `blocked attachment must be refused at DATA: ${exe.stage} ${exe.text}`);
    } finally {
      await http('PUT', '/api/v1/admin/smtp-config/device-relay', { token: admin, body: RELAY_OFF });
    }
    return 'off → refused, on → only configured domains, attachment filter applies';
  });
}
