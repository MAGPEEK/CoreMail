/**
 * Mailbox access audit (9.4): row shape, aggregation of reads, on/off, retention.
 * Run: node --import tsx --test src/mailbox-access-audit.test.ts  (in packages/storage)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccessAuditDeps, MailboxAccessEvent } from './mailbox-access-audit.js';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';
(globalThis as unknown as { __prisma: unknown }).__prisma = { $on: () => undefined };
// No Redis connection in this file (per-process claims; fakes are passed explicitly).
(globalThis as unknown as { __accessAuditRedis: null }).__accessAuditRedis = null;

const {
  recordMailboxAccess, accessAuditRow, accessAggregationKey, isAggregatedAccess, claimLocally, accessPurgeCutoff,
  purgeMailboxAccessAudit, claimShared, resetLocalAccessClaims, MAILBOX_ACCESS_ACTION_PREFIX, OPEN_AGGREGATION_SECONDS,
  SHARED_CLAIM_TIMEOUT_MS,
} = await import('./mailbox-access-audit.js');

const sharedTarget = { kind: 'shared' as const, sharedMailboxId: 'sm1', mailboxId: 'mb1', email: 'team@x.test' };
const delegatedTarget = { kind: 'delegated' as const, sharedMailboxId: null, mailboxId: 'mb-owner', email: 'owner@x.test' };

function memoryDeps(enabled = true): AccessAuditDeps & { rows: unknown[]; claims: Map<string, number> } {
  const rows: unknown[] = [];
  const claims = new Map<string, number>();
  let now = 0;
  return {
    rows, claims,
    enabled: async () => enabled,
    claim: async (key, ttl) => {
      const until = claims.get(key);
      if (until !== undefined && until > now) return false;
      claims.set(key, now + ttl * 1000);
      return true;
    },
    write: async (row) => { rows.push(row); },
    // test hook: advance the clock of the claim store
    ...{ advance: (ms: number) => { now += ms; } },
  } as AccessAuditDeps & { rows: unknown[]; claims: Map<string, number> };
}

const event = (over: Partial<MailboxAccessEvent> = {}): MailboxAccessEvent => ({
  actorId: 'u1', actorEmail: 'u1@x.test', target: sharedTarget, action: 'mailbox.foreign.open', source: 'imap', ...over,
});

test('row: sharedMailbox target for shared boxes, mailbox target for delegations; mailboxId + source in changes', () => {
  const s = accessAuditRow(event({ changes: { folder: 'INBOX' }, ipAddress: '192.0.2.1' }));
  assert.equal(s.action, 'mailbox.foreign.open');
  assert.equal(s.targetType, 'sharedMailbox');
  assert.equal(s.targetId, 'sm1');
  assert.equal(s.targetName, 'team@x.test');
  assert.deepEqual(s.changes, { mailboxId: 'mb1', source: 'imap', folder: 'INBOX' });
  assert.equal(s.ipAddress, '192.0.2.1');
  const d = accessAuditRow(event({ target: delegatedTarget, action: 'mailbox.foreign.message.delete', source: 'jmap' }));
  assert.equal(d.targetType, 'mailbox');
  assert.equal(d.targetId, 'mb-owner', 'the owner view queries the own Mailbox id');
  assert.ok(d.action.startsWith(MAILBOX_ACCESS_ACTION_PREFIX));
});

test('reads are aggregated: one "open" per actor, mailbox and client per hour; writes are always written', async () => {
  const deps = memoryDeps() as ReturnType<typeof memoryDeps> & { advance(ms: number): void };
  assert.equal(await recordMailboxAccess(event(), deps), true);
  for (let i = 0; i < 50; i++) assert.equal(await recordMailboxAccess(event(), deps), false);
  assert.equal(deps.rows.length, 1, 'fifty SELECTs → one row');
  assert.equal(await recordMailboxAccess(event({ source: 'webmail' }), deps), true, 'another client counts separately');
  assert.equal(await recordMailboxAccess(event({ actorId: 'u2' }), deps), true, 'another actor counts separately');
  assert.equal(await recordMailboxAccess(event({ target: delegatedTarget }), deps), true, 'another mailbox counts separately');
  for (let i = 0; i < 3; i++) await recordMailboxAccess(event({ action: 'mailbox.foreign.message.delete' }), deps);
  assert.equal(deps.rows.length, 7, 'every delete is written');
  deps.advance(OPEN_AGGREGATION_SECONDS * 1000 + 1);
  assert.equal(await recordMailboxAccess(event(), deps), true, 'next window → a new row');
  assert.equal(isAggregatedAccess('mailbox.foreign.send_as'), false);
  assert.match(accessAggregationKey(event()), /mailbox\.foreign\.open:u1:mb1:imap$/);
});

test('switched off → nothing is written; a failing writer never throws', async () => {
  const off = memoryDeps(false);
  assert.equal(await recordMailboxAccess(event({ action: 'mailbox.foreign.send_as' }), off), false);
  assert.equal(off.rows.length, 0);
  const broken: AccessAuditDeps = { enabled: async () => true, claim: async () => true, write: async () => { throw new Error('db down'); } };
  assert.equal(await recordMailboxAccess(event(), broken), false);
});

test('in-process claim fallback: one claim per key and window, bounded', () => {
  assert.equal(claimLocally('k-a', 10, 1000), true);
  assert.equal(claimLocally('k-a', 10, 5000), false);
  assert.equal(claimLocally('k-a', 10, 11_001), true);
});

/** In-memory SET NX EX (two "processes" share it; status as ioredis reports it). */
function fakeRedis(opts: { status?: string; fail?: boolean; hang?: boolean } = {}) {
  const keys = new Map<string, number>();
  const calls: Array<[string, number]> = [];
  let now = 0;
  return {
    calls,
    advance: (ms: number) => { now += ms; },
    status: opts.status ?? 'ready',
    set: async (key: string, _v: string, _ex: 'EX', ttl: number, _nx: 'NX'): Promise<'OK' | null> => {
      calls.push([key, ttl]);
      if (opts.fail) throw new Error('ECONNRESET');
      if (opts.hang) return new Promise<'OK' | null>(() => undefined);
      const until = keys.get(key);
      if (until !== undefined && until > now) return null;
      keys.set(key, now + ttl * 1000);
      return 'OK';
    },
  };
}

test('shared claim: SET NX EX on Redis — one row across processes; the holder answers later claims locally', async () => {
  resetLocalAccessClaims();
  const redis = fakeRedis();
  assert.equal(await claimShared('k-shared', 3600, redis, 1000), true);
  assert.deepEqual(redis.calls, [['k-shared', 3600]]);
  assert.equal(await claimShared('k-shared', 3600, redis, 2000), false);
  assert.equal(redis.calls.length, 1, 'held by this process: no second Redis round trip');
  // another process (fresh local store) asks Redis and loses
  resetLocalAccessClaims();
  assert.equal(await claimShared('k-shared', 3600, redis, 3000), false, 'claimed by another process');
  assert.equal(redis.calls.length, 2);
  assert.equal(await claimShared('k-shared', 3600, redis, 4000), false);
  assert.equal(redis.calls.length, 2, 'a key held elsewhere is not asked again at once');
});

test('shared claim: Redis not ready, failing or slow → per-process fallback (never blocks, never stops auditing)', async () => {
  resetLocalAccessClaims();
  const down = fakeRedis({ status: 'reconnecting' });
  assert.equal(await claimShared('k-down', 3600, down, 1000), true);
  assert.equal(down.calls.length, 0, 'no command is queued on a client that is not ready');
  assert.equal(await claimShared('k-down', 3600, down, 2000), false, 'aggregated in this process');

  resetLocalAccessClaims();
  assert.equal(await claimShared('k-fail', 3600, fakeRedis({ fail: true }), 1000), true);
  assert.equal(await claimShared('k-fail', 3600, fakeRedis({ fail: true }), 2000), false);

  resetLocalAccessClaims();
  const started = Date.now();
  assert.equal(await claimShared('k-slow', 3600, fakeRedis({ hang: true })), true);
  assert.ok(Date.now() - started < SHARED_CLAIM_TIMEOUT_MS + 1000, 'a hanging Redis answer times out');

  resetLocalAccessClaims();
  assert.equal(await claimShared('k-none', 3600, null, 1000), true, 'no Redis at all (test seam null)');
  assert.equal(await claimShared('k-none', 3600, null, 2000), false);
});

test('retention: cutoff from days (0 = keep), purge deletes only mailbox.foreign.* rows older than the cutoff', async () => {
  const now = new Date('2026-11-17T00:00:00Z');
  assert.equal(accessPurgeCutoff(now, 0), null);
  assert.equal(accessPurgeCutoff(now, -1), null);
  assert.equal(accessPurgeCutoff(now, 30)!.toISOString(), '2026-10-18T00:00:00.000Z');
  const calls: unknown[] = [];
  const db = { auditLog: { deleteMany: async (args: never) => { calls.push(args); return { count: 4 }; } } };
  assert.equal(await purgeMailboxAccessAudit({ now, retentionDays: 30, db }), 4);
  assert.deepEqual(calls[0], { where: { action: { startsWith: 'mailbox.foreign.' }, timestamp: { lt: new Date('2026-10-18T00:00:00Z') } } });
  assert.equal(await purgeMailboxAccessAudit({ now, retentionDays: 0, db }), 0);
  assert.equal(calls.length, 1, 'no delete when entries are kept');
});
