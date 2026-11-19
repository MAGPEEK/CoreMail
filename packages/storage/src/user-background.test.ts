/**
 * 10.1 webmail background: own key prefix and columns (never the profile photo's),
 * save / replace / remove through the shared user-image store, default validation.
 * Run: node --import tsx --test src/user-background.test.ts  (in packages/storage)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';

type Row = Record<string, unknown> & { id: string };
const users = new Map<string, Row>();
const objects = new Map<string, Buffer>();
const matches = (r: Row, where: Record<string, unknown>) => Object.entries(where).every(([k, v]) => (r[k] ?? null) === v);

(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  user: {
    findUnique: async (a: { where: { id: string } }) => { const r = users.get(a.where.id); return r ? { ...r } : null; },
    count: async (a: { where: Record<string, unknown> }) => [...users.values()].filter((u) => matches(u, a.where)).length,
    updateMany: async (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = [...users.values()].filter((u) => matches(u, a.where));
      for (const r of hit) Object.assign(r, a.data);
      return { count: hit.length };
    },
  },
};
(globalThis as Record<string, unknown>)['__objectStore'] = {
  driver: 'filesystem', location: 'memory',
  async put(k: string, d: Buffer) { objects.set(k, Buffer.from(d)); },
  async get(k: string) { const v = objects.get(k); if (!v) throw Object.assign(new Error('NoSuchKey'), { code: 'NoSuchKey' }); return v; },
  async delete(k: string) { objects.delete(k); },
};

const {
  saveUserBackground, removeUserBackground, loadUserBackground, userBackgroundEtag, userBackgroundInfo,
  isUserBackgroundKey, normalizeDefaultBackground, BUILTIN_BACKGROUND_IDS, USER_BACKGROUND_PREFIX,
} = await import('./user-background.js');
const { saveProfilePhoto } = await import('./profile-photo.js');

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const A = Buffer.from('background-a');
const B = Buffer.from('background-b');

beforeEach(() => {
  users.clear();
  objects.clear();
  users.set('u1', { id: 'u1', photoKey: null, backgroundKey: null, backgroundUpdatedAt: null });
  users.set('u2', { id: 'u2', photoKey: null, backgroundKey: null, backgroundUpdatedAt: null });
});

test('background keys live under their own prefix and column', async () => {
  const saved = await saveUserBackground('u1', A, new Date(5000));
  assert.ok(saved);
  assert.equal(saved.key, `${USER_BACKGROUND_PREFIX}${sha(A).slice(0, 2)}/${sha(A)}.jpg`);
  assert.equal(users.get('u1')!['backgroundKey'], saved.key);
  assert.equal((users.get('u1')!['backgroundUpdatedAt'] as Date).getTime(), 5000);
  assert.equal(users.get('u1')!['photoKey'], null, 'the profile photo is untouched');
  assert.equal(userBackgroundEtag(saved.key), `"${sha(A)}"`);
  assert.deepEqual(userBackgroundInfo(saved.key, new Date(5000)), { version: sha(A).slice(0, 16), updatedAt: new Date(5000).toISOString() });
  assert.deepEqual(await loadUserBackground(saved.key), A);
  // a profile photo key is no background key and is never served as one
  const photo = await saveProfilePhoto('u2', A);
  assert.equal(isUserBackgroundKey(photo!.key), false);
  await assert.rejects(loadUserBackground(photo!.key));
});

test('replacing releases the old object unless another user shares it; remove clears the column', async () => {
  const first = await saveUserBackground('u1', A);
  await saveUserBackground('u2', A);
  const second = await saveUserBackground('u1', B);
  assert.ok(objects.has(first!.key), 'still referenced by u2');
  assert.ok(objects.has(second!.key));
  assert.equal(await removeUserBackground('u2'), true);
  assert.equal(objects.has(first!.key), false, 'released after the last reference');
  assert.equal(users.get('u2')!['backgroundKey'], null);
  assert.equal(users.get('u2')!['backgroundUpdatedAt'], null);
  assert.equal(await removeUserBackground('u2'), false);
  assert.equal(await saveUserBackground('nobody', A), null);
});

test('organisation default: none or a built-in id, nothing else', () => {
  assert.equal(BUILTIN_BACKGROUND_IDS.length, 8);
  assert.equal(normalizeDefaultBackground('none'), 'none');
  for (const id of BUILTIN_BACKGROUND_IDS) assert.equal(normalizeDefaultBackground(`builtin:${id}`), `builtin:${id}`);
  for (const bad of ['custom', 'builtin:', 'builtin:unknown', 'builtin:lake ', '', null, 3]) {
    assert.equal(normalizeDefaultBackground(bad), null, String(bad));
  }
});

test('built-in ids are the ones the web client draws', async () => {
  // outside this package (no compile-time import): the web client's pure module
  const webModule = '../../web-client/src/lib/backgroundPrefs.ts';
  const web = (await import(webModule)) as { BUILTIN_BACKGROUND_IDS: readonly string[] };
  assert.deepEqual([...web.BUILTIN_BACKGROUND_IDS], [...BUILTIN_BACKGROUND_IDS]);
});
