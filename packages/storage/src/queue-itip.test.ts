import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';
process.env['NODE_ENV'] = 'test';
const fakePrisma: Record<string, unknown> = { $on: () => undefined };
(globalThis as unknown as { __prisma: unknown }).__prisma = fakePrisma;

const { buildOutboundJobOptions, isExpiredInQueue, queueCleanPlan, normalizeQueueSettings } = await import('./queue-options.js');
const { extractITipReply, isReplyFromAttendee, processITipInbound, parseITipReply } = await import('./itip-inbound.js');

// ── queue options per settings ────────────────────────────────────────────────

test('outbound job options follow QueueSettings', () => {
  const d = buildOutboundJobOptions(null);
  assert.deepEqual(d, {
    attempts: 10,
    backoff: { type: 'exponential', delay: 60_000 },
    removeOnComplete: { age: 24 * 3600, count: 100 },
    removeOnFail: { count: 10_000 },
  });
  const s = buildOutboundJobOptions({ maxRetryAttempts: 4, retryBackoffDelaySec: 30, completedRetentionHours: 2, deadLetterRetentionDays: 3, autoFlushDead: true });
  assert.equal(s.attempts, 4);
  assert.equal(s.backoff.delay, 30_000);
  assert.deepEqual(s.removeOnComplete, { age: 7200, count: 100 });
  assert.deepEqual(s.removeOnFail, { age: 3 * 86_400 });
  assert.equal(normalizeQueueSettings({ maxRetryAttempts: -3 as number }).maxRetryAttempts, 1);
});

test('outboundRetentionHours expiry counts from the planned send time', () => {
  const now = 1_000_000_000_000;
  const h = 3_600_000;
  assert.equal(isExpiredInQueue({ timestamp: now - 49 * h }, null, now), true); // default 48 h
  assert.equal(isExpiredInQueue({ timestamp: now - 47 * h }, null, now), false);
  assert.equal(isExpiredInQueue({ timestamp: now - 49 * h, opts: { delay: 24 * h } }, null, now), false); // scheduled send
  assert.equal(isExpiredInQueue({ timestamp: now - 3 * h }, { outboundRetentionHours: 2 }, now), true);
});

test('queue cleaner plan: dead letters only with autoFlushDead', () => {
  assert.deepEqual(queueCleanPlan(null), { completedGraceMs: 24 * 3_600_000, failedGraceMs: null });
  assert.deepEqual(queueCleanPlan({ autoFlushDead: true, deadLetterRetentionDays: 2, completedRetentionHours: 1 }),
    { completedGraceMs: 3_600_000, failedGraceMs: 2 * 86_400_000 });
});

// ── iTIP REPLY ────────────────────────────────────────────────────────────────

const VCAL = [
  'BEGIN:VCALENDAR', 'METHOD:REPLY', 'BEGIN:VEVENT', 'UID:evt-1@example.org', 'SEQUENCE:2',
  'ATTENDEE;PARTSTAT=ACCEPTED;CN=Bob:mailto:bob@partner.example', 'END:VEVENT', 'END:VCALENDAR',
].join('\r\n');

function mail(from: string, calPart: string): Buffer {
  return Buffer.from([
    `From: ${from}`, 'To: alice@local.example', 'Subject: Accepted', 'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="b1"', '', '--b1', 'Content-Type: text/plain', '', 'Accepted', '--b1',
    calPart, '--b1--', '',
  ].join('\r\n'));
}
const b64Part = `Content-Type: text/calendar; method=REPLY; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(VCAL).toString('base64').replace(/(.{76})/g, '$1\r\n')}`;
const qpPart = `Content-Type: text/calendar; method=REPLY\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${VCAL.replace(/=/g, '=3D').replace('ATTENDEE;PARTSTAT', 'ATTENDEE;PART=\r\nSTAT')}`;

test('REPLY is found in base64 and quoted-printable calendar parts', () => {
  assert.equal(extractITipReply(mail('Bob <bob@partner.example>', b64Part))?.partstat, 'ACCEPTED');
  const qp = extractITipReply(mail('bob@partner.example', qpPart));
  assert.equal(qp?.uid, 'evt-1@example.org');
  assert.equal(qp?.attendeeEmail, 'bob@partner.example');
});

test('REPLY with several ATTENDEE lines is refused', () => {
  const two = VCAL.replace('END:VEVENT', 'ATTENDEE;PARTSTAT=DECLINED:mailto:carol@x.example\r\nEND:VEVENT');
  assert.equal(parseITipReply(two), null);
});

test('sender check: From must equal attendee, envelope attendee or same domain', () => {
  const m = mail('Bob <bob@partner.example>', b64Part);
  assert.equal(isReplyFromAttendee(m, 'bob@partner.example', 'bob@partner.example'), true);
  assert.equal(isReplyFromAttendee(m, 'bounces+123@partner.example', 'bob@partner.example'), true);
  assert.equal(isReplyFromAttendee(m, 'mallory@evil.example', 'bob@partner.example'), false);
  assert.equal(isReplyFromAttendee(mail('mallory@evil.example', b64Part), 'mallory@evil.example', 'bob@partner.example'), false);
  assert.equal(isReplyFromAttendee(m, '', 'bob@partner.example'), false);
});

test('processITipInbound scopes the event lookup to the recipient and rejects foreign senders', async () => {
  const queries: unknown[] = [];
  const updates: unknown[] = [];
  fakePrisma['calendarEvent'] = {
    findFirst: async (q: unknown) => { queries.push(q); return { id: 'e1', sequence: 1, attendees: [{ email: 'Bob@partner.example', partstat: 'NEEDS-ACTION' }] }; },
    update: async (u: unknown) => { updates.push(u); return {}; },
  };
  const m = mail('Bob <bob@partner.example>', b64Part);
  assert.equal(await processITipInbound(m, { envelopeFrom: 'mallory@evil.example', recipientUserId: 'u1' }), false);
  assert.equal(await processITipInbound(m, { envelopeFrom: 'bob@partner.example', recipientUserId: null }), false);
  assert.equal(queries.length, 0);
  assert.equal(await processITipInbound(m, { envelopeFrom: 'bob@partner.example', recipientUserId: 'u1' }), true);
  assert.deepEqual((queries[0] as { where: unknown }).where, { uid: { equals: 'evt-1@example.org', mode: 'insensitive' }, calendar: { userId: 'u1' } });
  assert.equal(((updates[0] as { data: { attendees: Array<{ partstat: string }> } }).data.attendees[0]!).partstat, 'ACCEPTED');
});
