/**
 * Mailbox quota levels (v8.1): limits, levels, SMTP replies, cached usage and
 * the 24 h warning throttle — against the in-memory Prisma fake.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';

const { emptyDb, createFake } = await import('./test-support/mailbox-fake.js');
const db = emptyDb();
(globalThis as unknown as { __prisma: unknown }).__prisma = createFake(db);

const q = await import('./mailbox-quota.js');

const MB = 1024 * 1024;

function seed(): void {
  Object.assign(db, emptyDb());
  db.serverSettings.push({ id: 'singleton', quotaWarningPercent: 80, quotaProhibitSendPercent: 90, publicHostname: 'mail.example' });
  db.users.push({ id: 'u1', email: 'bob@example.com', displayName: 'Bob', active: true, quotaBytes: BigInt(100 * MB), usedBytes: 0n, quotaWarningBytes: null, quotaProhibitSendBytes: null, quotaWarnedAt: null });
  db.sharedMailboxes.push({ id: 's1', email: 'team@example.com', displayName: 'Team', active: true, quotaBytes: BigInt(10 * MB), usedBytes: 0n, quotaWarningBytes: null, quotaProhibitSendBytes: null, quotaWarnedAt: null });
  db.mailboxes.push({ id: 'mb1', userId: 'u1', sharedBoxId: null, uidNext: 1, highestModSeq: 0n });
  db.mailboxes.push({ id: 'mb2', userId: null, sharedBoxId: 's1', uidNext: 1, highestModSeq: 0n });
  db.folders.push({ id: 'in1', mailboxId: 'mb1', name: 'INBOX', displayName: 'Inbox', totalCount: 0, unreadCount: 0 });
  db.folders.push({ id: 'ri1', mailboxId: 'mb1', name: 'Recoverable Items/Deletions', displayName: 'Deletions', totalCount: 0, unreadCount: 0 });
  db.folders.push({ id: 'in2', mailboxId: 'mb2', name: 'INBOX', displayName: 'Inbox', totalCount: 0, unreadCount: 0 });
  db.aliases.push({ id: 'a1', address: 'info@example.com', active: true, targetUserId: null, targetSharedId: 's1' });
}

function addMsg(folderId: string, size: number, extra: Record<string, unknown> = {}): void {
  db.messages.push({ id: `m${db.messages.length + 1}`, folderId, uid: db.messages.length + 1, modSeq: 1n, rawSize: size, deletedAt: null, softDeletedAt: null, flags: [], ...extra });
}

const sent: Array<{ email: string; level: string }> = [];
beforeEach(() => {
  seed();
  q.resetQuotaCache();
  sent.length = 0;
  q.setQuotaWarningSender(async (s) => { sent.push({ email: s.email, level: s.level }); });
});

test('effective limits: explicit levels win, otherwise percent of the quota; 0 = unlimited', () => {
  const d = { warningPercent: 83, prohibitSendPercent: 87 };
  assert.deepEqual(q.effectiveQuotaLimits({ quotaBytes: 1000n }, d), { warningBytes: 830, prohibitSendBytes: 870, prohibitSendReceiveBytes: 1000 });
  assert.deepEqual(q.effectiveQuotaLimits({ quotaBytes: 1000n, quotaWarningBytes: 500n, quotaProhibitSendBytes: 600n }, d), { warningBytes: 500, prohibitSendBytes: 600, prohibitSendReceiveBytes: 1000 });
  assert.deepEqual(q.effectiveQuotaLimits({ quotaBytes: 0n }, d), { warningBytes: 0, prohibitSendBytes: 0, prohibitSendReceiveBytes: 0 });
  const l = q.effectiveQuotaLimits({ quotaBytes: 1000n }, d);
  assert.equal(q.quotaLevel(829, l), 'ok');
  assert.equal(q.quotaLevel(830, l), 'warning');
  assert.equal(q.quotaLevel(870, l), 'prohibitSend');
  assert.equal(q.quotaLevel(1000, l), 'prohibitSendReceive');
  assert.equal(q.quotaLevel(10 ** 12, q.effectiveQuotaLimits({ quotaBytes: 0n }, d)), 'ok');
});

test('QUOTA_FULL_PERMANENT: permanent by default, transient when off, threshold in percent', () => {
  assert.match(q.receiveQuotaReply(100, 100, {}), /^552 5\.2\.2 /);
  assert.match(q.receiveQuotaReply(100, 100, { QUOTA_FULL_PERMANENT: 'true' }), /^552 5\.2\.2 /);
  assert.match(q.receiveQuotaReply(100, 100, { QUOTA_FULL_PERMANENT: 'false' }), /^452 4\.2\.2 /);
  assert.match(q.receiveQuotaReply(105, 100, { QUOTA_FULL_PERMANENT: '110' }), /^452 4\.2\.2 /);
  assert.match(q.receiveQuotaReply(110, 100, { QUOTA_FULL_PERMANENT: '110' }), /^552 5\.2\.2 /);
});

test('usage: live messages only (no tombstones, no Recoverable Items), cached and adjusted by deliveries', async () => {
  addMsg('in1', 10 * MB);
  addMsg('in1', 5 * MB, { deletedAt: new Date() });
  addMsg('ri1', 7 * MB);
  assert.equal(await q.mailboxUsageBytes({ kind: 'user', id: 'u1' }), 10 * MB);
  // written back to the stored counter
  await new Promise((r) => setImmediate(r));
  assert.equal(db.users[0]!['usedBytes'], BigInt(10 * MB));
  // cached: a new row is not seen until the delta is noted or the cache expires
  addMsg('in1', 1 * MB);
  assert.equal(await q.mailboxUsageBytes({ kind: 'user', id: 'u1' }), 10 * MB);
  q.noteUsageDelta({ kind: 'user', id: 'u1' }, 1 * MB);
  assert.equal(await q.mailboxUsageBytes({ kind: 'user', id: 'u1' }), 11 * MB);
  assert.equal(await q.mailboxUsageBytes({ kind: 'user', id: 'u1' }, { now: Date.now() + 61_000 }), 11 * MB);
});

test('send quota: allowed below prohibit-send, refused at it with 552 5.2.2', async () => {
  addMsg('in1', 85 * MB);
  const ok = await q.checkSendQuota('u1');
  assert.equal(ok.allowed, true);
  q.resetQuotaCache();
  addMsg('in1', 5 * MB); // 90 MB = prohibit-send (90 %)
  const refused = await q.checkSendQuota('u1');
  assert.equal(refused.allowed, false);
  if (!refused.allowed) {
    assert.match(refused.reply, /^552 5\.2\.2 /);
    assert.equal(refused.status.level, 'prohibitSend');
  }
  // per-mailbox override lifts the level
  q.resetQuotaCache();
  db.users[0]!['quotaProhibitSendBytes'] = BigInt(95 * MB);
  assert.equal((await q.checkSendQuota('u1')).allowed, true);
});

test('receive quota: by address (user, shared, alias target), only at prohibit-send-receive', async () => {
  addMsg('in1', 95 * MB);
  assert.equal(await q.checkReceiveQuotaForAddress('bob@example.com', { env: {} }), null);
  addMsg('in2', 10 * MB);
  assert.match((await q.checkReceiveQuotaForAddress('team@example.com', { env: {} }))!, /^552 5\.2\.2 /);
  assert.match((await q.checkReceiveQuotaForAddress('INFO@example.com', { env: { QUOTA_FULL_PERMANENT: 'false' } }))!, /^452 4\.2\.2 /);
  assert.equal(await q.checkReceiveQuotaForAddress('nobody@example.com'), null);
  q.resetQuotaCache();
  addMsg('in1', 5 * MB); // 100 MB
  assert.match((await q.checkReceiveQuotaForAddress('bob@example.com', { env: {} }))!, /^552 5\.2\.2 /);
});

test('warning mail: once per 24 h, again after the interval; not below the warning level', async () => {
  const t0 = new Date('2026-11-01T10:00:00Z');
  addMsg('in1', 50 * MB);
  await q.recordDelivery({ kind: 'user', id: 'u1' }, 0, t0);
  assert.equal(sent.length, 0, 'below warning level');
  addMsg('in1', 31 * MB); // 81 MB ≥ 80 %
  q.resetQuotaCache();
  await q.recordDelivery({ kind: 'user', id: 'u1' }, 0, t0);
  await q.recordDelivery({ kind: 'user', id: 'u1' }, 0, new Date(t0.getTime() + 3600_000));
  await q.recordDelivery({ kind: 'user', id: 'u1' }, 0, new Date(t0.getTime() + 23 * 3600_000));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { email: 'bob@example.com', level: 'warning' });
  await q.recordDelivery({ kind: 'user', id: 'u1' }, 0, new Date(t0.getTime() + 24 * 3600_000 + 1));
  assert.equal(sent.length, 2);
});

test('warning mail: concurrent claims send exactly one', async () => {
  addMsg('in1', 85 * MB);
  const status = (await q.getQuotaStatus({ kind: 'user', id: 'u1' }))!;
  const now = new Date();
  const results = await Promise.all([1, 2, 3, 4].map(() => q.maybeSendQuotaWarning(status, now)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(sent.length, 1);
});

test('warning text names the limits', () => {
  const t = q.quotaWarningText({
    owner: { kind: 'user', id: 'u1' }, email: 'bob@example.com', mailboxId: 'mb1', usedBytes: 90 * MB,
    limits: { warningBytes: 80 * MB, prohibitSendBytes: 90 * MB, prohibitSendReceiveBytes: 100 * MB }, level: 'prohibitSend',
  });
  assert.match(t.bodyText, /90\.0 MB/);
  assert.match(t.bodyText, /no longer send/);
});
