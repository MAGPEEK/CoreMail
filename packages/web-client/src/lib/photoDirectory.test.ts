import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PhotoLookupBatcher, normalizeAddress, chunk, photoPath, MAX_BATCH, type PhotoEntry } from './photoDirectory.ts';

/** Batcher with a manual timer: `run()` fires the scheduled flush. */
function harness(lookup: (a: string[]) => Promise<Record<string, PhotoEntry>>) {
  let scheduled: (() => void) | null = null;
  const b = new PhotoLookupBatcher(lookup, { schedule: (fn) => { scheduled = fn; return 1; } });
  return {
    b,
    async run() { const fn = scheduled; scheduled = null; fn?.(); await new Promise((r) => setImmediate(r)); },
    get scheduled() { return scheduled !== null; },
  };
}

test('addresses: lower case, trimmed, invalid ones refused', () => {
  assert.equal(normalizeAddress(' Ute@One.TEST '), 'ute@one.test');
  for (const bad of ['', 'nobody', 'a b@x', '@x', null, undefined]) assert.equal(normalizeAddress(bad), null);
});

test('one request for every address asked within the batch window, duplicates merged', async () => {
  const calls: string[][] = [];
  const h = harness(async (a) => { calls.push(a); return { 'u1@one.test': { userId: 'u1', version: 'v1' } }; });
  const p = [h.b.get('u1@one.test'), h.b.get('U1@ONE.test'), h.b.get('ext@other.test')];
  await h.run();
  assert.deepEqual(calls, [['u1@one.test', 'ext@other.test']]);
  assert.deepEqual(await Promise.all(p), [{ userId: 'u1', version: 'v1' }, { userId: 'u1', version: 'v1' }, null]);
});

test('large batches are split, invalid addresses never sent', async () => {
  const calls: number[] = [];
  const h = harness(async (a) => { calls.push(a.length); return {}; });
  const all = Array.from({ length: MAX_BATCH + 5 }, (_, i) => h.b.get(`a${i}@x.test`));
  assert.equal(await h.b.get('junk'), null);
  await h.run();
  await Promise.all(all);
  assert.deepEqual(calls.sort((x, y) => y - x), [MAX_BATCH, 5]);
});

test('a failed lookup answers null; the next lookup asks again', async () => {
  let fail = true;
  const h = harness(async () => { if (fail) throw new Error('offline'); return { 'u1@one.test': { userId: 'u1', version: 'v2' } }; });
  const first = h.b.get('u1@one.test');
  await h.run();
  assert.equal(await first, null);
  fail = false;
  const second = h.b.get('u1@one.test');
  assert.ok(h.scheduled);
  await h.run();
  assert.deepEqual(await second, { userId: 'u1', version: 'v2' });
});

test('helpers: chunk, photo path with version', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 3), []);
  assert.equal(photoPath({ userId: 'u 1', version: 'abc' }), '/api/v1/users/u%201/photo?v=abc');
});
