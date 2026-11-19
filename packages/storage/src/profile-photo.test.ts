/**
 * 9.5 profile photos: content-addressed keys, versions / ETags, save + remove
 * with compare-and-set and release of objects no user references any more.
 * Fake Prisma (globalThis.__prisma) and an in-memory object store (globalThis.__objectStore).
 * Run: node --import tsx --test src/profile-photo.test.ts  (in packages/storage)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';

type Row = { id: string; photoKey: string | null; photoUpdatedAt: Date | null };
const users = new Map<string, Row>();
const objects = new Map<string, Buffer>();
/** Runs once before the next updateMany (simulates a concurrent change). */
let beforeUpdate: (() => void | Promise<void>) | null = null;
/** Runs once before the next object delete (simulates a concurrent save). */
let beforeDelete: (() => Promise<void>) | null = null;

(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  user: {
    findUnique: async (a: { where: { id: string } }) => { const r = users.get(a.where.id); return r ? { ...r } : null; },
    count: async (a: { where: { photoKey: string } }) => [...users.values()].filter((u) => u.photoKey === a.where.photoKey).length,
    updateMany: async (a: { where: { id: string; photoKey: string | null }; data: Partial<Row> }) => {
      const hook = beforeUpdate;
      beforeUpdate = null;
      await hook?.();
      const r = users.get(a.where.id);
      if (!r || r.photoKey !== a.where.photoKey) return { count: 0 };
      Object.assign(r, a.data);
      return { count: 1 };
    },
  },
};
(globalThis as Record<string, unknown>)['__objectStore'] = {
  driver: 'filesystem', location: 'memory',
  async put(k: string, d: Buffer) { objects.set(k, Buffer.from(d)); },
  async get(k: string) { const v = objects.get(k); if (!v) throw Object.assign(new Error('NoSuchKey'), { code: 'NoSuchKey' }); return v; },
  async delete(k: string) { const hook = beforeDelete; beforeDelete = null; await hook?.(); objects.delete(k); },
};

const {
  profilePhotoKey, isProfilePhotoKey, profilePhotoVersion, profilePhotoEtag,
  saveProfilePhoto, removeProfilePhoto, loadProfilePhoto, releaseProfilePhoto, PROFILE_PHOTO_PREFIX,
} = await import('./profile-photo.js');

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const A = Buffer.from('jpeg-a');
const B = Buffer.from('jpeg-b');

beforeEach(() => {
  users.clear();
  objects.clear();
  beforeUpdate = null;
  beforeDelete = null;
  users.set('u1', { id: 'u1', photoKey: null, photoUpdatedAt: null });
  users.set('u2', { id: 'u2', photoKey: null, photoUpdatedAt: null });
});

test('keys are content-addressed, never derived from user input', () => {
  const key = profilePhotoKey(A);
  assert.equal(key, `${PROFILE_PHOTO_PREFIX}${sha(A).slice(0, 2)}/${sha(A)}.jpg`);
  assert.ok(isProfilePhotoKey(key));
  assert.equal(profilePhotoVersion(key), sha(A).slice(0, 16));
  assert.equal(profilePhotoEtag(key), `"${sha(A)}"`);
  for (const bad of [null, '', 'profile-photos/../x.jpg', `profile-photos/zz/${sha(A)}.jpg`, `branding/${sha(A)}.png`, `profile-photos/${sha(A).slice(0, 2)}/${sha(A)}.png`]) {
    assert.equal(isProfilePhotoKey(bad), false, String(bad));
    assert.equal(profilePhotoVersion(bad), null);
  }
});

test('save stores the object and the key; replacing releases the old object', async () => {
  const first = await saveProfilePhoto('u1', A, new Date(1000));
  assert.ok(first);
  assert.equal(users.get('u1')!.photoKey, profilePhotoKey(A));
  assert.equal(users.get('u1')!.photoUpdatedAt?.getTime(), 1000);
  assert.deepEqual(await loadProfilePhoto(first.key), A);

  await saveProfilePhoto('u1', B);
  assert.equal(users.get('u1')!.photoKey, profilePhotoKey(B));
  assert.equal(objects.has(profilePhotoKey(A)), false, 'old photo removed');
  assert.equal(objects.has(profilePhotoKey(B)), true);
});

test('an object shared by two users stays until the last reference is gone', async () => {
  await saveProfilePhoto('u1', A);
  await saveProfilePhoto('u2', A);
  assert.equal(await removeProfilePhoto('u1'), true);
  assert.equal(objects.has(profilePhotoKey(A)), true, 'u2 still uses it');
  assert.equal(await removeProfilePhoto('u2'), true);
  assert.equal(objects.has(profilePhotoKey(A)), false);
  assert.equal(await removeProfilePhoto('u2'), false, 'nothing left to remove');
});

test('unknown user: nothing referenced, the stored object is released again', async () => {
  assert.equal(await saveProfilePhoto('ghost', A), null);
  assert.equal(objects.size, 0);
  assert.equal(await removeProfilePhoto('ghost'), false);
});

test('a concurrent change is retried against the current key — no object is orphaned', async () => {
  await saveProfilePhoto('u1', A);
  // another request sets B between our read and our write
  beforeUpdate = () => {
    objects.set(profilePhotoKey(B), B);
    users.get('u1')!.photoKey = profilePhotoKey(B);
  };
  const C = Buffer.from('jpeg-c');
  await saveProfilePhoto('u1', C);
  assert.equal(users.get('u1')!.photoKey, profilePhotoKey(C));
  assert.equal(objects.has(profilePhotoKey(B)), false, 'the concurrently written photo is released');
});

test('race (same bytes): another user saves the photo while it is being released — the object is put back', async () => {
  await saveProfilePhoto('u2', A);
  // u2 removes it; after the reference check, before the delete, u1 saves the same photo completely
  beforeDelete = async () => { assert.ok(await saveProfilePhoto('u1', A)); };
  assert.equal(await removeProfilePhoto('u2'), true);
  assert.equal(users.get('u1')!.photoKey, profilePhotoKey(A));
  assert.deepEqual(objects.get(profilePhotoKey(A)), A, 'u1 must not point at a deleted object');
});

test('race (same bytes): the release deletes between the save\'s upload and its key swap — the save writes it again', async () => {
  await saveProfilePhoto('u2', A);
  // u1 has uploaded A; before its swap, u2 removes A (no reference yet → deleted)
  beforeUpdate = async () => { assert.equal(await removeProfilePhoto('u2'), true); };
  assert.ok(await saveProfilePhoto('u1', A));
  assert.equal(users.get('u1')!.photoKey, profilePhotoKey(A));
  assert.deepEqual(objects.get(profilePhotoKey(A)), A, 'u1 must not point at a deleted object');
});

test('release of an object that is already gone is a no-op', async () => {
  await assert.doesNotReject(releaseProfilePhoto(profilePhotoKey(A)));
  assert.equal(objects.size, 0);
});

test('release ignores foreign keys and keeps referenced ones', async () => {
  objects.set('branding/x.png', Buffer.from('x'));
  await releaseProfilePhoto('branding/x.png');
  assert.equal(objects.has('branding/x.png'), true);
  await assert.rejects(loadProfilePhoto('branding/x.png'));
});
