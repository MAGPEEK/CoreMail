/**
 * v8.1 review — local delivery paths:
 *  - booking updates/cancels match the iCal ORGANIZER / header From (not the
 *    SRS/VERP envelope) and need an aligned-authenticated domain or the
 *    authenticated local sender
 *  - room invitations from local senders (submission, worker) are processed
 *    inside storeInboundMessage; unknown recipients produce an NDR
 *  - our own Authentication-Results are stripped on every local path
 *  - the X-Filter-Context recipient list is capped
 * Run: node --import tsx --test src/handlers/local-delivery.test.ts  (in packages/smtp-server)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';
delete process.env['SMTP_HOSTNAME'];
delete process.env['MAIL_HOSTNAME'];

interface Booking { id: string; calendarId: string; uid: string; organizer: string; status: string }
const bookings: Booking[] = [];
const none = async () => null;
const resourceLocks: string[] = [];
// the resource settings of the BCP (9.5: the mail path applies the same rules as the event form)
const POLICY = {
  email: 'room@corp.test', active: true, autoAccept: true, requireApproval: false, autoDeclineConflict: false,
  allowRecurring: true, maxDurationMinutes: null, bookingWindowDays: 3650,
};
(globalThis as unknown as { __prisma: unknown }).__prisma = {
  $on: () => undefined,
  $transaction: async (fn: (tx: unknown) => unknown) => fn((globalThis as unknown as { __prisma: unknown }).__prisma),
  resourceCalendar: {
    update: async ({ where }: { where: { id: string } }) => { resourceLocks.push(where.id); return { id: where.id }; },
  },
  serverSettings: { findUnique: async () => ({ publicHostname: 'MX.corp.test' }) },
  user: { findFirst: none, findMany: async () => [] },
  sharedMailbox: { findFirst: none },
  systemLog: { create: async () => ({}) },
  resourceMailbox: {
    findFirst: async ({ where }: { where: { email: string } }) => (where.email === 'room@corp.test'
      ? { id: 'r1', ...POLICY, calendar: { id: 'cal1' } }
      : null),
  },
  resourceBooking: {
    findUnique: async ({ where }: { where: { calendarId_uid: { calendarId: string; uid: string } } }) =>
      bookings.find((b) => b.calendarId === where.calendarId_uid.calendarId && b.uid === where.calendarId_uid.uid) ?? null,
    // 9.5: the shared conflict check reads the resource's bookings
    findMany: async ({ where }: { where: { calendarId: string } }) => bookings.filter((b) => b.calendarId === where.calendarId),
    create: async ({ data }: { data: Omit<Booking, 'id'> }) => { const b = { id: `b${bookings.length + 1}`, ...data }; bookings.push(b); return b; },
    update: async ({ where, data }: { where: { id: string }; data: Partial<Booking> }) => { const b = bookings.find((x) => x.id === where.id)!; Object.assign(b, data); return b; },
    delete: async ({ where }: { where: { id: string } }) => { const i = bookings.findIndex((x) => x.id === where.id); return bookings.splice(i, 1)[0]; },
  },
};

const { processResourceMailboxes, organizerIdentity, icalOrganizer, headerFromAddress } = await import('./resource-booking.js');
const { storeInboundMessage } = await import('./message.js');
const {
  stripForLocalDelivery, stripOwnAuthResultsAll, authservIdsFrom, bounceUnknownLocal, unknownRecipientDsn,
} = await import('./local-delivery.js');
const { localDeliveryBuffer, deliverOutboundJob } = await import('../outbound/queue.js');
const { filterContext, FILTER_CONTEXT_MAX_RCPTS } = await import('../inbound/handler.js');

const invite = (method: string, uid: string, opts: { organizer?: string; from?: string; start?: string } = {}) => Buffer.from([
  ...(opts.from ? [`From: ${opts.from}`] : []), 'Subject: Room', '', 'BEGIN:VCALENDAR', `METHOD:${method}`, 'BEGIN:VEVENT', `UID:${uid}`,
  ...(opts.organizer ? [`ORGANIZER;CN=Org:mailto:${opts.organizer}`] : []),
  `DTSTART:${opts.start ?? '20261201T090000Z'}`, 'DTEND:20261201T100000Z', 'SUMMARY:Sync', 'END:VEVENT', 'END:VCALENDAR', '',
].join('\r\n'));

// ── Finding 6: organizer identity ────────────────────────────────────────────

test('organizer identity: iCal ORGANIZER, else header From; folded lines and quoted params', () => {
  assert.equal(icalOrganizer('BEGIN:VEVENT\r\nORGANIZER;CN="Doe: J";SENT-BY="mailto:x@y.test":\r\n mailto:Org@Ext.Test\r\nEND:VEVENT'), 'org@ext.test');
  assert.equal(icalOrganizer('BEGIN:VEVENT\r\nEND:VEVENT'), '');
  assert.equal(headerFromAddress(Buffer.from('From: "Org, Team" <org@ext.test>\r\n\r\nx')), 'org@ext.test');
  assert.equal(headerFromAddress(Buffer.from('From: org@ext.test\r\n\r\nx')), 'org@ext.test');
  const raw = Buffer.from('From: alice@corp.test\r\n\r\nx');
  assert.deepEqual(organizerIdentity('', raw, { authenticatedSender: 'alice@corp.test' }), { organizer: 'alice@corp.test', authenticated: true });
  assert.deepEqual(organizerIdentity('', raw, null), { organizer: 'alice@corp.test', authenticated: false });
  assert.deepEqual(organizerIdentity('ORGANIZER:mailto:org@ext.test', raw, { verifiedDomains: ['mail.ext.test'] }), { organizer: 'org@ext.test', authenticated: true });
  assert.deepEqual(organizerIdentity('ORGANIZER:mailto:org@ext.test', raw, { verifiedDomains: ['lists.example'] }), { organizer: 'org@ext.test', authenticated: false });
  // a sibling registrable domain under a public suffix never authenticates the organizer
  assert.deepEqual(organizerIdentity('ORGANIZER:mailto:org@partner.co.uk', raw, { verifiedDomains: ['evil.co.uk'] }), { organizer: 'org@partner.co.uk', authenticated: false });
  assert.deepEqual(organizerIdentity('ORGANIZER:mailto:org@partner.co.uk', raw, { verifiedDomains: ['mail.partner.co.uk'] }), { organizer: 'org@partner.co.uk', authenticated: true });
});

test('an SRS/VERP envelope sender can update/cancel when the authenticated ORGANIZER matches', async () => {
  bookings.length = 0;
  const srs = 'SRS0=HHH=TT=ext.test=org@forwarder.example';
  await processResourceMailboxes(invite('REQUEST', 'm-1', { organizer: 'org@ext.test' }), ['room@corp.test'], srs, { verifiedDomains: ['ext.test'] });
  assert.deepEqual(bookings.map((b) => [b.organizer, b.status]), [['org@ext.test', 'ACCEPTED']]);
  assert.deepEqual(resourceLocks, ['cal1'], '9.4 review: the auto-accept took the resource booking lock');
  // update via a VERP list address (envelope never equals the organizer)
  await processResourceMailboxes(invite('REQUEST', 'm-1', { organizer: 'org@ext.test', start: '20261202T090000Z' }), ['room@corp.test'], 'list-bounces+org=ext.test@lists.example', { verifiedDomains: ['ext.test', 'lists.example'] });
  assert.equal(bookings.length, 1);
  // the forwarder's own domain authenticated, the organizer's not → refused
  await processResourceMailboxes(invite('CANCEL', 'm-1', { organizer: 'org@ext.test' }), ['room@corp.test'], srs, { verifiedDomains: ['forwarder.example'] });
  assert.equal(bookings.length, 1);
  // authenticated organizer cancels through SRS
  await processResourceMailboxes(invite('CANCEL', 'm-1', { organizer: 'org@ext.test' }), ['room@corp.test'], srs, { verifiedDomains: ['ext.test'] });
  assert.equal(bookings.length, 0);
});

test('a local authenticated organizer (no ORGANIZER line) books, updates and cancels via the header From', async () => {
  bookings.length = 0;
  const auth = { authenticatedSender: 'alice@corp.test' };
  await processResourceMailboxes(invite('REQUEST', 'l-1', { from: 'Alice <alice@corp.test>' }), ['room@corp.test'], 'alice@corp.test', auth);
  assert.deepEqual(bookings.map((b) => [b.organizer, b.status]), [['alice@corp.test', 'ACCEPTED']]);
  // another local user cannot cancel alice's booking
  await processResourceMailboxes(invite('CANCEL', 'l-1', { from: 'bob@corp.test' }), ['room@corp.test'], 'bob@corp.test', { authenticatedSender: 'bob@corp.test' });
  assert.equal(bookings.length, 1);
  await processResourceMailboxes(invite('CANCEL', 'l-1', { from: 'alice@corp.test' }), ['room@corp.test'], 'alice@corp.test', auth);
  assert.equal(bookings.length, 0);
});

// ── Finding 7: room invitations on local paths, unknown recipients ───────────

test('storeInboundMessage processes a room invitation from a local sender and reports unknown recipients', async () => {
  bookings.length = 0;
  const r = await storeInboundMessage(invite('REQUEST', 'w-1', { from: 'alice@corp.test' }), {
    fromAddr: 'alice@corp.test', rcptTo: 'Room@corp.test', toJunk: false, senderAuth: { authenticatedSender: 'alice@corp.test' },
  });
  assert.equal(r, 'resource');
  assert.deepEqual(bookings.map((b) => [b.uid, b.status]), [['w-1', 'ACCEPTED']]);
  assert.equal(await storeInboundMessage(Buffer.from('Subject: x\r\n\r\nb'), { fromAddr: 'alice@corp.test', rcptTo: 'typo@corp.test', toJunk: false }), 'unknown');
});

test('the worker bounces an unknown local recipient once (5.1.1) and delivers the rest', async () => {
  const bounces: Array<Record<string, unknown>> = [];
  const stored: string[] = [];
  const deps = {
    isLocalAddress: async (a: string) => a.endsWith('@corp.test'),
    expand: async (a: string[]) => a,
    storeLocal: async (_raw: Buffer, _from: string, rcpt: string) => {
      if (rcpt === 'typo@corp.test') return 'unknown' as const;
      stored.push(rcpt);
      return 'stored' as const;
    },
    resolveDkim: async () => ({}),
    relay: async () => ({ delivered: [], failures: [] }),
    bounce: async (o: Record<string, unknown>) => { bounces.push(o); },
    hostname: async () => 'mail.corp.test',
  };
  const job = {
    id: 'j', attemptsMade: 0, opts: { attempts: 5 },
    data: { messageId: 'm', from: 'alice@corp.test', to: ['bob@corp.test', 'typo@corp.test'], rawMessage: '' } as Record<string, unknown>,
    updateData: async (d: Record<string, unknown>) => { job.data = d; },
  };
  const summary = await deliverOutboundJob(job as never, Buffer.from('Subject: Hi\r\n\r\nb'), deps as never);
  assert.deepEqual(stored, ['bob@corp.test']);
  assert.deepEqual(summary.bounced, ['typo@corp.test']);
  assert.equal(bounces.length, 1);
  assert.deepEqual(bounces[0]!['originalTo'], ['typo@corp.test']);
  assert.equal((bounces[0]!['recipients'] as Array<{ status: string }>)[0]!.status, '5.1.1');
  // a retry of the job does not bounce again
  await deliverOutboundJob(job as never, Buffer.from('Subject: Hi\r\n\r\nb'), deps as never);
  assert.equal(bounces.length, 1);
  assert.deepEqual(stored, ['bob@corp.test']);
});

test('bounceUnknownLocal: NDR to the sender, never for the null sender', async () => {
  const sent: unknown[] = [];
  await bounceUnknownLocal(Buffer.from('Subject: S\r\nMessage-ID: <1@x>\r\n\r\nb'), 'alice@corp.test', ['typo@corp.test'], { hostname: 'mx', bounce: async (o) => { sent.push(o); } });
  await bounceUnknownLocal(Buffer.from('x'), '', ['typo@corp.test'], { hostname: 'mx', bounce: async (o) => { sent.push(o); } });
  assert.equal(sent.length, 1);
  const dsn = unknownRecipientDsn(Buffer.from('Subject: S\r\nMessage-ID: <1@x>\r\n\r\nb'), 'a@b', ['t@c'], 'mx', true);
  assert.equal(dsn.originalSubject, 'S');
  assert.equal(dsn.originalMessageId, '<1@x>');
});

// ── Finding 11: forged Authentication-Results from local users ──────────────

test('local deliveries strip Authentication-Results with any of our authserv-ids', async () => {
  const forged = Buffer.from([
    'Authentication-Results: mx.corp.test; dmarc=pass header.from=ceo.corp.test',
    'Authentication-Results: smtp.env.test; spf=pass',
    'Authentication-Results: other.example; dkim=pass',
    'From: mallory@corp.test', 'Subject: s', '', 'body', '',
  ].join('\r\n'));
  assert.deepEqual(authservIdsFrom('MX.corp.test', { SMTP_HOSTNAME: 'smtp.env.test' }), ['mx.corp.test', 'smtp.env.test']);
  const cleaned = stripOwnAuthResultsAll(forged, ['mx.corp.test', 'smtp.env.test']).toString();
  assert.doesNotMatch(cleaned, /mx\.corp\.test; dmarc=pass/);
  assert.doesNotMatch(cleaned, /smtp\.env\.test/);
  assert.match(cleaned, /other\.example; dkim=pass/);
  // publicHostname from ServerSettings (case-insensitive) + extra ids (submission's session host name)
  const viaDb = (await stripForLocalDelivery(forged, ['smtp.env.test'])).toString();
  assert.doesNotMatch(viaDb, /dmarc=pass/);
  assert.doesNotMatch(viaDb, /smtp\.env\.test/);
  // worker: every producer is stripped, except a BCP quarantine release (our own genuine verdict)
  const stripped = await localDeliveryBuffer(forged, {});
  assert.doesNotMatch(stripped.toString(), /dmarc=pass/);
  assert.equal(await localDeliveryBuffer(forged, { quarantineReleaseId: 'q1' }), forged);
});

test('9.2 review: local deliveries (REST/JMAP/EAS/submission via the queue) strip X-CoreMail-Virus-Scan', async () => {
  const forged = Buffer.from([
    'X-CoreMail-Virus-Scan: suspicious; signature="PUA.Win.Packer.Upx-1"; host=mx.corp.test',
    'From: mallory@corp.test', 'Subject: s', '', 'body', '',
  ].join('\r\n'));
  assert.doesNotMatch((await stripForLocalDelivery(forged)).toString(), /X-CoreMail-Virus-Scan/i);
  assert.doesNotMatch((await localDeliveryBuffer(forged, {})).toString(), /X-CoreMail-Virus-Scan/i);
  // a BCP quarantine release keeps our own genuine verdict
  assert.equal(await localDeliveryBuffer(forged, { quarantineReleaseId: 'q1' }), forged);
});

test('9.4 review: client submissions delivered locally lose every internal header; a rule forward keeps its loop header', async () => {
  const forged = Buffer.from([
    'X-CoreMail-RuleForwarded: someone', 'X-CoreMail-Draft-Pending: e30=',
    'X-CoreMail-Quarantine-Released: q9', 'X-CoreMail-Virus-Scan: unscanned; host=x',
    'From: mallory@corp.test', 'Subject: s', '', 'body', '',
  ].join('\r\n'));
  const user = (await localDeliveryBuffer(forged, {})).toString();
  assert.doesNotMatch(user, /X-CoreMail-/i, 'REST/JMAP/EAS submission: nothing internal reaches the colleague');
  const forward = (await localDeliveryBuffer(forged, { ruleForward: true })).toString();
  assert.match(forward, /^X-CoreMail-RuleForwarded: someone/m, 'genuine loop header of a rule forward stays');
  assert.doesNotMatch(forward, /X-CoreMail-(Draft-Pending|Quarantine-Released|Virus-Scan)/i);
  assert.match((await localDeliveryBuffer(forged, { ruleRedirect: true })).toString(), /^X-CoreMail-RuleForwarded:/m);
});

// ── Finding 10: X-Filter-Context size ───────────────────────────────────────

test('X-Filter-Context lists at most 100 recipients and carries the total count', () => {
  const rcpts = Array.from({ length: 1500 }, (_, i) => `user${i}-with-a-rather-long-local-part@corp.test`);
  const ctx = filterContext({ senderIp: '192.0.2.1', mailFrom: 'a@ext.test', rcpts, hostname: 'mx.corp.test' });
  assert.equal((ctx['rcpts'] as string[]).length, FILTER_CONTEXT_MAX_RCPTS);
  assert.equal(ctx['rcptCount'], 1500);
  assert.equal(ctx['rcptTo'], rcpts[0]);
  assert.ok(JSON.stringify(ctx).length < 8 * 1024, 'well below the 16 KB header limit');
  const small = filterContext({ senderIp: '192.0.2.1', mailFrom: 'a@ext.test', rcpts: ['a@corp.test'], hostname: 'mx' });
  assert.equal(small['rcptCount'], undefined);
});
