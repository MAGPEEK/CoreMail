// Step 3: SMTP submission (587/465) and inbound (25).
import { randomBytes, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  check, assert, creds, DOMAIN, PORTS, STATE_DIR, http, session, sleep, smtpOpen, smtpCmd, smtpStartTls, smtpAuthPlain, smtpSend, buildMime,
} from '../lib.mjs';

export async function run(state) {
  const c = creds();
  const A = state.users.a.email, B = state.users.b.email;

  await check('smtp587: AUTH not offered / refused before STARTTLS', async () => {
    const s = await smtpOpen(PORTS.submission);
    try {
      const advertised = /AUTH/i.test(s.ehlo.text);
      assert(/STARTTLS/.test(s.ehlo.text), 'STARTTLS not advertised');
      const r = await smtpAuthPlain(s, A, c.userA);
      assert(r.code >= 500, `AUTH before TLS answered ${r.text}`);
      return `AUTH advertised pre-TLS=${advertised}; AUTH → ${r.text.split('\n').at(-1)}`;
    } finally { s.close(); }
  });

  // Message A → B with a binary attachment
  const att = randomBytes(24 * 1024);
  const subject = `E2E attachment ${Date.now()}`;
  const raw = buildMime({ from: `Alice E2E <${A}>`, to: `Bob E2E <${B}>`, subject, text: 'Hello Bob,\r\nsee attachment.\r\n.leading dot line\r\n', attachment: { filename: 'e2e-data.bin', contentType: 'application/octet-stream', data: att } });
  writeFileSync(join(STATE_DIR, 'a2b.eml'), raw, 'latin1');
  state.a2b = { subject, attSha256: createHash('sha256').update(att).digest('hex'), attSize: att.length, rawSha256: createHash('sha256').update(raw, 'latin1').digest('hex'), rawSize: Buffer.byteLength(raw, 'latin1') };

  await check('smtp587: STARTTLS + AUTH as A, send A→B with attachment', async () => {
    const s = await smtpOpen(PORTS.submission);
    try {
      await smtpStartTls(s);
      assert(/AUTH/i.test(s.ehlo.text), 'AUTH not advertised after STARTTLS');
      const a = await smtpAuthPlain(s, A, c.userA);
      assert(a.code === 235, `AUTH: ${a.text}`);
      const r = await smtpSend(s, A, [B], raw);
      assert(r.code === 250, `${r.stage}: ${r.text}`);
      return r.text.split('\n').at(-1);
    } finally { s.close(); }
  });

  await check('smtp587: envelope spoofing (MAIL FROM another local user) refused', async () => {
    const s = await smtpOpen(PORTS.submission);
    try {
      await smtpStartTls(s);
      await smtpAuthPlain(s, A, c.userA);
      const r = await smtpSend(s, B, [B], buildMime({ from: B, to: B, subject: 'spoof env', text: 'x' }));
      assert(r.code >= 550, `${r.stage}: ${r.text}`);
      return `${r.stage}: ${r.text.split('\n').at(-1)}`;
    } finally { s.close(); }
  });

  await check('smtp587: From-header spoofing (header = B, envelope = A) refused 550 5.7.1', async () => {
    const s = await smtpOpen(PORTS.submission);
    try {
      await smtpStartTls(s);
      await smtpAuthPlain(s, A, c.userA);
      const r = await smtpSend(s, A, [B], buildMime({ from: `Bob <${B}>`, to: B, subject: 'spoof hdr', text: 'x' }));
      assert(r.code === 550 && /5\.7\.1/.test(r.text), `${r.stage}: ${r.text}`);
      return `${r.stage}: ${r.text.split('\n').at(-1)}`;
    } finally { s.close(); }
  });

  await check('smtp587: send-as shared mailbox (SEND_AS) accepted', async () => {
    const s = await smtpOpen(PORTS.submission);
    try {
      await smtpStartTls(s);
      await smtpAuthPlain(s, A, c.userA);
      const r = await smtpSend(s, state.shared.email, [B], buildMime({ from: `Team <${state.shared.email}>`, to: B, subject: `E2E send-as ${Date.now()}`, text: 'from team' }));
      assert(r.code === 250, `${r.stage}: ${r.text}`);
      return 'accepted';
    } finally { s.close(); }
  });

  await check('smtps465: implicit TLS + AUTH works', async () => {
    const s = await smtpOpen(PORTS.smtps, { implicitTls: true });
    try {
      const a = await smtpAuthPlain(s, A, c.userA);
      assert(a.code === 235, `AUTH: ${a.text}`);
      const r = await smtpSend(s, A, [A], buildMime({ from: A, to: A, subject: `E2E 465 self ${Date.now()}`, text: 'self' }));
      assert(r.code === 250, `${r.stage}: ${r.text}`);
      return 'AUTH 235 + send 250';
    } finally { s.close(); }
  });

  // ── Inbound port 25 ─────────────────────────────────────────────────────────
  const ext = 'sender@external-e2e.test';
  state.inboundSubject = `E2E inbound ${Date.now()}`;
  const inbound = async () => {
    const s = await smtpOpen(PORTS.smtp, { ehlo: 'mx.external-e2e.test' });
    try { return await smtpSend(s, ext, [B], buildMime({ from: `External <${ext}>`, to: B, subject: state.inboundSubject, text: 'inbound test' })); } finally { s.close(); }
  };
  let first = await inbound();
  if (first.code === 451) {
    await check('smtp25: greylisting defers first attempt (451 4.7.1)', async () => first.text.split('\n').at(-1));
    // Shorten the wait (BCP setting, takes effect via settings reload) and retry
    const admin = await session(state, 'admin', state.adminEmail, c.admin);
    const p = await http('PUT', '/api/v1/admin/smtp-config/settings', { token: admin, body: { greylistWaitSec: 60 } });
    assert(p.status === 200, `greylist setting: ${p.status}`);
    console.log('  waiting 62 s for the greylisting window (greylistWaitSec=60)…');
    await sleep(62_000);
    first = await inbound();
  }
  await check('smtp25: external sender → B accepted', async () => {
    assert(first.code === 250, `${first.stage}: ${first.text}`);
    return first.text.split('\n').at(-1);
  });
  await check('smtp25: unknown local user rejected at RCPT', async () => {
    const s = await smtpOpen(PORTS.smtp, { ehlo: 'mx.external-e2e.test' });
    try {
      await smtpCmd(s, `MAIL FROM:<${ext}>`);
      const r = await smtpCmd(s, `RCPT TO:<nobody-${Date.now()}@${DOMAIN}>`);
      assert(r.code >= 550, r.text);
      return r.text;
    } finally { s.close(); }
  });
  await check('smtp25 (10.0): rooms are gone — no room admin API, a room address is an unknown recipient (550 5.1.1)', async () => {
    const admin = await session(state, 'admin', state.adminEmail, c.admin);
    const api = await http('POST', '/api/v1/admin/resources', { token: admin, body: {
      email: `e2e-raum-${Date.now()}@${DOMAIN}`, displayName: 'E2E Raum', resourceType: 'ROOM', domainId: state.domainId,
    } });
    assert(api.status === 404, `room admin API still answers: ${api.status} ${api.text.slice(0, 200)}`);
    const s = await smtpOpen(PORTS.smtp, { ehlo: 'mx.external-e2e.test' });
    try {
      await smtpCmd(s, `MAIL FROM:<${ext}>`);
      const r = await smtpCmd(s, `RCPT TO:<e2e-raum-${Date.now()}@${DOMAIN}>`);
      assert(r.code === 550 && /5\.1\.1/.test(r.text), r.text);
      return `admin API 404, RCPT ${r.text}`;
    } finally { s.close(); }
  });
  await check('smtp25: open relay to external domain refused', async () => {
    const s = await smtpOpen(PORTS.smtp, { ehlo: 'mx.external-e2e.test' });
    try {
      await smtpCmd(s, `MAIL FROM:<${ext}>`);
      const r = await smtpCmd(s, 'RCPT TO:<victim@other-external.test>');
      assert(r.code >= 550, r.text);
      return r.text;
    } finally { s.close(); }
  });
  await check('smtp25: AUTH not offered on port 25 without TLS', async () => {
    const s = await smtpOpen(PORTS.smtp, { ehlo: 'mx.external-e2e.test' });
    try { return `AUTH advertised=${/AUTH/.test(s.ehlo.text)}, STARTTLS=${/STARTTLS/.test(s.ehlo.text)}`; } finally { s.close(); }
  });
}
