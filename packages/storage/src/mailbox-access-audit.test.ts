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

const {
  recordMailboxAccess, accessAuditRow, accessAggregationKey, isAggregatedAccess, claimLocally, accessPurgeCutoff,
  purgeMailboxAccessAudit, MAILBOX_ACCESS_ACTION_PREFIX, OPEN_AGGREGATION_SECONDS,
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
