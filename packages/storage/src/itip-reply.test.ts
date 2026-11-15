/**
 * iTIP REQUEST → REPLY helpers (pure).
 * Run: node --import tsx --test src/itip-reply.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
(globalThis as Record<string, unknown>)['__prisma'] = { $on: () => undefined };

const {
  attendeesWithResponse, buildITipReplyIcs, buildITipReplyMime, calendarObjectForInvitee, findITipRequest, findOwnAttendee,
} = await import('./itip-reply.js');
const { extractCalendarParts, parseITipReply } = await import('./itip-inbound.js');

const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'METHOD:REQUEST',
  'BEGIN:VTIMEZONE', 'TZID:Europe/Berlin', 'END:VTIMEZONE',
  'BEGIN:VEVENT', 'UID:u-1@ext.test', 'SEQUENCE:4', 'DTSTART;TZID=Europe/Berlin:20261120T100000',
  'DTEND;TZID=Europe/Berlin:20261120T110000', 'SUMMARY:Planning \\, Q1',
  'ORGANIZER;CN=Olga:mailto:olga@ext.test',
  'ATTENDEE;CN=Me;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:Me@Example.com',
  'ATTENDEE;PARTSTAT=ACCEPTED:mailto:other@ext.test',
  'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', 'END:VALARM',
  'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n');
const RAW = `From: olga@ext.test\r\nContent-Type: text/calendar; method=REQUEST\r\n\r\n${ICS}`;

test('findITipRequest: METHOD:REQUEST only', () => {
  const req = findITipRequest(RAW)!;
  assert.equal(req.event.uid, 'u-1@ext.test');
  assert.equal(req.event.summary, 'Planning , Q1');
  assert.equal(req.event.start.toISOString(), '2026-11-20T09:00:00.000Z');
  assert.equal(findITipRequest(RAW.replace('METHOD:REQUEST', 'METHOD:CANCEL')), null);
  assert.equal(findITipRequest('From: a\r\n\r\nhello'), null);
});

test('own attendee lookup and PARTSTAT replacement', () => {
  const req = findITipRequest(RAW)!;
  assert.equal(findOwnAttendee(req.event, ['me@example.com']), 'me@example.com');
  assert.equal(findOwnAttendee(req.event, ['x@example.com']), null);
  const list = attendeesWithResponse(req.event, 'me@example.com', 'TENTATIVE');
  assert.deepEqual(list.map((a) => [a.email.toLowerCase(), a.partstat]), [['me@example.com', 'TENTATIVE'], ['other@ext.test', 'ACCEPTED']]);
  assert.equal(attendeesWithResponse(req.event, 'new@example.com', 'ACCEPTED').length, 3);
});

test('stored object: no METHOD, own PARTSTAT, timezone + alarm preserved', () => {
  const obj = calendarObjectForInvitee(findITipRequest(RAW)!, 'me@example.com', 'ACCEPTED').replace(/\r\n /g, '');
  assert.ok(!/^METHOD:/m.test(obj));
  assert.match(obj, /^ATTENDEE[^\r\n]*PARTSTAT=ACCEPTED[^\r\n]*:mailto:Me@Example.com$/m);
  assert.match(obj, /^DTSTART;TZID=Europe\/Berlin:20261120T100000$/m);
  assert.match(obj, /BEGIN:VALARM/);
});

test('REPLY ICS is accepted by the inbound REPLY parser (round trip)', () => {
  const ics = buildITipReplyIcs(findITipRequest(RAW)!, { email: 'me@example.com', cn: 'Me' }, 'DECLINED', new Date('2026-11-15T00:00:00Z'));
  assert.match(ics, /^METHOD:REPLY$/m);
  assert.match(ics, /^ORGANIZER:mailto:olga@ext.test$/m);
  const parsed = parseITipReply(ics);
  assert.deepEqual(parsed, { uid: 'u-1@ext.test', sequence: 4, attendeeEmail: 'me@example.com', partstat: 'DECLINED' });
});

test('REPLY MIME: headers, inline text/calendar method=REPLY and .ics attachment', () => {
  const ics = buildITipReplyIcs(findITipRequest(RAW)!, { email: 'me@example.com' }, 'ACCEPTED');
  const raw = buildITipReplyMime({ ics, from: { email: 'me@example.com', name: 'Mé' }, to: 'olga@ext.test', summary: 'Planning, Q1', partstat: 'ACCEPTED', seed: 'abc', now: new Date('2026-11-15T10:00:00Z') }).toString('utf8');
  assert.match(raw, /^From: =\?UTF-8\?B\?[^?]+\?= <me@example.com>$/m);
  assert.match(raw, /^To: olga@ext.test$/m);
  assert.match(raw, /^Subject: Accepted: Planning, Q1$/m);
  assert.match(raw, /^Message-ID: <abc@example.com>$/m);
  assert.match(raw, /^Content-Type: text\/calendar; charset=UTF-8; method=REPLY$/m);
  assert.match(raw, /filename="invite.ics"/);
  const parts = extractCalendarParts(raw);
  assert.equal(parts.length, 2);
  assert.equal(parseITipReply(parts[0]!)?.partstat, 'ACCEPTED');
  // header injection via the summary is neutralised
  const evil = buildITipReplyMime({ ics, from: { email: 'me@example.com' }, to: 'olga@ext.test', summary: 'x\r\nBcc: victim@x', partstat: 'ACCEPTED' }).toString('utf8');
  assert.ok(!/^Bcc:/m.test(evil));
});
