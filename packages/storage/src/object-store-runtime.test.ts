/**
 * v7.1 startup wiring: sampled DB references, waitForObjectStorage blocks until
 * the referenced objects exist, health cache. Fake Prisma + in-memory store.
 * Run: node --import tsx --test src/object-store-runtime.test.ts  (in packages/storage)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';

const queries: unknown[] = [];
(globalThis as unknown as { __prisma: unknown }).__prisma = {
  $on: () => undefined,
  message: { findMany: async (a: unknown) => { queries.push(a); return [{ storagePath: 'raw/aa/m1.eml' }, { storagePath: 'raw/bb/m2.eml' }]; } },
  attachment: { findMany: async (a: unknown) => { queries.push(a); return [{ storagePath: 'attachments/m1/0' }]; } },
};

const objects = new Map<string, Buffer>();
(globalThis as unknown as { __objectStore: unknown }).__objectStore = {
  driver: 'filesystem', location: '/data/objects',
  init: async () => ({ lifecycle: false }),
  exists: async (k: string) => objects.has(k),
  stat: async (k: string) => (objects.has(k) ? { size: objects.get(k)!.length, lastModified: new Date() } : null),
  get: async (k: string) => objects.get(k)!,
  getStream: async (k: string) => Readable.from([objects.get(k)!]),
  put: async (k: string, d: Buffer) => { objects.set(k, d); },
  putStream: async () => undefined,
  delete: async (k: string) => { objects.delete(k); },
  list: async function* () { /* empty */ },
};

const { sampleStorageReferences, waitForObjectStorage, getStorageHealth, peekStorageHealth } = await import('./object-store-runtime.js');

test('sampleStorageReferences: most recent message + attachment keys via the primary-key order', async () => {
  const keys = await sampleStorageReferences();
  assert.deepEqual(keys, ['raw/aa/m1.eml', 'raw/bb/m2.eml', 'attachments/m1/0']);
  const q = queries[0] as { orderBy: unknown; take: number };
  assert.deepEqual(q.orderBy, { id: 'desc' });
  assert.equal(q.take, 5);
});

test('waitForObjectStorage blocks while the referenced objects are missing and starts once they exist', async () => {
  let resolved = false;
  const p = waitForObjectStorage('test-service', { retryMs: 20 }).then((r) => { resolved = true; return r; });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(resolved, false, 'service does not start');
  assert.equal(peekStorageHealth()?.status, 'missing-objects');
  assert.equal(peekStorageHealth()?.blocking, true);
  for (const k of ['raw/aa/m1.eml', 'raw/bb/m2.eml', 'attachments/m1/0']) objects.set(k, Buffer.from(k));
  const r = await p;
  assert.equal(r.status, 'ok');
  assert.equal((await getStorageHealth(0, true)).status, 'ok');
});

test('STORAGE_STARTUP_CHECK=off disables the check', async () => {
  objects.clear();
  process.env['STORAGE_STARTUP_CHECK'] = 'off';
  try {
    const r = await waitForObjectStorage('test-service', { retryMs: 10 });
    assert.equal(r.status, 'disabled');
  } finally {
    delete process.env['STORAGE_STARTUP_CHECK'];
  }
});
