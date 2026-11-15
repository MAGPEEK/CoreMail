/**
 * MeetingResponse: accept/tentative/decline of an iMIP REQUEST in the Inbox —
 * calendar event created/updated/removed with the own PARTSTAT, iTIP REPLY
 * queued to the organizer, request mail moved to Deleted Items.
 * Run: node --import tsx --test src/commands/meeting-response.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDb, clientWbxml, wbxmlTags, type WNode } from '../test-support/fake-db.js';

const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Ext//EN', 'METHOD:REQUEST',
  'BEGIN:VEVENT', 'UID:evt-123@ext.test', 'SEQUENCE:2', 'DTSTAMP:20261110T090000Z',
  'DTSTART:20261120T100000Z', 'DTEND:20261120T110000Z', 'SUMMARY:Project kickoff', 'LOCATION:Room 1',
  'RRULE:FREQ=WEEKLY;COUNT=3',
  'ORGANIZER;CN=Olga:mailto:olga@ext.test',
  'ATTENDEE;CN=Alice;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:info@example.com',
  'ATTENDEE;CN=Carl;PARTSTAT=ACCEPTED:mailto:carl@ext.test',
  'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n');
const RAW = Buffer.from([
  'From: Olga <olga@ext.test>', 'To: info@example.com', 'Subject: Invitation: Project kickoff',
  'MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="b1"', '',
  '--b1', 'Content-Type: text/plain', '', 'You are invited', '--b1',
  'Content-Type: text/calendar; method=REQUEST; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
  Buffer.from(ICS).toString('base64'), '--b1--', '',
].join('\r\n'));

const base = () => ({
  user: [{ id: 'u1', email: 'alice@example.com', displayName: 'Alice A', domainId: 'd1' }],
  emailAlias: [{ id: 'a1', address: 'info@example.com', targetUserId: 'u1', active: true }],
  mailbox: [{ id: 'mb1', userId: 'u1', uidNext: 50, highestModSeq: 100n }, { id: 'mb2', userId: 'u2', uidNext: 1, highestModSeq: 1n }],
  folder: [
    { id: 'inbox', mailboxId: 'mb1', name: 'INBOX' },
    { id: 'trash', mailboxId: 'mb1', name: 'Trash' },
    { id: 'bob-inbox', mailboxId: 'mb2', name: 'INBOX' },
  ],
  message: [
    { id: 'req1', folderId: 'inbox', uid: 7, modSeq: 90n, deletedAt: null, storagePath: 'raw/x' },
    { id: 'bobreq', folderId: 'bob-inbox', uid: 1, modSeq: 1n, deletedAt: null, storagePath: 'raw/y' },
  ],
  calendar: [
    { id: 'cal-other', userId: 'u1', isDefault: false, sortOrder: 1, createdAt: new Date(1) },
    { id: 'cal-default', userId: 'u1', isDefault: true, sortOrder: 0, createdAt: new Date(2) },
  ],
  calendarEvent: [] as Array<Record<string, unknown>>,
});

const db = installFakeDb(base());
const reset = () => { const fresh = base() as Record<string, Array<Record<string, unknown>>>; for (const k of Object.keys(fresh)) db.tables[k] = fresh[k]!; db.calls.length = 0; };

const { handleMeetingResponse } = await import('./meeting-response.js');
const { decodeWbxml } = await import('../wbxml.js');
type E = import('../wbxml.js').WbxmlElement;

const queued: Array<{ from: string; to: string[]; rawMessage: string }> = [];
const deps = {
  loadRaw: async () => RAW,
  enqueue: async (job: { from: string; to: string[]; rawMessage: string }) => { queued.push(job); return 'job'; },
};
const MR = (t: number, k?: WNode[] | string): WNode => [8, t, k];
const request = (response: string, requestId = 'req1', collectionId = 'inbox'): WNode =>
  MR(0x07, [MR(0x09, [MR(0x0c, response), MR(0x06, collectionId), MR(0x08, requestId)])]);
const kid = (e: E | undefined, name: string): E | undefined => e?.children?.find((c): c is E => typeof c !== 'string' && c.name === name);
async function run(req: WNode) {
  const buf = await handleMeetingResponse(decodeWbxml(clientWbxml(req)), 'u1', deps);
  assert.ok(wbxmlTags(buf).every(([p]) => p === 8), JSON.stringify(wbxmlTags(buf)));
  return kid(decodeWbxml(buf), 'Result')!;
}
const replyIcs = (job: { rawMessage: string }) => {
  const raw = Buffer.from(job.rawMessage, 'base64').toString('utf8');
  const part = raw.split('Content-Type: text/calendar; charset=UTF-8; method=REPLY')[1]!.split('--alt-')[0]!;
  return { raw, ics: Buffer.from(part.replace(/Content-Transfer-Encoding: base64/, '').replace(/\s+/g, ''), 'base64').toString('utf8') };
};

test('accept: event in the default calendar with own PARTSTAT, REPLY to the organizer, request moved to Trash', async () => {
  reset(); queued.length = 0;
  const result = await run(request('1'));
  assert.equal(kid(result, 'Status')?.text, '1');
  assert.equal(kid(result, 'RequestId')?.text, 'req1');
  const ev = db.tables['calendarEvent']![0]!;
  assert.equal(kid(result, 'CalendarId')?.text, ev['id']);
  assert.equal(ev['calendarId'], 'cal-default');
  assert.equal(ev['uid'], 'evt-123@ext.test');
  assert.equal(ev['summary'], 'Project kickoff');
  assert.equal(ev['location'], 'Room 1');
  assert.equal((ev['dtStart'] as Date).toISOString(), '2026-11-20T10:00:00.000Z');
  assert.equal(ev['rrule'], 'FREQ=WEEKLY;COUNT=3');
  assert.equal(ev['recurring'], true);
  assert.equal(ev['organizer'], 'olga@ext.test');
  assert.equal(ev['sequence'], 2);
  const me = (ev['attendees'] as Array<Record<string, unknown>>).find((a) => a['email'] === 'info@example.com');
  assert.equal(me?.['partstat'], 'ACCEPTED');
  const ical = String(ev['icalData']);
  assert.ok(!/^METHOD:/m.test(ical), 'stored object has no METHOD');
  assert.match(ical.replace(/\r\n /g, ''), /^ATTENDEE[^\r\n]*PARTSTAT=ACCEPTED[^\r\n]*:mailto:info@example.com/m);
  assert.match(ical.replace(/\r\n /g, ''), /^RRULE:FREQ=WEEKLY;COUNT=3/m);

  assert.equal(queued.length, 1);
  const job = queued[0]!;
  assert.equal(job.from, 'info@example.com', 'replies as the invited address (alias)');
  assert.deepEqual(job.to, ['olga@ext.test']);
  const { raw, ics } = replyIcs(job);
  assert.match(raw, /^Subject: Accepted: Project kickoff$/m);
  assert.match(raw, /^To: olga@ext.test$/m);
  assert.match(ics, /^METHOD:REPLY$/m);
  assert.match(ics, /^UID:evt-123@ext.test$/m);
  assert.match(ics, /^SEQUENCE:2$/m);
  const attendees = ics.replace(/\r\n /g, '').match(/^ATTENDEE.*$/gm) ?? [];
  assert.equal(attendees.length, 1, 'REPLY carries exactly one ATTENDEE');
  assert.match(attendees[0]!, /PARTSTAT=ACCEPTED/);
  assert.match(attendees[0]!, /mailto:info@example.com/);

  const req = db.tables['message']!.find((m) => m['id'] === 'req1')!;
  assert.equal(req['folderId'], 'trash');
  assert.equal(req['uid'], 50, 'moved via the message store (new UID)');
});

test('internal invitation: the organizer on this server already holds the UID → the invitee still gets its own copy', async () => {
  // e2e regression: CalendarEvent.uid was unique server-wide, so accepting an
  // invitation from a colleague failed with P2002 (Status 4). The schema key is
  // read from schema.prisma, the fake table is then checked against it.
  const { readFileSync } = await import('node:fs');
  const schema = readFileSync(new URL('../../../storage/prisma/schema.prisma', import.meta.url), 'utf8');
  const model = schema.slice(schema.indexOf('model CalendarEvent {'), schema.indexOf('}', schema.indexOf('model CalendarEvent {')));
  const globalUid = /^\s*uid\s+String\s+@unique/m.test(model);
  assert.ok(!globalUid && /@@unique\(\[calendarId, uid\]\)/.test(model), 'UID unique per calendar (RFC 4791 §5.3.2.1)');

  reset(); queued.length = 0;
  db.tables['calendar']!.push({ id: 'cal-organizer', userId: 'u2', isDefault: true, sortOrder: 0, createdAt: new Date(0) });
  db.tables['calendarEvent']!.push({ id: 'ev-org', calendarId: 'cal-organizer', uid: 'evt-123@ext.test', sequence: 2, summary: 'Project kickoff' });
  const result = await run(request('1'));
  assert.equal(kid(result, 'Status')?.text, '1');
  const mine = db.tables['calendarEvent']!.find((e) => e['calendarId'] === 'cal-default');
  assert.ok(mine, 'invitee copy created in the own default calendar');
  assert.equal(kid(result, 'CalendarId')?.text, mine!['id']);
  const org = db.tables['calendarEvent']!.find((e) => e['id'] === 'ev-org')!;
  assert.equal(org['summary'], 'Project kickoff', "the organizer's event is untouched");
  const keys = db.tables['calendarEvent']!.map((e) => `${String(e['calendarId'])}|${String(e['uid']).toLowerCase()}`);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate (calendarId, uid)');
});

test('tentative on an existing event updates it; decline removes it and still replies', async () => {
  reset(); queued.length = 0;
  db.tables['calendarEvent']!.push({ id: 'ev1', calendarId: 'cal-other', uid: 'EVT-123@ext.test', sequence: 1, summary: 'old' });
  const t = await run(request('2'));
  assert.equal(kid(t, 'CalendarId')?.text, 'ev1');
  const ev = db.tables['calendarEvent']![0]!;
  assert.equal(ev['calendarId'], 'cal-other', 'stays in its calendar');
  assert.equal(ev['summary'], 'Project kickoff');
  assert.equal(ev['status'], 'TENTATIVE');
  assert.match(replyIcs(queued[0]!).ics, /PARTSTAT=TENTATIVE/);

  // request is back in the inbox for the decline
  Object.assign(db.tables['message']!.find((m) => m['id'] === 'req1')!, { folderId: 'inbox' });
  const d = await run(request('3'));
  assert.equal(kid(d, 'Status')?.text, '1');
  assert.equal(kid(d, 'CalendarId'), undefined);
  assert.equal(db.tables['calendarEvent']!.length, 0);
  assert.equal(queued.length, 2);
  assert.match(replyIcs(queued[1]!).raw, /^Subject: Declined: Project kickoff$/m);
  assert.match(replyIcs(queued[1]!).ics, /PARTSTAT=DECLINED/);
});

test('request in a foreign mailbox, unknown id or bad UserResponse → Status 2, nothing changes', async () => {
  reset(); queued.length = 0;
  for (const req of [request('1', 'bobreq', 'bob-inbox'), request('1', 'bobreq', 'inbox'), request('1', 'nope'), request('9')]) {
    const r = await run(req);
    assert.equal(kid(r, 'Status')?.text, '2');
  }
  assert.equal(queued.length, 0);
  assert.equal(db.tables['calendarEvent']!.length, 0);
  assert.equal(db.tables['message']!.find((m) => m['id'] === 'bobreq')!['folderId'], 'bob-inbox');
});

test('a mail without a REQUEST → Status 2', async () => {
  reset(); queued.length = 0;
  const plain = Buffer.from('From: a@b\r\nSubject: hi\r\n\r\nno calendar\r\n');
  const buf = await handleMeetingResponse(decodeWbxml(clientWbxml(request('1'))), 'u1', { ...deps, loadRaw: async () => plain });
  assert.equal(kid(kid(decodeWbxml(buf), 'Result'), 'Status')?.text, '2');
  assert.equal(queued.length, 0);
});
