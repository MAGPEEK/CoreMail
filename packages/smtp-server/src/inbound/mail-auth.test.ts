/**
 * Inbound authentication hardening: SMTP session data reaches the content
 * filter, forged Authentication-Results with our authserv-id are removed, the
 * filter's AR header is sanitised, former room addresses are unknown recipients
 * (10.0), queue jobs carry the authenticated sender, MX targets are SSRF-checked, the delay DSN is sent once
 * and the tarpit slows down error-producing clients.
 * Run: node --import tsx --test src/inbound/mail-auth.test.ts  (in packages/smtp-server)
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';

const none = async () => null;
(globalThis as unknown as { __prisma: unknown }).__prisma = {
  $on: () => undefined,
  $transaction: async (fn: (tx: unknown) => unknown) => fn((globalThis as unknown as { __prisma: unknown }).__prisma),
  smtpSettings: { findUnique: async () => ({ localDeliveryEnabled: true }) },
  domain: { findFirst: async ({ where }: { where: { name: string } }) => (where.name === 'corp.test' ? { id: 'd1' } : null) },
  user: { findFirst: none, findMany: async () => [] },
  sharedMailbox: { findFirst: none },
  emailAlias: { findFirst: none },
  systemLog: { create: async () => ({}) },
};

const { inboundHandlers, verifyRecipient } = await import('./handler.js');
const { interpretContentFilterResponse } = await import('./connection-filter.js');
const { stripOwnAuthResults, sanitizeAuthHeaders } = await import('../handlers/trace.js');
const { resolveMxTarget, relayMessage } = await import('../outbound/relay.js');
const { deliverOutboundJob, senderAuthForJob, delayDsnDue, delayDsnHours } = await import('../outbound/queue.js');
const { buildDsnMessage } = await import('../outbound/dsn.js');
const { tarpitDelayMs, inboundTarpitMaxDelayMs, TARPIT_THRESHOLD } = await import('../core/session.js');

const META = { helo: 'mx.ext.test', protocol: 'ESMTP' as const, hostname: 'mx.corp.test', sessionId: 'S1' };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// ── content-filter request + Authentication-Results ──────────────────────────

test('the content filter receives MAIL FROM, HELO, our host name and all recipients; forged own AR is stripped', async () => {
  let ctx: Record<string, unknown> = {};
  let scanned = '';
  globalThis.fetch = (async (_url: string, init: { headers: Record<string, string>; body: Buffer }) => {
    ctx = JSON.parse(init.headers['X-Filter-Context']!) as Record<string, unknown>;
    scanned = Buffer.from(init.body).toString();
    return { status: 200, json: async () => ({ action: 'reject', reason: 'stop' }) };
  }) as unknown as typeof fetch;
  const raw = Buffer.from('Authentication-Results: MX.CORP.TEST; dmarc=pass header.from=corp.test\r\nAuthentication-Results: other.example; spf=fail\r\nSubject: s\r\n\r\nx\r\n');

  await assert.rejects(inboundHandlers.onMessage(raw, 'a@ext.test', ['bob@corp.test', 'carol@corp.test'], null, '192.0.2.1', META), /550 5\.7\.1 stop/);

  assert.deepEqual(ctx, { senderIp: '192.0.2.1', mailFrom: 'a@ext.test', rcptTo: 'bob@corp.test', rcpts: ['bob@corp.test', 'carol@corp.test'], hostname: 'mx.corp.test', helo: 'mx.ext.test' });
  assert.doesNotMatch(scanned, /MX\.CORP\.TEST; dmarc=pass/);
  assert.match(scanned, /Authentication-Results: other\.example; spf=fail/);
});

test('stripOwnAuthResults: folded fields, comments before the authserv-id, header-only edge cases', () => {
  const raw = Buffer.from('Authentication-Results: (forged) mx.corp.test;\r\n\tdkim=pass\r\nFrom: a@b\r\n\r\nbody');
  assert.equal(stripOwnAuthResults(raw, 'mx.corp.test').toString(), 'From: a@b\r\n\r\nbody');
  const only = Buffer.from('Authentication-Results: mx.corp.test; spf=pass\r\n\r\nbody');
  assert.equal(stripOwnAuthResults(only, 'mx.corp.test').toString(), '\r\nbody');
  const sub = Buffer.from('Authentication-Results: mx.corp.test.evil; spf=pass\r\n\r\nb');
  assert.equal(stripOwnAuthResults(sub, 'mx.corp.test').toString(), sub.toString());
  // body lines are never touched
  const inBody = Buffer.from('Subject: x\r\n\r\nAuthentication-Results: mx.corp.test; spf=pass\r\n');
  assert.equal(stripOwnAuthResults(inBody, 'mx.corp.test').toString(), inBody.toString());
});

test('sanitizeAuthHeaders keeps only AR / Received-SPF fields', () => {
  const ok = 'Received-SPF: pass (mx: ok) client-ip=1.2.3.4;\r\nAuthentication-Results: mx.corp.test;\r\n dkim=pass;\r\n spf=pass\r\n';
  assert.equal(sanitizeAuthHeaders(ok), ok);
  assert.equal(sanitizeAuthHeaders('Authentication-Results: mx; spf=pass\r\nBcc: x@y\r\n\tcontinued\r\n'), 'Authentication-Results: mx; spf=pass\r\n');
  assert.equal(sanitizeAuthHeaders('X-Evil: 1\r\n'), '');
});

test('content-filter answer carries authHeaders and validated verifiedDomains', () => {
  const r = interpretContentFilterResponse(200, { action: 'accept', authHeaders: 'Authentication-Results: mx; none\r\n', verifiedDomains: ['Ext.Example', 'bad domain', 7] });
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') {
    assert.equal(r.result.authHeaders, 'Authentication-Results: mx; none\r\n');
    assert.deepEqual(r.result.verifiedDomains, ['ext.example']);
  }
});

// ── 10.0: room/equipment mailboxes removed ────────────────────────────────────

test('10.0: mail to a former room address is refused at RCPT TO with 5.1.1 (no resource lookup left)', async () => {
  assert.equal(await verifyRecipient('room1@corp.test'), false);
  assert.equal(await inboundHandlers.onRcptTo('room1@corp.test', 'org@ext.test', null, '192.0.2.1'), '5.1.1 User unknown');
});

// ── queue: sender authentication of local deliveries ─────────────────────────

test('queue jobs: only an authenticated user job (not rule forwards / redirects / releases) is an authenticated sender', () => {
  const base = { messageId: 'm', from: 'alice@corp.test', to: ['bob@corp.test'] };
  const raw = Buffer.from('Subject: x\r\n\r\nb');
  assert.deepEqual(senderAuthForJob({ ...base, senderUserId: 'u1' }, raw), { senderAuth: { authenticatedSender: 'alice@corp.test' } });
  assert.deepEqual(senderAuthForJob(base, raw), {});
  assert.deepEqual(senderAuthForJob({ ...base, senderUserId: 'u1', ruleRedirect: true }, raw), {});
  assert.deepEqual(senderAuthForJob({ ...base, senderUserId: 'u1', quarantineReleaseId: 'q' }, raw), {});
  assert.deepEqual(senderAuthForJob({ ...base, senderUserId: 'u1', ruleForward: true }, raw), {}, '9.4: rule forward job flag');
  assert.deepEqual(senderAuthForJob({ ...base, senderUserId: 'u1' }, Buffer.from('X-CoreMail-RuleForwarded: u1\r\nSubject: x\r\n\r\nb')), {});
});

test('10.0: a room reply job queued by 9.5 (job field resourceReply) lends no sender authentication', () => {
  const job = { messageId: 'm', from: 'room@corp.test', to: ['alice@corp.test'], resourceReply: true };
  assert.deepEqual(senderAuthForJob(job as never, Buffer.from('Subject: x\r\n\r\nb')), {});
});

// ── outbound: MX SSRF ─────────────────────────────────────────────────────────

test('MX hosts resolving to loopback/private/link-local addresses are refused (5.4.4)', async () => {
  const resolve = (map: Record<string, string[]>) => async (h: string) => map[h] ?? [];
  assert.deepEqual(await resolveMxTarget('mx.ok.example', resolve({ 'mx.ok.example': ['8.8.8.8'] }), {}), { kind: 'ok', address: '8.8.8.8' });
  for (const addrs of [['127.0.0.1'], ['10.1.2.3'], ['169.254.169.254'], ['::1'], ['fe80::1'], ['8.8.8.8', '192.168.1.1'], ['::ffff:127.0.0.1']]) {
    const r = await resolveMxTarget('mx.bad.example', resolve({ 'mx.bad.example': addrs }), {});
    assert.equal(r.kind, 'fail', addrs.join(','));
    if (r.kind === 'fail') { assert.equal(r.failure.status, '5.4.4'); assert.equal(r.failure.permanent, true); }
  }
  assert.equal((await resolveMxTarget('127.0.0.1', resolve({}), {})).kind, 'fail');
  assert.deepEqual(await resolveMxTarget('mx.lab', resolve({ 'mx.lab': ['10.0.0.5'] }), { OUTBOUND_ALLOW_PRIVATE_MX: 'true' }), { kind: 'ok', address: null });

  // relay: the internal MX is skipped, the public one is used by IP with SNI = host name
  const sent: Array<Record<string, unknown>> = [];
  const r = await relayMessage(Buffer.from('x'), 'a@corp.test', ['u@victim.example'], {}, {
    config: async () => ({ mode: 'mx', smarthostHost: '', smarthostPort: 25, smarthostTls: false, smarthostUsername: '', smarthostPassword: '', heloName: 'mail.corp.test' }) as never,
    resolveMx: async () => [{ exchange: 'internal.victim.example', priority: 1 }, { exchange: 'mx.victim.example', priority: 2 }],
    resolveHost: resolve({ 'internal.victim.example': ['127.0.0.1'], 'mx.victim.example': ['93.184.216.34'] }),
    send: async (opts, env) => { sent.push(opts); return { accepted: env.to, rejected: [] }; },
  });
  assert.deepEqual(r.delivered, ['u@victim.example']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!['host'], '93.184.216.34');
  assert.equal((sent[0]!['tls'] as { servername: string }).servername, 'mx.victim.example');

  // only internal MX hosts → permanent failure, nothing sent
  sent.length = 0;
  const all = await relayMessage(Buffer.from('x'), 'a@corp.test', ['u@victim.example'], {}, {
    config: async () => ({ mode: 'mx', smarthostHost: '', smarthostPort: 25, smarthostTls: false, smarthostUsername: '', smarthostPassword: '', heloName: 'mail.corp.test' }) as never,
    resolveMx: async () => [{ exchange: 'internal.victim.example', priority: 1 }],
    resolveHost: resolve({ 'internal.victim.example': ['127.0.0.1'] }),
    send: async () => { throw new Error('must not connect'); },
  });
  assert.equal(all.failures[0]?.status, '5.4.4');
  assert.equal(sent.length, 0);
});

// ── outbound: delay DSN ───────────────────────────────────────────────────────

test('one delay DSN (Action: delayed, 4.4.7) after OUTBOUND_DELAY_DSN_HOURS, never twice', async () => {
  const H = 3_600_000;
  const bounces: Array<Record<string, unknown>> = [];
  const deps = {
    isLocalAddress: async () => false,
    expand: async (a: string[]) => a,
    storeLocal: async () => undefined,
    resolveDkim: async () => ({}),
    relay: async (_r: Buffer, _f: string, to: string[]) => ({ delivered: [], failures: to.map((rcpt) => ({ rcpt, code: 451, status: '4.3.0', message: '451 try later', permanent: false })) }),
    bounce: async (o: Record<string, unknown>) => { bounces.push(o); },
    hostname: async () => 'mail.corp.test',
  };
  const job = {
    id: 'j', timestamp: Date.now() - 5 * H, attemptsMade: 3, opts: { attempts: 10 },
    data: { messageId: 'm', from: 'alice@corp.test', to: ['x@slow.example'], rawMessage: '' } as Record<string, unknown>,
    updateData: async (d: Record<string, unknown>) => { job.data = d; },
  };
  await assert.rejects(deliverOutboundJob(job as never, Buffer.from('x'), deps as never), /Temporary failure/);
  await assert.rejects(deliverOutboundJob(job as never, Buffer.from('x'), deps as never), /Temporary failure/);
  assert.equal(bounces.length, 1);
  assert.equal(bounces[0]!['action'], 'delayed');
  assert.equal((bounces[0]!['recipients'] as Array<{ status: string }>)[0]!.status, '4.4.7');
  assert.equal(job.data['delayNotified'], true);

  assert.equal(delayDsnDue({ data: { messageId: 'm', from: 'a@b', to: [] }, timestamp: Date.now() - 3 * H, opts: {} }, 4), false);
  assert.equal(delayDsnDue({ data: { messageId: 'm', from: '', to: [] }, timestamp: Date.now() - 9 * H, opts: {} }, 4), false, 'null sender');
  assert.equal(delayDsnDue({ data: { messageId: 'm', from: 'a@b', to: [] }, timestamp: Date.now() - 9 * H, opts: {} }, 0), false, 'disabled');
  assert.equal(delayDsnHours({}), 4);
  assert.equal(delayDsnHours({ OUTBOUND_DELAY_DSN_HOURS: '0' }), 0);
  assert.equal(delayDsnHours({ OUTBOUND_DELAY_DSN_HOURS: 'x' }), 4);

  const dsn = buildDsnMessage({
    originalFrom: 'alice@corp.test', originalTo: ['x@slow.example'], originalSubject: 's', originalMessageId: null,
    failureReason: 'r', smtpCode: 451, serverHostname: 'mail.corp.test', action: 'delayed',
    recipients: [{ rcpt: 'x@slow.example', status: '4.4.7', diagnostic: '451 try later', remote: true }],
    willRetryUntil: new Date(Date.UTC(2026, 10, 17, 12)),
  }).toString();
  assert.match(dsn, /\r\nAction: delayed\r\nStatus: 4\.4\.7\r\n/);
  assert.match(dsn, /Will-Retry-Until: Tue, 17 Nov 2026 12:00:00 \+0000/);
  assert.match(dsn, /Subject: Delayed Mail/);
});

// ── tarpit ────────────────────────────────────────────────────────────────────

test('tarpit: increasing delay after 3 permanent errors, capped at the maximum', () => {
  assert.equal(TARPIT_THRESHOLD, 3);
  assert.equal(tarpitDelayMs(2, 5000), 0);
  assert.equal(tarpitDelayMs(3, 5000), 1000);
  assert.equal(tarpitDelayMs(4, 5000), 2000);
  assert.equal(tarpitDelayMs(50, 5000), 5000);
  assert.equal(tarpitDelayMs(50, 0), 0);
  assert.equal(tarpitDelayMs(50, undefined), 0);
  assert.equal(inboundTarpitMaxDelayMs({}), 5000);
  assert.equal(inboundTarpitMaxDelayMs({ SMTP_TARPIT_MAX_DELAY_MS: '0' }), 0);
  assert.equal(inboundTarpitMaxDelayMs({ SMTP_TARPIT_MAX_DELAY_MS: '999999' }), 30_000);
});
