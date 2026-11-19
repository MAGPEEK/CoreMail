import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PhotoLookupBatcher, PhotoUrlRegistry, PHOTO_IMAGE_KEY, PHOTO_LOOKUP_KEY, normalizeAddress, chunk, photoImageKeyParts, photoPath, MAX_BATCH,
  type PhotoEntry,
} from './photoDirectory.ts';

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

test('blob URLs: a newer version never revokes the URL of an older one still on screen', () => {
  let n = 0;
  const revoked: string[] = [];
  const reg = new PhotoUrlRegistry(() => `blob:${++n}`, (u) => revoked.push(u));
  const blob = {} as Blob;
  const v1 = reg.add('u1', 'v1', blob);
  assert.equal(reg.add('u1', 'v1', blob), v1, 'one URL per user and version');
  const v2 = reg.add('u1', 'v2', blob);
  assert.notEqual(v1, v2);
  assert.deepEqual(revoked, [], 'loading v2 (own photo changed) keeps v1 alive for avatars not refreshed yet');
  assert.equal(reg.get('u1', 'v1'), v1);
  reg.release('u1', 'v1');
  assert.deepEqual(revoked, [v1], 'revoked once its cache entry is gone');
  assert.equal(reg.get('u1', 'v1'), null);
  reg.release('u1', 'v1');
  assert.equal(revoked.length, 1, 'release is idempotent');
  assert.equal(reg.size, 1);
});

test('image query keys: user and version only from photo image keys', () => {
  assert.deepEqual(photoImageKeyParts([PHOTO_IMAGE_KEY, 'u1', 'v1']), ['u1', 'v1']);
  assert.equal(photoImageKeyParts([PHOTO_IMAGE_KEY, '', '']), null, 'disabled query (no entry)');
  assert.equal(photoImageKeyParts([PHOTO_LOOKUP_KEY, 'a@x.test']), null);
  assert.equal(photoImageKeyParts(['user-profile']), null);
});
