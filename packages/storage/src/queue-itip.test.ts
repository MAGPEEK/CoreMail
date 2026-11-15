import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';
process.env['NODE_ENV'] = 'test';
const fakePrisma: Record<string, unknown> = { $on: () => undefined };
(globalThis as unknown as { __prisma: unknown }).__prisma = fakePrisma;

const {
  buildOutboundJobOptions, isExpiredInQueue, queueCleanPlan, normalizeQueueSettings,
  attemptsForRetention, outboundRetryStepMs, outboundRetryDelay,
} = await import('./queue-options.js');
const {
  extractITipReply, isReplyFromAttendee, processITipInbound, parseITipReply, applyReplyToIcal, MAX_REPLY_OVERRIDES, MAX_REPLY_STAMPS,
} = await import('./itip-inbound.js');

// ── queue options per settings ────────────────────────────────────────────────

test('outbound job options follow QueueSettings', () => {
  const d = buildOutboundJobOptions(null);
  assert.deepEqual(d, {
    // v8.1: enough attempts for 48 h (1 + 5 + 15 min, then every 30 min) + the expiry attempt
    attempts: attemptsForRetention(48),
    backoff: { type: 'coremail-outbound', delay: 60_000 },
    removeOnComplete: { age: 24 * 3600, count: 100 },
    removeOnFail: { count: 10_000 },
  });
  assert.ok(d.attempts > 90 && d.attempts < 110, String(d.attempts));
  const s = buildOutboundJobOptions({ maxRetryAttempts: 4, retryBackoffDelaySec: 30, completedRetentionHours: 2, deadLetterRetentionDays: 3, autoFlushDead: true, outboundRetentionHours: 1 });
  assert.equal(s.attempts, attemptsForRetention(1, 30_000), 'expiry window wins over a small maxRetryAttempts');
  assert.equal(buildOutboundJobOptions({ maxRetryAttempts: 500 }).attempts, 500, 'maxRetryAttempts is a minimum');
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

test('v8.1 retry schedule: 1, 5, 15, then every 30 min, capped at the expiry', () => {
  const min = 60_000;
  const h = 3_600_000;
  assert.deepEqual([1, 2, 3, 4, 5, 50].map((n) => outboundRetryStepMs(n)), [min, 5 * min, 15 * min, 30 * min, 30 * min, 30 * min]);
  assert.equal(outboundRetryStepMs(1, 10 * min), 10 * min, 'first step = retryBackoffDelaySec');
  assert.equal(outboundRetryStepMs(2, 10 * min), 10 * min, 'never shorter than the first step');

  const now = 1_000_000_000_000;
  // early in the window: the plain step
  assert.equal(outboundRetryDelay(4, { timestamp: now - h }, null, now), 30 * min);
  // 10 min before the 48 h expiry: pulled forward to 1 s past the expiry
  assert.equal(outboundRetryDelay(90, { timestamp: now - 48 * h + 10 * min }, null, now), 10 * min + 1000);
  // already expired: retry right away so the worker gives up (final NDR)
  assert.equal(outboundRetryDelay(90, { timestamp: now - 50 * h }, null, now), 1000);
  // scheduled send: the window starts at the planned time
  assert.equal(outboundRetryDelay(4, { timestamp: now - 50 * h, opts: { delay: 24 * h } }, null, now), 30 * min);

  // simulate the whole window: the retries reach the expiry within `attempts`
  const opts = buildOutboundJobOptions(null);
  let t = 0;
  let attempt = 1;
  while (!isExpiredInQueue({ timestamp: 0 }, null, t)) {
    t += outboundRetryDelay(attempt, { timestamp: 0 }, null, t);
    attempt++;
  }
  assert.ok(attempt <= opts.attempts, `${attempt} attempts needed, ${opts.attempts} configured`);
  assert.ok(t >= 48 * h && t <= 48 * h + 2000, `gives up at ${t / h} h`);
});

test('queue cleaner plan: dead letters only with autoFlushDead', () => {
  assert.deepEqual(queueCleanPlan(null), { completedGraceMs: 24 * 3_600_000, failedGraceMs: null });
  assert.deepEqual(queueCleanPlan({ autoFlushDead: true, deadLetterRetentionDays: 2, completedRetentionHours: 1 }),
    { completedGraceMs: 3_600_000, failedGraceMs: 2 * 86_400_000 });
});

// ── iTIP REPLY ────────────────────────────────────────────────────────────────

const AUTH = { verifiedDomains: ['partner.example'] };

test('attendee authentication: aligned DMARC/SPF/DKIM domain or the authenticated local sender', async () => {
  const { isAttendeeAuthenticated } = await import('./itip-inbound.js');
  assert.equal(isAttendeeAuthenticated('bob@partner.example', AUTH), true);
  assert.equal(isAttendeeAuthenticated('bob@mail.partner.example', AUTH), true);
  assert.equal(isAttendeeAuthenticated('bob@partner.example', { verifiedDomains: ['mail.partner.example'] }), true);
  assert.equal(isAttendeeAuthenticated('bob@partner.example', { verifiedDomains: ['notpartner.example'] }), false);
  assert.equal(isAttendeeAuthenticated('bob@corp.test', { authenticatedSender: 'Bob@corp.test' }), true);
  assert.equal(isAttendeeAuthenticated('bob@corp.test', { authenticatedSender: 'alice@corp.test' }), false);
  assert.equal(isAttendeeAuthenticated('bob@partner.example', null), false);
  assert.equal(isAttendeeAuthenticated('bob@partner.example', {}), false);
});

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
  assert.equal(await processITipInbound(m, { envelopeFrom: 'mallory@evil.example', recipientUserId: 'u1', senderAuth: AUTH }), false);
  assert.equal(await processITipInbound(m, { envelopeFrom: 'bob@partner.example', recipientUserId: null, senderAuth: AUTH }), false);
  // forged From header: no authentication verdict, or one for another domain → ignored
  assert.equal(await processITipInbound(m, { envelopeFrom: 'bob@partner.example', recipientUserId: 'u1', senderAuth: null }), false);
  assert.equal(await processITipInbound(m, { envelopeFrom: 'bob@partner.example', recipientUserId: 'u1', senderAuth: { verifiedDomains: [] } }), false);
  assert.equal(await processITipInbound(m, { envelopeFrom: 'bob@partner.example', recipientUserId: 'u1', senderAuth: { verifiedDomains: ['evil.example'] } }), false);
  assert.equal(await processITipInbound(m, { envelopeFrom: 'bob@partner.example', recipientUserId: 'u1', senderAuth: { authenticatedSender: 'carol@partner.example' } }), false);
  assert.equal(queries.length, 0);
  assert.equal(await processITipInbound(m, { envelopeFrom: 'bob@partner.example', recipientUserId: 'u1', senderAuth: AUTH }), true);
  assert.deepEqual((queries[0] as { where: unknown }).where, { uid: 'evt-1@example.org', calendar: { userId: 'u1' } });
  assert.equal(((updates[0] as { data: { attendees: Array<{ partstat: string }> } }).data.attendees[0]!).partstat, 'ACCEPTED');
});

// ── v7.1.0: REPLY → icalData, RECURRENCE-ID, DTSTAMP ordering, organizer check ──

const STORED = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:evt-1@example.org', 'SEQUENCE:2',
  'DTSTART:20261102T090000Z', 'DTEND:20261102T100000Z', 'RRULE:FREQ=WEEKLY;COUNT=4', 'SUMMARY:Weekly',
  'ORGANIZER:mailto:alice@local.example',
  'ATTENDEE;CN="Doe: Bob";PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:bob@partner.example',
  'BEGIN:VALARM', 'TRIGGER:-PT5M', 'ACTION:DISPLAY', 'END:VALARM',
  'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n');

function replyMail(extra: string[], partstat = 'ACCEPTED', attendeeParams = ''): Buffer {
  const vcal = ['BEGIN:VCALENDAR', 'METHOD:REPLY', 'BEGIN:VEVENT', 'UID:evt-1@example.org', 'SEQUENCE:2', ...extra,
    `ATTENDEE${attendeeParams};PARTSTAT=${partstat}:mailto:bob@partner.example`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  return mail('Bob <bob@partner.example>', `Content-Type: text/calendar; method=REPLY\r\n\r\n${vcal}`);
}

function fakeEvent(over: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id: 'e1', sequence: 2, organizer: 'alice@local.example', icalData: STORED,
    attendees: [{ email: 'bob@partner.example', partstat: 'NEEDS-ACTION' }], ...over,
  };
  const updates: Array<Record<string, unknown>> = [];
  fakePrisma['calendarEvent'] = {
    findFirst: async () => row,
    update: async (u: { data: Record<string, unknown> }) => { updates.push(u.data); Object.assign(row, u.data); return row; },
  };
  fakePrisma['user'] = { findUnique: async () => ({ email: 'alice@local.example' }) };
  fakePrisma['emailAlias'] = { findMany: async () => [{ address: 'team@local.example' }] };
  return { row, updates };
}

test('REPLY parser handles quoted parameter values containing ":" (CN="Doe: J")', () => {
  const r = extractITipReply(replyMail(['DTSTAMP:20261101T000000Z'], 'TENTATIVE', ';CN="Doe: Bob";DELEGATED-FROM="mailto:x@partner.example"'));
  assert.equal(r?.attendeeEmail, 'bob@partner.example');
  assert.equal(r?.partstat, 'TENTATIVE');
  assert.equal(r?.dtstamp?.toISOString(), '2026-11-01T00:00:00.000Z');
});

test('REPLY updates the PARTSTAT inside icalData (what CalDAV serves), keeping the rest', async () => {
  const { row } = fakeEvent();
  assert.equal(await processITipInbound(replyMail(['DTSTAMP:20261101T000000Z']), { envelopeFrom: 'bob@partner.example', recipientUserId: 'u1', senderAuth: AUTH }), true);
  const ical = String(row['icalData']).replace(/\r\n /g, '');
  assert.match(ical, /^ATTENDEE;CN="Doe: Bob";PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:bob@partner.example$/m);
  assert.match(ical, /BEGIN:VALARM/);
  assert.match(ical, /RRULE:FREQ=WEEKLY;COUNT=4/);
  assert.equal((row['attendees'] as Array<{ partstat: string }>)[0]!.partstat, 'ACCEPTED');
});

test('REPLY with RECURRENCE-ID only touches that instance (override created, series unchanged)', async () => {
  const { row } = fakeEvent();
  assert.equal(await processITipInbound(replyMail(['RECURRENCE-ID:20261109T090000Z', 'DTSTAMP:20261101T000000Z'], 'DECLINED'),
    { envelopeFrom: 'bob@partner.example', recipientUserId: 'u1', senderAuth: AUTH }), true);
  const ical = String(row['icalData']).replace(/\r\n /g, '');
  const blocks = ical.split('BEGIN:VEVENT').slice(1);
  assert.equal(blocks.length, 2);
  assert.match(blocks[0]!, /PARTSTAT=NEEDS-ACTION/);                     // master unchanged
  assert.match(blocks[1]!, /RECURRENCE-ID:20261109T090000Z/);
  assert.match(blocks[1]!, /DTSTART:20261109T090000Z/);
  assert.match(blocks[1]!, /PARTSTAT=DECLINED/);
  assert.doesNotMatch(blocks[1]!, /RRULE/);
  assert.equal((row['attendees'] as Array<{ partstat: string }>)[0]!.partstat, 'NEEDS-ACTION');
});

test('REPLY with the same SEQUENCE but an older DTSTAMP than the last applied one is ignored', async () => {
  const { row, updates } = fakeEvent();
  const ctx = { envelopeFrom: 'bob@partner.example', recipientUserId: 'u1', senderAuth: AUTH };
  assert.equal(await processITipInbound(replyMail(['DTSTAMP:20261105T000000Z'], 'DECLINED'), ctx), true);
  assert.equal(await processITipInbound(replyMail(['DTSTAMP:20261101T000000Z'], 'ACCEPTED'), ctx), false);
  assert.equal(updates.length, 1);
  assert.equal((row['attendees'] as Array<{ partstat: string }>)[0]!.partstat, 'DECLINED');
  assert.equal(await processITipInbound(replyMail(['DTSTAMP:20261106T000000Z'], 'ACCEPTED'), ctx), true);
});

test('REPLY is only applied to the organizer copy (recipient address or alias = ORGANIZER)', async () => {
  const ctx = { envelopeFrom: 'bob@partner.example', recipientUserId: 'u1', senderAuth: AUTH };
  fakeEvent({ organizer: 'carol@elsewhere.example' });
  assert.equal(await processITipInbound(replyMail([]), ctx), false);
  fakeEvent({ organizer: 'TEAM@local.example' });
  assert.equal(await processITipInbound(replyMail([]), ctx), true);
});

// ── v8.0 review: phantom occurrences and unbounded growth ─────────────────────

test('REPLY with a RECURRENCE-ID that is not an instance of the series adds no override', async () => {
  const ctx = { envelopeFrom: 'bob@partner.example', recipientUserId: 'u1', senderAuth: AUTH };
  // Series: weekly 2026-11-02 09:00Z, COUNT=4 → 02, 09, 16, 23 Nov.
  for (const rid of ['20261110T090000Z', '20261109T100000Z', '20261130T090000Z', '20991231T090000Z']) {
    const { row, updates } = fakeEvent();
    assert.equal(await processITipInbound(replyMail([`RECURRENCE-ID:${rid}`, 'DTSTAMP:20261101T000000Z'], 'DECLINED'), ctx), false, rid);
    assert.equal(updates.length, 0, rid);
    assert.equal(String(row['icalData']).split('BEGIN:VEVENT').length, 2, rid);
  }
  const { row } = fakeEvent();
  assert.equal(await processITipInbound(replyMail(['RECURRENCE-ID:20261123T090000Z', 'DTSTAMP:20261101T000000Z'], 'DECLINED'), ctx), true,
    'the last real instance is accepted');
  assert.match(String(row['icalData']), /RECURRENCE-ID:20261123T090000Z/);
});

test('REPLY overrides and per-instance stamps are capped', async () => {
  const ctx = { envelopeFrom: 'bob@partner.example', recipientUserId: 'u1', senderAuth: AUTH };
  const daily = STORED.replace('RRULE:FREQ=WEEKLY;COUNT=4', 'RRULE:FREQ=DAILY;COUNT=500');
  const instance = (i: number): string => new Date(Date.UTC(2026, 10, 2 + i, 9)).toISOString().replace(/[-:]/g, '').replace('.000', '');
  // Stamps: MAX_REPLY_STAMPS distinct instances already answered → a new instance is ignored.
  const stamps: Record<string, string> = {};
  for (let i = 1; i <= MAX_REPLY_STAMPS; i++) stamps[`k${i}`] = '2026-11-01T00:00:00.000Z';
  const { updates } = fakeEvent({ icalData: daily, attendees: [{ email: 'bob@partner.example', partstat: 'NEEDS-ACTION', replyStamps: stamps }] });
  assert.equal(await processITipInbound(replyMail([`RECURRENCE-ID:${instance(3)}`, 'DTSTAMP:20261101T000000Z']), ctx), false);
  assert.equal(updates.length, 0);
  // Overrides: an object that already holds MAX_REPLY_OVERRIDES overrides gets no new one.
  let ical: string | null = daily;
  for (let i = 1; i <= MAX_REPLY_OVERRIDES; i++) {
    ical = applyReplyToIcal(ical!, 'bob@partner.example', 'DECLINED', { date: new Date(Date.UTC(2026, 10, 2 + i, 9)) } as never);
    assert.ok(ical, `override ${i}`);
  }
  assert.equal(applyReplyToIcal(ical!, 'bob@partner.example', 'DECLINED', { date: new Date(Date.UTC(2026, 10, 2 + MAX_REPLY_OVERRIDES + 1, 9)) } as never), null);
  // An existing override can still be updated.
  assert.ok(applyReplyToIcal(ical!, 'bob@partner.example', 'ACCEPTED', { date: new Date(Date.UTC(2026, 10, 3, 9)) } as never));
});