/**
 * 9.5: resource mailboxes answer invitations that arrive by mail with an iMIP REPLY to
 * the organizer — content and headers, loop safety, series with declined occurrences,
 * and the wiring into processResourceMailboxes (no reply for CANCEL, REPLY, unauthenticated
 * organizers or with "send replies" off).
 * Run: node --import tsx --import ../storage/src/test-support/realtime-off.ts --test src/handlers/resource-reply.test.ts  (in packages/smtp-server)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';

interface Booking {
  id: string; calendarId: string; uid: string; organizer: string; status: string;
  summary: string; dtStart: Date; dtEnd: Date; icalData: string; conflicts: Array<{ start: string; end: string }>;
}
const bookings: Booking[] = [];
const ROOM = {
  id: 'r1', email: 'room@corp.test', displayName: 'Raum Elbe', active: true, autoAccept: true, requireApproval: false,
  autoDeclineConflict: true, allowRecurring: true, maxDurationMinutes: null as number | null, bookingWindowDays: 180,
  sendReplies: true, calendar: { id: 'cal1' },
};
const OTHER_ROOM = 'beamer@corp.test';
let room = { ...ROOM };
const db = {
  $on: () => undefined,
  $transaction: (fn: (tx: unknown) => unknown) => fn(db),
  resourceCalendar: { update: async ({ where }: { where: { id: string } }) => ({ id: where.id }) },
  resourceMailbox: {
    findFirst: async ({ where }: { where: { email: string } }) =>
      (where.email === room.email ? room : where.email === OTHER_ROOM ? { ...ROOM, id: 'r2', email: OTHER_ROOM } : null),
  },
  resourceBooking: {
    findUnique: async ({ where }: { where: { calendarId_uid: { calendarId: string; uid: string } } }) =>
      bookings.find((b) => b.calendarId === where.calendarId_uid.calendarId && b.uid === where.calendarId_uid.uid) ?? null,
    findMany: async ({ where }: { where: { calendarId: string; dtStart: { lt: Date } } }) =>
      bookings.filter((b) => b.calendarId === where.calendarId && b.dtStart < where.dtStart.lt).map((b) => ({ ...b })),
    create: async ({ data }: { data: Omit<Booking, 'id'> }) => { const b = { id: `b${bookings.length + 1}`, ...data }; bookings.push(b); return b; },
    update: async ({ where, data }: { where: { id: string }; data: Partial<Booking> }) => Object.assign(bookings.find((x) => x.id === where.id)!, data),
    delete: async ({ where }: { where: { id: string } }) => bookings.splice(bookings.findIndex((x) => x.id === where.id), 1)[0],
  },
};
(globalThis as unknown as { __prisma: unknown }).__prisma = db;

const { processResourceMailboxes } = await import('./resource-booking.js');
const {
  replySuppression, partstatFor, replySubject, buildResourceReplies, answerOrganizer, answeredEvents,
  setResourceReplyDeps, isPlainAddress, replyRateKey, MAX_OCCURRENCE_REPLIES, MAX_TEXT_CONFLICTS, MAX_SUBJECT_SUMMARY, REPLY_LIMIT,
} = await import('./resource-reply.js');
const { parseITipReply } = await import('@coremail/storage');

const NOW = new Date('2026-11-18T08:00:00Z');
const ORG = 'org@ext.test';
const AUTH = { verifiedDomains: ['ext.test'] };

const sent: Array<{ from: string; to: string; raw: Buffer }> = [];
/** In-memory reply counters (the Redis window never expires within a test). */
const counters = new Map<string, number>();
const testDeps = {
  isResourceAddress: async (a: string) => a === room.email || a === OTHER_ROOM,
  enqueue: async (job: { from: string; to: string; raw: Buffer }) => { sent.push(job); },
  allow: async (key: string, count: number) => {
    const total = (counters.get(key) ?? 0) + count;
    counters.set(key, total);
    return total <= REPLY_LIMIT;
  },
};
setResourceReplyDeps(testDeps);
beforeEach(() => { bookings.length = 0; sent.length = 0; counters.clear(); room = { ...ROOM }; });

function vcal(method: string, events: string[][]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', `METHOD:${method}`,
    ...events.flatMap((e) => ['BEGIN:VEVENT', ...e, 'END:VEVENT']), 'END:VCALENDAR', ''].join('\r\n');
}
const event = (uid: string, start: string, end: string, more: string[] = []): string[] =>
  [`UID:${uid}`, `ORGANIZER:mailto:${ORG}`, `DTSTART:${start}`, `DTEND:${end}`, 'SUMMARY:Jour fixe', 'SEQUENCE:2', ...more];
const mail = (ical: string, headers: string[] = []): Buffer =>
  Buffer.from([`From: Org <${ORG}>`, `To: ${ROOM.email}`, 'Subject: Einladung', 'Message-ID: <req-1@ext.test>', ...headers, '', ical].join('\r\n'));
const send = (ical: string, opts: { envelope?: string; headers?: string[]; auth?: typeof AUTH | null } = {}) =>
  processResourceMailboxes(mail(ical, opts.headers), [ROOM.email], opts.envelope ?? ORG, opts.auth === undefined ? AUTH : opts.auth, NOW);
const booking = (uid: string): Booking => bookings.find((b) => b.uid === uid)!;
const WEEKLY = event('series', '20261201T093000Z', '20261201T103000Z', ['RRULE:FREQ=WEEKLY;COUNT=6']);

/** Pure helpers: the decoded text/plain and text/calendar parts and the header block of a reply. */
function decodePart(raw: Buffer, contentType: string): string {
  const text = raw.toString('utf8');
  const at = text.indexOf(`Content-Type: ${contentType}`);
  assert.ok(at >= 0, `no ${contentType} part`);
  const body = text.slice(text.indexOf('\r\n\r\n', at) + 4);
  return Buffer.from(body.slice(0, body.indexOf('\r\n--')).replace(/\s+/g, ''), 'base64').toString('utf8');
}
const head = (raw: Buffer): string => raw.toString('utf8').split('\r\n\r\n')[0]!;
const ics = (raw: Buffer): string => decodePart(raw, 'text/calendar');
const plain = (raw: Buffer): string => decodePart(raw, 'text/plain');

// ── loop safety (pure) ────────────────────────────────────────────────────────

const REQ = { method: 'REQUEST', icalData: vcal('REQUEST', [event('u', '20261201T090000Z', '20261201T100000Z')]), raw: mail(''), envelopeFrom: ORG, organizer: ORG, authenticated: true };

test('loop safety: only an authenticated REQUEST from a person gets an answer', () => {
  assert.equal(replySuppression(room, REQ), null);
  assert.equal(replySuppression({ ...room, sendReplies: false }, REQ), 'replies off');
  assert.equal(replySuppression(room, { ...REQ, method: 'CANCEL' }), 'not a request');
  assert.equal(replySuppression(room, { ...REQ, method: 'PUBLISH' }), 'not a request');
  assert.equal(replySuppression(room, { ...REQ, authenticated: false }), 'organizer not authenticated');
  assert.equal(replySuppression(room, { ...REQ, envelopeFrom: '' }), 'null sender');
  assert.equal(replySuppression(room, { ...REQ, envelopeFrom: '<>' }), 'null sender');
  assert.equal(replySuppression(room, { ...REQ, organizer: room.email }), 'own address');
  assert.equal(replySuppression(room, { ...REQ, organizer: 'mailer-daemon@ext.test' }), 'automated sender');
  assert.equal(replySuppression(room, { ...REQ, envelopeFrom: 'list-bounces@ext.test' }), 'automated sender');
  assert.equal(replySuppression(room, { ...REQ, raw: mail('', ['Auto-Submitted: auto-generated']) }), 'auto-submitted');
  assert.equal(replySuppression(room, { ...REQ, raw: mail('', ['Auto-Submitted: auto-replied; owner-email="x@ext.test"']) }), 'auto-submitted');
  assert.equal(replySuppression(room, { ...REQ, raw: mail('', ['Auto-Submitted: no']) }), null);
  assert.equal(replySuppression(room, { ...REQ, raw: mail('', ['Precedence: bulk']) }), 'precedence');
  assert.equal(replySuppression(room, { ...REQ, raw: mail('', ['List-Id: <team.ext.test>']) }), 'mailing list');
  assert.equal(replySuppression(room, { ...REQ, raw: mail('', ['X-Auto-Response-Suppress: AutoReply']) }), 'suppressed');
  assert.equal(replySuppression(room, { ...REQ, raw: mail('', ['X-Auto-Response-Suppress: OOF']) }), null);
});

test('loop safety: another resource mailbox as organizer gets no answer; a failing queue never throws', async () => {
  const answer = { decision: { status: 'ACCEPTED' as const }, conflicts: [], occurrencesOnly: false };
  assert.equal(await answerOrganizer(room, { ...REQ, organizer: OTHER_ROOM, envelopeFrom: OTHER_ROOM }, 'u', answer, NOW), 'organizer is a resource');
  assert.equal(sent.length, 0);
  const previous = setResourceReplyDeps({ ...testDeps, isResourceAddress: async () => false, enqueue: async () => { throw new Error('redis down'); } });
  try {
    assert.equal(await answerOrganizer(room, REQ, 'u', answer, NOW), 'error');
  } finally {
    setResourceReplyDeps(previous);
  }
});

// ── content and headers (pure) ───────────────────────────────────────────────

test('PARTSTAT and German subject per decision: accepted, declined, pending approval → tentative', () => {
  assert.equal(partstatFor({ status: 'ACCEPTED' }), 'ACCEPTED');
  assert.equal(partstatFor({ status: 'DECLINED', reason: 'conflict' }), 'DECLINED');
  assert.equal(partstatFor({ status: 'PENDING' }), 'TENTATIVE');
  assert.equal(replySubject('ACCEPTED', 'Jour fixe'), 'Angenommen: Jour fixe');
  assert.equal(replySubject('DECLINED', ' '), 'Abgelehnt: Besprechung');
  assert.equal(replySubject('TENTATIVE', 'X'), 'Mit Vorbehalt angenommen: X');
});

test('accepted: REPLY from the room to the organizer, one ATTENDEE, auto-replied, threaded to the request', () => {
  const [raw, ...rest] = buildResourceReplies(room, REQ, 'u', { decision: { status: 'ACCEPTED' }, conflicts: [], occurrencesOnly: false }, NOW);
  assert.equal(rest.length, 0);
  const h = head(raw!);
  assert.match(h, /^From: "Raum Elbe" <room@corp\.test>$/m);
  assert.match(h, /^To: org@ext\.test$/m);
  assert.match(h, /^Subject: Angenommen: Jour fixe$/m);
  assert.match(h, /^Auto-Submitted: auto-replied$/m);
  assert.match(h, /^X-Auto-Response-Suppress: All$/m);
  assert.match(h, /^In-Reply-To: <req-1@ext\.test>$/m);
  assert.match(h, /^References: <req-1@ext\.test>$/m);
  const cal = ics(raw!);
  assert.match(cal, /^METHOD:REPLY$/m);
  assert.match(cal, /^UID:u$/m);
  assert.match(cal, /^SEQUENCE:2$/m);
  assert.match(cal, /^ORGANIZER:mailto:org@ext\.test$/m);
  assert.equal(cal.match(/^ATTENDEE/gm)?.length, 1);
  assert.match(cal.replace(/\r\n /g, ''), /^ATTENDEE;CN=Raum Elbe;.*PARTSTAT=ACCEPTED.*:mailto:room@corp\.test$/m);
  const parsed = parseITipReply(cal);
  assert.equal(parsed?.attendeeEmail, 'room@corp.test');
  assert.equal(parsed?.partstat, 'ACCEPTED');
  const text = plain(raw!);
  assert.match(text, /Raum Elbe hat Ihre Buchung angenommen\./);
  assert.match(text, /Besprechung: Jour fixe/);
  assert.match(text, /01\.12\.2026/);
  assert.doesNotMatch(text, /Exchange|RFC/);
});

test('declined for conflicts: the dates are listed (capped); other reasons name the rule', () => {
  const conflicts = Array.from({ length: MAX_TEXT_CONFLICTS + 3 }, (_, i) => ({
    dtStart: new Date(Date.UTC(2026, 11, 1 + i, 9)), dtEnd: new Date(Date.UTC(2026, 11, 1 + i, 10)),
  }));
  const [raw] = buildResourceReplies(room, REQ, 'u', { decision: { status: 'DECLINED', reason: 'conflict' }, conflicts, occurrencesOnly: false }, NOW);
  assert.match(head(raw!), /^Subject: Abgelehnt: Jour fixe$/m);
  assert.equal(parseITipReply(ics(raw!))?.partstat, 'DECLINED');
  const text = plain(raw!);
  assert.match(text, /hat Ihre Buchung abgelehnt/);
  assert.match(text, /Grund: Die Ressource ist zu folgenden Terminen bereits belegt:/);
  assert.match(text, /- .*02\.12\.2026/);
  assert.match(text, /… und 3 weitere/);

  const reason = (decision: { status: 'DECLINED'; reason: 'window' | 'duration' | 'recurring' | 'too-frequent' | 'inactive' }) =>
    plain(buildResourceReplies({ ...room, maxDurationMinutes: 120, bookingWindowDays: 90 }, REQ, 'u', { decision, conflicts: [], occurrencesOnly: false }, NOW)[0]!);
  assert.match(reason({ status: 'DECLINED', reason: 'window' }), /außerhalb des Buchungszeitraums \(höchstens 90 Tage im Voraus\)/);
  assert.match(reason({ status: 'DECLINED', reason: 'duration' }), /länger als erlaubt \(höchstens 120 Minuten\)/);
  assert.match(reason({ status: 'DECLINED', reason: 'recurring' }), /Serientermine sind für diese Ressource nicht erlaubt/);
  assert.match(reason({ status: 'DECLINED', reason: 'too-frequent' }), /wiederholt sich zu häufig/);
  assert.match(reason({ status: 'DECLINED', reason: 'inactive' }), /derzeit nicht buchbar/);
});

test('accepted with conflicts listed (room does not decline conflicts) and pending approval texts', () => {
  const conflicts = [{ dtStart: new Date('2026-12-15T09:30:00Z'), dtEnd: new Date('2026-12-15T10:30:00Z') }];
  const accepted = plain(buildResourceReplies(room, REQ, 'u', { decision: { status: 'ACCEPTED' }, conflicts, occurrencesOnly: false }, NOW)[0]!);
  assert.match(accepted, /Hinweis: Zu folgenden Terminen ist die Ressource bereits belegt:\n- .*15\.12\.2026/);
  const [pending] = buildResourceReplies(room, REQ, 'u', { decision: { status: 'PENDING' }, conflicts: [], occurrencesOnly: false }, NOW);
  assert.match(head(pending!), /^Subject: Mit Vorbehalt angenommen: Jour fixe$/m);
  assert.equal(parseITipReply(ics(pending!))?.partstat, 'TENTATIVE');
  assert.match(plain(pending!), /muss noch genehmigt werden/);
});

test('times are written in the meeting zone; an organizer missing in the request comes from the mail', () => {
  const zoned = vcal('REQUEST', [['UID:z', 'DTSTART;TZID=Europe/Berlin:20261201T093000', 'DTEND;TZID=Europe/Berlin:20261201T103000', 'SUMMARY:Zone']]);
  const [ev] = answeredEvents(zoned, 'z', ORG);
  assert.equal(ev?.event.organizer, ORG);
  const text = plain(buildResourceReplies(room, { ...REQ, icalData: zoned }, 'z', { decision: { status: 'ACCEPTED' }, conflicts: [], occurrencesOnly: false }, NOW)[0]!);
  assert.match(text, /01\.12\.2026, 09:30/);
  assert.match(ics(buildResourceReplies(room, { ...REQ, icalData: zoned }, 'z', { decision: { status: 'ACCEPTED' }, conflicts: [], occurrencesOnly: false }, NOW)[0]!), /^ORGANIZER:mailto:org@ext\.test$/m);
});

test('a request with single occurrences is answered per occurrence (RECURRENCE-ID), capped', () => {
  const many = vcal('REQUEST', Array.from({ length: MAX_OCCURRENCE_REPLIES + 2 }, (_, i) =>
    event('s', `202612${String(i + 1).padStart(2, '0')}T140000Z`, `202612${String(i + 1).padStart(2, '0')}T150000Z`,
      [`RECURRENCE-ID:202612${String(i + 1).padStart(2, '0')}T093000Z`])));
  assert.equal(answeredEvents(many, 's', ORG).length, MAX_OCCURRENCE_REPLIES);
});

// ── wiring: processResourceMailboxes ─────────────────────────────────────────

test('mailed request accepted → one REPLY ACCEPTED from the room to the organizer', async () => {
  await send(vcal('REQUEST', [event('m1', '20261201T090000Z', '20261201T100000Z')]));
  assert.equal(booking('m1').status, 'ACCEPTED');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.from, ROOM.email);
  assert.equal(sent[0]!.to, ORG);
  assert.equal(parseITipReply(ics(sent[0]!.raw))?.partstat, 'ACCEPTED');
});

test('series declined for a conflicting occurrence → one series REPLY DECLINED listing the date', async () => {
  await send(vcal('REQUEST', [event('blocker', '20261215T090000Z', '20261215T100000Z')]));
  sent.length = 0;
  await send(vcal('REQUEST', [WEEKLY]));
  assert.equal(booking('series').status, 'DECLINED');
  assert.equal(sent.length, 1);
  const cal = ics(sent[0]!.raw);
  assert.match(cal, /^RRULE:FREQ=WEEKLY;COUNT=6$/m);
  assert.doesNotMatch(cal, /RECURRENCE-ID/);
  assert.equal(parseITipReply(cal)?.partstat, 'DECLINED');
  assert.match(plain(sent[0]!.raw), /15\.12\.2026/);
});

test('series with a declined occurrence update → the series stays booked, a DECLINED REPLY for that occurrence only', async () => {
  await send(vcal('REQUEST', [WEEKLY]));
  await send(vcal('REQUEST', [event('blocker', '20261208T140000Z', '20261208T150000Z')]));
  sent.length = 0;
  // the second occurrence moves onto the blocker
  await send(vcal('REQUEST', [event('series', '20261208T140000Z', '20261208T150000Z', ['RECURRENCE-ID:20261208T093000Z'])]));
  assert.equal(booking('series').status, 'ACCEPTED', 'the series keeps its answer');
  assert.equal(sent.length, 1);
  const cal = ics(sent[0]!.raw);
  const parsed = parseITipReply(cal);
  assert.equal(parsed?.partstat, 'DECLINED');
  assert.equal(parsed?.recurrenceId?.date.toISOString(), '2026-12-08T09:30:00.000Z');
  assert.doesNotMatch(cal, /RRULE/);
  const text = plain(sent[0]!.raw);
  assert.match(text, /hat die Änderung dieses Einzeltermins abgelehnt\. Die übrigen Termine der Serie bleiben gebucht\./);
  assert.match(text, /08\.12\.2026/);

  sent.length = 0;
  await send(vcal('REQUEST', [event('series', '20261222T160000Z', '20261222T170000Z', ['RECURRENCE-ID:20261222T093000Z'])]));
  assert.equal(sent.length, 1);
  const moved = parseITipReply(ics(sent[0]!.raw));
  assert.equal(moved?.partstat, 'ACCEPTED', 'a free occurrence update is accepted');
  assert.equal(moved?.recurrenceId?.date.toISOString(), '2026-12-22T09:30:00.000Z');
});

test('no answer: CANCEL, unauthenticated organizer, null sender, auto-submitted, replies off', async () => {
  await send(vcal('REQUEST', [event('c1', '20261201T090000Z', '20261201T100000Z')]));
  sent.length = 0;
  await send(vcal('CANCEL', [event('c1', '20261201T090000Z', '20261201T100000Z')]));
  assert.equal(bookings.length, 0, 'cancelled');
  await send(vcal('REQUEST', [event('p1', '20261202T090000Z', '20261202T100000Z')]), { auth: null });
  assert.equal(booking('p1').status, 'PENDING');
  await send(vcal('REQUEST', [event('n1', '20261203T090000Z', '20261203T100000Z')]), { envelope: '' });
  await send(vcal('REQUEST', [event('a1', '20261204T090000Z', '20261204T100000Z')]), { headers: ['Auto-Submitted: auto-generated'] });
  room = { ...ROOM, sendReplies: false };
  await send(vcal('REQUEST', [event('o1', '20261205T090000Z', '20261205T100000Z')]));
  assert.equal(booking('o1').status, 'ACCEPTED', 'the booking is decided anyway');
  assert.equal(sent.length, 0);
});

test('pending approval (authenticated organizer) → REPLY TENTATIVE', async () => {
  room = { ...ROOM, requireApproval: true };
  await send(vcal('REQUEST', [event('t1', '20261201T090000Z', '20261201T100000Z')]));
  assert.equal(booking('t1').status, 'PENDING');
  assert.equal(sent.length, 1);
  assert.equal(parseITipReply(ics(sent[0]!.raw))?.partstat, 'TENTATIVE');
});

test('a REPLY (e.g. echoed back inside a bounce) sent to a room neither books it nor gets an answer', async () => {
  const reply = vcal('REPLY', [[...event('r1', '20261201T090000Z', '20261201T100000Z'), `ATTENDEE;PARTSTAT=ACCEPTED:mailto:${ROOM.email}`]]);
  assert.deepEqual(await send(reply), [ROOM.email]);
  assert.equal(bookings.length, 0);
  assert.equal(sent.length, 0);
});

// ── review: backscatter and abuse limits ─────────────────────────────────────

test('review: an ORGANIZER that is an address list never gets an answer (no extra envelope recipient)', async () => {
  assert.equal(isPlainAddress('org@ext.test'), true);
  assert.equal(isPlainAddress('o.rg+tag@sub.ext.test'), true);
  for (const bad of ['victim@other.test,org@ext.test', 'a@b', 'a b@ext.test', '<org@ext.test>', 'org@ext.test.', 'org@@ext.test', '@ext.test', 'org@ext..test']) {
    assert.equal(isPlainAddress(bad), false, bad);
  }
  assert.equal(replySuppression(room, { ...REQ, organizer: 'victim@other.test,org@ext.test' }), 'invalid organizer address');
  // wiring: the domain after the last "@" is the authenticated one, the list still gets no mail
  const listOrganizer = vcal('REQUEST', [[
    'UID:l1', 'ORGANIZER:mailto:victim@other.test,org@ext.test', 'DTSTART:20261201T090000Z', 'DTEND:20261201T100000Z', 'SUMMARY:x',
  ]]);
  await send(listOrganizer);
  assert.equal(sent.length, 0);
});

test('review: replies per resource and organizer are rate limited; the booking is decided anyway', async () => {
  const answer = { decision: { status: 'ACCEPTED' as const }, conflicts: [], occurrencesOnly: false };
  for (let i = 0; i < REPLY_LIMIT; i++) assert.equal(await answerOrganizer(room, REQ, `u${i}`, answer, NOW), 1);
  assert.equal(await answerOrganizer(room, REQ, 'over', answer, NOW), 'rate limited');
  assert.equal(sent.length, REPLY_LIMIT);
  // another organizer (and another resource) has its own counter
  assert.equal(await answerOrganizer(room, { ...REQ, organizer: 'other@ext.test', envelopeFrom: 'other@ext.test' }, 'o', answer, NOW), 1);
  assert.notEqual(replyRateKey(room.email, ORG), replyRateKey(OTHER_ROOM, ORG));
  assert.equal(replyRateKey('Room@Corp.test', 'ORG@ext.test'), replyRateKey(room.email, ORG));

  sent.length = 0;
  await send(vcal('REQUEST', [event('late', '20261201T090000Z', '20261201T100000Z')]));
  assert.equal(booking('late').status, 'ACCEPTED');
  assert.equal(sent.length, 0);
});

test('review: occurrence replies count one each against the limit; no counter → no mail (fail closed)', async () => {
  const occurrences = vcal('REQUEST', Array.from({ length: 4 }, (_, i) =>
    event('s', `2026120${i + 1}T140000Z`, `2026120${i + 1}T150000Z`, [`RECURRENCE-ID:2026120${i + 1}T093000Z`])));
  const answer = { decision: { status: 'ACCEPTED' as const }, conflicts: [], occurrencesOnly: false };
  assert.equal(await answerOrganizer(room, { ...REQ, icalData: occurrences }, 's', answer, NOW), 4);
  assert.equal(counters.get(replyRateKey(room.email, ORG)), 4);
  const previous = setResourceReplyDeps({ ...testDeps, allow: async () => { throw new Error('redis down'); } });
  try {
    sent.length = 0;
    assert.equal(await answerOrganizer(room, REQ, 'u', answer, NOW), 'error');
    assert.equal(sent.length, 0);
  } finally {
    setResourceReplyDeps(previous);
  }
});

test('review: a very long meeting title is shortened in the subject (header line stays short)', () => {
  const subject = replySubject('ACCEPTED', 'A'.repeat(5000));
  assert.equal([...subject.slice('Angenommen: '.length)].length, MAX_SUBJECT_SUMMARY);
  assert.ok(subject.endsWith('…'));
  const longReq = { ...REQ, icalData: vcal('REQUEST', [['UID:u', `ORGANIZER:mailto:${ORG}`, 'DTSTART:20261201T090000Z', 'DTEND:20261201T100000Z', `SUMMARY:${'Ä'.repeat(3000)}`]]) };
  const [raw] = buildResourceReplies(room, longReq, 'u', { decision: { status: 'ACCEPTED' }, conflicts: [], occurrencesOnly: false }, NOW);
  for (const line of head(raw!).split('\r\n')) assert.ok(line.length <= 998, `header line of ${line.length} octets`);
});
