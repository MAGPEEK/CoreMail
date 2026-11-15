/**
 * v7.1.0: backup schedules and the retention worker run once per cron fire
 * across all app instances, never overlap, and a lock is only released by its
 * owner. Infra-free: a fake Redis (SET NX PX + the compare-and-delete /
 * compare-and-pexpire scripts).
 * Run: node --import tsx --test src/scheduler/locks.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimSlot, withLock, fireSlot, RELEASE_SCRIPT, EXTEND_SCRIPT, LOCK_KEYS, type LockRedis } from './locks.js';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'x'.repeat(40);
process.env['PEPPER'] ??= 'y'.repeat(40);
(globalThis as Record<string, unknown>)['__prisma'] = { $on: () => undefined };
const { retentionTick, scheduleTick, runRetentionLocked } = await import('./index.js');

class FakeRedis implements LockRedis {
  store = new Map<string, { value: string; expiresAt: number }>();
  now = 0;
  private live(key: string) {
    const e = this.store.get(key);
    if (e && e.expiresAt <= this.now) { this.store.delete(key); return undefined; }
    return e;
  }
  async set(key: string, value: string, _px: 'PX', ttlMs: number, _nx: 'NX'): Promise<'OK' | null> {
    if (this.live(key)) return null;
    this.store.set(key, { value, expiresAt: this.now + ttlMs });
    return 'OK';
  }
  async eval(script: string, _n: number, key: string, token: string, ttl?: string): Promise<unknown> {
    const e = this.live(key);
    if (!e || e.value !== token) return 0;
    if (script === RELEASE_SCRIPT) { this.store.delete(key); return 1; }
    if (script === EXTEND_SCRIPT) { e.expiresAt = this.now + Number(ttl); return 1; }
    throw new Error('unknown script');
  }
}

const deferred = () => { let resolve!: () => void; const p = new Promise<void>((r) => { resolve = r; }); return { p, resolve }; };
const fakeResult = { runId: 'r', policiesProcessed: 0, mailboxesScanned: 0, itemsScanned: 0, itemsArchived: 0, itemsSoftDeleted: 0, itemsHardDeleted: 0, throttled: false, errors: [] };

test('fireSlot rounds to the nearest minute (tolerates clock skew between instances)', () => {
  assert.equal(fireSlot(10 * 60_000 - 20_000), 10);
  assert.equal(fireSlot(10 * 60_000 + 20_000), 10);
  assert.equal(fireSlot(11 * 60_000), 11);
});

test('claimSlot: exactly one instance wins a cron fire', async () => {
  const r = new FakeRedis();
  const wins = await Promise.all([1, 2, 3].map(() => claimSlot(r, 'k', 42)));
  assert.deepEqual(wins.filter(Boolean).length, 1);
  assert.equal(await claimSlot(r, 'k', 43), true, 'the next fire is claimable again');
});

test('withLock: second owner is refused while the first runs; only the owner releases', async () => {
  const r = new FakeRedis();
  const gate = deferred();
  const first = withLock(r, 'lock', async () => { await gate.p; return 1; });
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(await withLock(r, 'lock', async () => 2), { ran: false });
  // a foreign token cannot delete the lock
  assert.equal(await r.eval(RELEASE_SCRIPT, 1, 'lock', 'not-the-owner'), 0);
  assert.ok(r.store.has('lock'));
  gate.resolve();
  assert.deepEqual(await first, { ran: true, value: 1 });
  assert.equal(r.store.has('lock'), false, 'released after the work settled');
  assert.deepEqual(await withLock(r, 'lock', async () => 3), { ran: true, value: 3 });
});

test('withLock: released even when the work throws', async () => {
  const r = new FakeRedis();
  await assert.rejects(withLock(r, 'lock', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(r.store.has('lock'), false);
});

test('retentionTick: two instances firing the same schedule run the retention once', async () => {
  const r = new FakeRedis();
  let runs = 0;
  const run = async () => { runs++; await new Promise((res) => setImmediate(res)); return fakeResult; };
  const outcomes = await Promise.all([retentionTick(r, run), retentionTick(r, run)]);
  assert.equal(runs, 1);
  assert.deepEqual([...outcomes].sort(), ['ran', 'slot-taken']);
  // the same fire arriving late on a third instance (after the run finished) is still skipped
  assert.equal(await retentionTick(r, run), 'slot-taken');
  assert.equal(runs, 1);
});

test('retentionTick: a new fire does not overlap a run that is still in progress', async () => {
  const r = new FakeRedis();
  const gate = deferred();
  const long = runRetentionLocked(r, async () => { await gate.p; return fakeResult; });
  await new Promise((res) => setImmediate(res));
  let runs = 0;
  assert.equal(await retentionTick(r, async () => { runs++; return fakeResult; }), 'busy');
  assert.equal(runs, 0);
  gate.resolve();
  assert.equal((await long).ran, true);
});

test('scheduleTick: one backup per fire across instances; lock held until the backup finished', async () => {
  const r = new FakeRedis();
  const backupDone = deferred();
  let starts = 0;
  const start = async () => { starts++; return { done: backupDone.p }; };
  const a = scheduleTick(r, 's1', start);
  const b = scheduleTick(r, 's1', start);
  assert.equal(await b, 'slot-taken');
  await new Promise((res) => setImmediate(res));
  assert.equal(starts, 1);
  assert.ok(r.store.has(LOCK_KEYS.scheduleRun('s1')), 'run lock held while the backup job runs');
  // next fire (another minute) while the backup still runs → busy, nothing started
  r.store.forEach((_v, k) => { if (k.startsWith(LOCK_KEYS.scheduleSlot('s1'))) r.store.delete(k); });
  assert.equal(await scheduleTick(r, 's1', start), 'busy');
  assert.equal(starts, 1);
  backupDone.resolve();
  assert.equal(await a, 'ran');
  assert.equal(r.store.has(LOCK_KEYS.scheduleRun('s1')), false);
  // other schedules are independent
  assert.equal(await scheduleTick(r, 's2', async () => null), 'ran');
});
