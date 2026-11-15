/**
 * v7.1 storage migration job: refusals (same store, ephemeral target, running),
 * Redis lock + last report, completion, cancel. In-memory stores + fake Redis.
 * Run: node --import tsx --test src/lib/storage-migration.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { setTestEnv, installFakePrisma } from '../test-support/fake-prisma.js';

setTestEnv();
installFakePrisma({});

const { startMigration, getMigrationJob, cancelMigration, resetMigrationForTests, MIGRATE_LOCK_KEY, MIGRATE_LAST_KEY } = await import('./storage-migration.js');
const { ObjectNotFoundError } = await import('@coremail/storage');
type Store = import('@coremail/storage').ObjectStore;
type Driver = import('@coremail/storage').ObjectStorageDriver;

function memStore(driver: Driver, location: string, objects = new Map<string, Buffer>()): Store & { objects: Map<string, Buffer> } {
  return {
    driver, location, objects,
    init: async () => ({ lifecycle: false }),
    put: async (k, d) => { objects.set(k, Buffer.from(d)); },
    putStream: async (k, s) => { const c: Buffer[] = []; for await (const x of s) c.push(x as Buffer); objects.set(k, Buffer.concat(c)); },
    get: async (k) => { const o = objects.get(k); if (!o) throw new ObjectNotFoundError(k); return o; },
    getStream: async (k) => { const o = objects.get(k); if (!o) throw new ObjectNotFoundError(k); return Readable.from([o]); },
    stat: async (k) => (objects.has(k) ? { size: objects.get(k)!.length, lastModified: new Date() } : null),
    exists: async (k) => objects.has(k),
    delete: async (k) => { objects.delete(k); },
    list: async function* (p) { for (const [k, v] of [...objects].sort()) if (k.startsWith(p)) yield { key: k, size: v.length, lastModified: new Date() }; },
  };
}

class FakeRedis {
  kv = new Map<string, string>();
  async set(key: string, value: string, ...args: Array<string | number>) {
    if (args.includes('NX') && this.kv.has(key)) return null;
    this.kv.set(key, value);
    return 'OK';
  }
  async get(key: string) { return this.kv.get(key) ?? null; }
  async del(key: string) { this.kv.delete(key); return 1; }
  async pexpire() { return 1; }
}

const until = async (fn: () => Promise<boolean> | boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('timeout');
};

let redis: FakeRedis;
let source: ReturnType<typeof memStore>;
let target: ReturnType<typeof memStore>;
beforeEach(() => {
  resetMigrationForTests();
  redis = new FakeRedis();
  source = memStore('minio', 'http://minio:9000/coremail-attachments', new Map([['raw/aa/x.eml', Buffer.from('x')], ['attachments/m/0', Buffer.from('att')]]));
  target = memStore('filesystem', '/data/objects');
});
const deps = (extra: Record<string, unknown> = {}) => ({
  redis, storeFor: (d: Driver) => (d === 'filesystem' ? target : source), isEphemeral: async () => false, ...extra,
});

test('copies in the background, releases the lock and keeps the last report in Redis', async () => {
  const r = await startMigration({ from: 'minio', to: 'filesystem', actor: 'admin@x.test' }, deps());
  assert.ok(r.started);
  await until(async () => !(await getMigrationJob(deps()))!.running);
  const job = (await getMigrationJob(deps()))!;
  assert.equal(job.progress.phase, 'done');
  assert.equal(job.progress.copied, 2);
  assert.equal(target.objects.get('attachments/m/0')!.toString(), 'att');
  assert.equal(source.objects.size, 2, 'source untouched');
  await until(() => !redis.kv.has(MIGRATE_LOCK_KEY));
  assert.equal(JSON.parse(redis.kv.get(MIGRATE_LAST_KEY)!).progress.phase, 'done');
  // after a gateway restart the report comes from Redis
  resetMigrationForTests();
  assert.equal((await getMigrationJob(deps()))!.progress.copied, 2);
});

test('refuses same store, an ephemeral filesystem target and a second concurrent run', async () => {
  const same = await startMigration({ from: 'minio', to: 's3', actor: 'a' }, { ...deps(), storeFor: () => source });
  assert.ok(!same.started && same.reason === 'same-store');
  const eph = await startMigration({ from: 'minio', to: 'filesystem', actor: 'a' }, deps({ isEphemeral: async () => true }));
  assert.ok(!eph.started && eph.reason === 'ephemeral-target');
  redis.kv.set(MIGRATE_LOCK_KEY, 'other-instance');
  const locked = await startMigration({ from: 'minio', to: 'filesystem', actor: 'a' }, deps());
  assert.ok(!locked.started && locked.reason === 'running');
});

test('cancel stops a running job; an interrupted job reports cancelled after restart', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const slow = { ...source, list: async function* (p: string) { await gate; yield* source.list(p); } };
  const r = await startMigration({ from: 'minio', to: 'filesystem', actor: 'a' }, { ...deps(), storeFor: (d: Driver) => (d === 'filesystem' ? target : slow) });
  assert.ok(r.started);
  assert.equal(cancelMigration(), true);
  release();
  await until(async () => !(await getMigrationJob(deps()))!.running);
  assert.equal((await getMigrationJob(deps()))!.progress.phase, 'cancelled');
  assert.equal(cancelMigration(), false);
  // a report saved while running → "interrupted" after a restart
  redis.kv.set(MIGRATE_LAST_KEY, JSON.stringify({ ...r.started ? r.job : {}, running: true, progress: { ...(r.started ? r.job.progress : {}), phase: 'copying' } }));
  resetMigrationForTests();
  const j = (await getMigrationJob(deps()))!;
  assert.equal(j.running, false);
  assert.equal(j.progress.phase, 'cancelled');
  assert.match(j.progress.error!, /interrupted/);
});
