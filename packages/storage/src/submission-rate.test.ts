/**
 * Per-user outgoing message rate (10.5): sliding window, recipient counting,
 * per-mailbox override, Redis path + in-process fallback, block on exceed,
 * notice throttling and the report (audit, attack event, admin notice).
 * Run: node --import tsx --import ./src/test-support/realtime-off.ts --test src/submission-rate.test.ts  (in packages/storage)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';

let settings: Record<string, unknown> = {};
let policy: Record<string, unknown> | null = null;
const audits: Array<Record<string, unknown>> = [];
const attacks: Array<Record<string, unknown>> = [];
const inboxLookups: string[] = [];
let adminEmail = '';

(globalThis as unknown as { __prisma: unknown }).__prisma = {
  $on: () => undefined,
  serverSettings: {
    findUnique: async ({ select }: { select: Record<string, boolean> }) => (select['adminEmail']
      ? { adminEmail, publicHostname: 'mail.corp.test', auditLogEnabled: true }
      : settings),
  },
  mailFlowPolicy: { findUnique: async () => policy },
  user: {
    findUnique: async () => ({ email: 'bob@corp.test' }),
    findFirst: async ({ where }: { where: { email: { in: string[] } } }) => (where.email.in.includes('admin@corp.test') ? { id: 'admin1' } : null),
    findMany: async () => [{ mailbox: { id: 'mb-org1' } }, { mailbox: null }],
  },
  sharedMailbox: { findFirst: async ({ where }: { where: { email: { in: string[] } } }) => (where.email.in.includes('it@corp.test') ? { id: 'sm1' } : null) },
  emailAlias: { findFirst: async () => null },
  mailbox: {
    findFirst: async ({ where }: { where: { userId?: string; sharedBoxId?: string } }) =>
      (where.userId === 'admin1' ? { id: 'mb-admin' } : where.sharedBoxId === 'sm1' ? { id: 'mb-it' } : null),
  },
  auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push(data); return data; } },
  attackEvent: { create: async ({ data }: { data: Record<string, unknown> }) => { attacks.push(data); return data; } },
  // notifyMailboxInbox looks up the INBOX first — recorded, then "no INBOX" (no message write in this test)
  folder: { findFirst: async ({ where }: { where: { mailboxId: string } }) => { inboxLookups.push(where.mailboxId); return null; } },
};

const g = globalThis as { __sendRateRedis?: unknown };
g.__sendRateRedis = null; // in-process counter unless a test installs a fake Redis

const rate = await import('./submission-rate.js');
const {
  consumeSendRate, peekSendRate, slidingVerdict, sendRateSettingsFrom, effectiveSendRate, sendRateNotice,
  resetSendRateState, clearSendRateSettingsCache, setSendRateHooks, reportSendRateHit, SEND_RATE_DEFAULTS,
} = rate;

const HOUR = 3600_000;
const T0 = 1000 * HOUR; // start of a window
const hits: unknown[] = [];

beforeEach(() => {
  settings = { sendRateLimitEnabled: true, sendRateMessagesPerHour: 3, sendRateRecipientsPerHour: 10, sendRateBlockOnExceed: false };
  policy = null;
  g.__sendRateRedis = null;
  resetSendRateState();
  clearSendRateSettingsCache();
  hits.length = 0;
  setSendRateHooks({ onLimitHit: async (h) => { hits.push(h); } });
});

const send = (recipients: number, now: number, userId = 'u1') => consumeSendRate({ userId, recipients, protocol: 'smtp' }, now);

test('defaults: 200 messages / 1000 recipients per hour, on, no block', () => {
  assert.deepEqual(sendRateSettingsFrom(null), { enabled: true, messagesPerHour: 200, recipientsPerHour: 1000, blockOnExceed: false });
  assert.deepEqual(SEND_RATE_DEFAULTS, sendRateSettingsFrom({}));
  assert.equal(sendRateSettingsFrom({ sendRateMessagesPerHour: 0 }).messagesPerHour, 200, 'invalid → default');
  assert.deepEqual(effectiveSendRate(sendRateSettingsFrom(null), { maxMessagesPerHour: 5, maxRecipientsPerHour: null }), { messagesPerHour: 5, recipientsPerHour: 1000 });
});

test('messages: the limit+1st message within the hour is refused and not counted', async () => {
  for (let i = 0; i < 3; i++) assert.deepEqual(await send(1, T0 + i * 1000), { allowed: true });
  const d = await send(1, T0 + 5000);
  assert.equal(d.allowed, false);
  assert.equal(!d.allowed && d.reason, 'messages');
  assert.equal(!d.allowed && d.limit, 3);
  assert.ok(!d.allowed && d.retryAfterSec > 3000 && d.retryAfterSec <= 2 * 3600, 'retry after the current window plus decay');
  // another user is not affected
  assert.deepEqual(await send(1, T0 + 5000, 'u2'), { allowed: true });
});

test('sliding window: the previous hour decays instead of resetting at the window edge', async () => {
  for (let i = 0; i < 3; i++) await send(1, T0 + HOUR - 1000 + i); // 3 messages at the very end of the window
  const early = await send(1, T0 + HOUR + 60_000); // 1 min later: still ~3 in the last hour
  assert.equal(early.allowed, false, 'no burst at the window boundary');
  // At 40 min into the next window the previous one weighs 1/3 → 1 + 1 ≤ 3
  assert.deepEqual(await send(1, T0 + HOUR + 40 * 60_000), { allowed: true });
});

test('recipients are counted per message (and checked before counting)', async () => {
  assert.deepEqual(await send(6, T0), { allowed: true });
  const d = await send(5, T0 + 1);
  assert.equal(!d.allowed && d.reason, 'recipients');
  assert.equal(!d.allowed && d.limit, 10);
  assert.deepEqual(await send(4, T0 + 2), { allowed: true }, 'the refused 5 were not counted: 6 + 4 = 10');
  assert.equal((await send(1, T0 + 3)).allowed, false);
});

test('peek does not count; recipients 0 checks the message count only', async () => {
  for (let i = 0; i < 5; i++) assert.deepEqual(await peekSendRate({ userId: 'u1', recipients: 0, protocol: 'smtp' }, T0 + i), { allowed: true });
  for (let i = 0; i < 3; i++) await send(1, T0 + 10 + i);
  assert.equal((await peekSendRate({ userId: 'u1', recipients: 0, protocol: 'smtp' }, T0 + 20)).allowed, false);
});

test('per-mailbox override (MailFlowPolicy) replaces the global numbers; switch off = unlimited', async () => {
  policy = { maxMessagesPerHour: 1, maxRecipientsPerHour: null };
  assert.equal((await send(1, T0)).allowed, true);
  assert.equal((await send(1, T0 + 1)).allowed, false);
  policy = null;
  settings = { ...settings, sendRateLimitEnabled: false };
  clearSendRateSettingsCache();
  for (let i = 0; i < 10; i++) assert.equal((await send(100, T0 + 10 + i)).allowed, true);
});

test('block on exceed: after the first refusal nothing is accepted for an hour', async () => {
  settings = { ...settings, sendRateBlockOnExceed: true };
  assert.equal((await send(8, T0)).allowed, true);
  const first = await send(5, T0 + 10);
  assert.equal(!first.allowed && first.reason, 'recipients');
  assert.equal(!first.allowed && first.retryAfterSec, 3600);
  const later = await send(1, T0 + 20); // 8 + 1 ≤ 10 would pass without the block
  assert.equal(!later.allowed && later.reason, 'blocked');
  assert.ok(!later.allowed && later.retryAfterSec > 3500);
  assert.equal(hits.length, 1, 'refusals while blocked are not reported again');
  assert.equal((await send(1, T0 + 10 + HOUR + 1)).allowed, true, 'block ends after an hour');
});

test('notice throttling: one hit report per user and hour, however often the limit is hit', async () => {
  for (let i = 0; i < 3; i++) await send(1, T0 + i);
  for (let i = 0; i < 5; i++) assert.equal((await send(1, T0 + 100 + i)).allowed, false);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0], { userId: 'u1', protocol: 'smtp', reason: 'messages', limit: 3, messagesPerHour: 3, recipientsPerHour: 10, blocked: false });
  // a second user gets its own report
  for (let i = 0; i < 4; i++) await send(1, T0 + 200 + i, 'u2');
  assert.equal(hits.length, 2);
});

test('Redis path: one Lua call per check, counts shared across "processes"', async () => {
  const hashes = new Map<string, { m: number; r: number }>();
  const strings = new Map<string, number>();
  let evals = 0;
  // Emulates the script on its arguments (KEYS cur, prev, block; ARGV weight … blockTtl)
  g.__sendRateRedis = {
    status: 'ready',
    async eval(_s: string, _n: number, cur: string, prev: string, block: string, w: string, mL: number, rL: number, n: number, _ttl: number, commit: string, blk: string, bttl: number) {
      evals++;
      if ((strings.get(block) ?? 0) > 0) return [2, 0, 0, 0, 0, strings.get(block)];
      const c = hashes.get(cur) ?? { m: 0, r: 0 };
      const p = hashes.get(prev) ?? { m: 0, r: 0 };
      if (p.m * Number(w) + c.m + 1 > mL || (n > 0 && p.r * Number(w) + c.r + n > rL)) {
        if (blk === '1') strings.set(block, bttl);
        return [0, c.m, c.r, p.m, p.r, 0];
      }
      if (commit === '1') hashes.set(cur, { m: c.m + 1, r: c.r + n });
      return [1, c.m, c.r, p.m, p.r, 0];
    },
    async set() { return 'OK'; },
  };
  for (let i = 0; i < 3; i++) assert.equal((await send(2, T0 + i)).allowed, true);
  resetSendRateState(); // another process: no local state, same Redis
  const d = await send(1, T0 + 10);
  assert.equal(!d.allowed && d.reason, 'messages');
  assert.equal(evals, 4);
  assert.deepEqual(hashes.get(`sendrate:u1:${T0 / HOUR}`), { m: 3, r: 6 });
});

test('fallback: Redis failing or not ready → the in-process counter still limits (fail-open across processes)', async () => {
  g.__sendRateRedis = { status: 'ready', eval: async () => { throw new Error('ECONNREFUSED'); }, set: async () => { throw new Error('ECONNREFUSED'); } };
  for (let i = 0; i < 3; i++) assert.equal((await send(1, T0 + i)).allowed, true);
  assert.equal((await send(1, T0 + 10)).allowed, false);
  assert.equal(hits.length, 1, 'the notice claim falls back to the process as well');
  resetSendRateState();
  g.__sendRateRedis = { status: 'reconnecting', eval: async () => { throw new Error('must not be called'); }, set: async () => 'OK' };
  for (let i = 0; i < 3; i++) assert.equal((await send(1, T0 + i)).allowed, true);
  assert.equal((await send(1, T0 + 10)).allowed, false);
});

test('a malformed Redis reply falls back to the process; an unexpected failure lets the submission through', async () => {
  g.__sendRateRedis = { status: 'ready', eval: async () => [7], set: async () => 'OK' };
  for (let i = 0; i < 3; i++) assert.equal((await send(1, T0 + i)).allowed, true);
  assert.equal((await send(1, T0 + 10)).allowed, false, 'counted in process');

  Object.defineProperty(globalThis, '__sendRateRedis', { configurable: true, get() { throw new Error('boom'); } });
  try {
    assert.deepEqual(await send(1, T0 + 20), { allowed: true });
  } finally {
    Object.defineProperty(globalThis, '__sendRateRedis', { configurable: true, writable: true, value: null });
  }
});

test('slidingVerdict: retry-after shrinks as the previous window decays', () => {
  const limits = { messagesPerHour: 10, recipientsPerHour: 100 };
  const a = slidingVerdict({ curM: 0, curR: 0, prevM: 10, prevR: 0 }, limits, 1, 0);
  const b = slidingVerdict({ curM: 0, curR: 0, prevM: 10, prevR: 0 }, limits, 1, 3 * 60_000);
  assert.ok(!a.allowed && !b.allowed);
  assert.ok(!a.allowed && !b.allowed && a.retryAfterSec > b.retryAfterSec);
  assert.equal(!a.allowed && a.retryAfterSec, 360, 'weight must fall to 9/10 → 6 min');
  assert.deepEqual(slidingVerdict({ curM: 0, curR: 0, prevM: 10, prevR: 0 }, limits, 1, 6 * 60_000), { allowed: true });
  const big = slidingVerdict({ curM: 0, curR: 0, prevM: 0, prevR: 0 }, limits, 101, 0);
  assert.equal(!big.allowed && big.reason, 'recipients', 'one message above the hourly recipient limit is never accepted');
});

test('report: audit entry, attack event and a German notice to the admin address (local mailbox)', async () => {
  audits.length = 0; attacks.length = 0; inboxLookups.length = 0;
  const hit = { userId: 'u1', protocol: 'jmap' as const, ipAddress: '198.51.100.7', reason: 'messages' as const, limit: 3, messagesPerHour: 3, recipientsPerHour: 10, blocked: false };
  adminEmail = 'admin@corp.test';
  await reportSendRateHit(hit);
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!['action'], 'mail.send.rate-limited');
  assert.equal(audits[0]!['targetName'], 'bob@corp.test');
  assert.equal(audits[0]!['ipAddress'], '198.51.100.7');
  assert.equal(attacks[0]!['type'], 'SEND_RATE_LIMIT');
  assert.equal(attacks[0]!['service'], 'jmap');
  assert.deepEqual(inboxLookups, ['mb-admin']);
  // admin address is a Shared Mailbox → its mailbox; unknown / empty → organisation admins
  inboxLookups.length = 0; adminEmail = 'it@corp.test';
  await reportSendRateHit(hit);
  assert.deepEqual(inboxLookups, ['mb-it']);
  inboxLookups.length = 0; adminEmail = '';
  await reportSendRateHit(hit);
  assert.deepEqual(inboxLookups, ['mb-org1']);
  const n = sendRateNotice(hit, 'bob@corp.test', 'CoreMail', new Date(T0));
  assert.equal(n.subject, 'Konto bob@corp.test hat das Sendelimit erreicht — möglicherweise kompromittiert');
  assert.match(n.bodyText, /198\.51\.100\.7/);
  assert.match(n.bodyText, /JMAP/);
});
