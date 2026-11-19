/**
 * Profile photos (9.5) — one optional photo per user, see docs/user-settings.md.
 *
 * The api-gateway decodes, crops and re-encodes every upload (512×512 JPEG,
 * no metadata) before it reaches this module; here the bytes are only stored.
 *
 * Storage: the object store under a content-addressed key
 * `profile-photos/<aa>/<sha256>.jpg` (never a user-supplied name); the user row
 * holds the key (`User.photoKey`) and the time of the last change
 * (`photoUpdatedAt`). The key's hash is also the photo's version and ETag.
 *
 * Writers: saveProfilePhoto / removeProfilePhoto change the key with a
 * compare-and-set on the previous key, so two concurrent changes of the same
 * user never lose track of an object; an object no user references any more is
 * deleted (two users with byte-identical photos share one object).
 */
import { createHash } from 'node:crypto';
import { createLogger } from '@coremail/core/logger';
import { prisma } from './prisma/index.js';
import { getObjectStore, isNotFound } from './object-store/index.js';

const log = createLogger('profile-photo');

/** Object-store prefix of profile photos. */
export const PROFILE_PHOTO_PREFIX = 'profile-photos/';
/** Content type of every stored photo. */
export const PROFILE_PHOTO_CONTENT_TYPE = 'image/jpeg';

const KEY_RE = /^profile-photos\/([0-9a-f]{2})\/([0-9a-f]{64})\.jpg$/;
/** Compare-and-set attempts before a write gives up (only concurrent changes of one user retry). */
const MAX_ATTEMPTS = 5;

/** Content-addressed key of a stored photo (pure). */
export function profilePhotoKey(jpeg: Buffer): string {
  const sha = createHash('sha256').update(jpeg).digest('hex');
  return `${PROFILE_PHOTO_PREFIX}${sha.slice(0, 2)}/${sha}.jpg`;
}

/** True for keys written by profilePhotoKey (pure). */
export function isProfilePhotoKey(key: string | null | undefined): key is string {
  const m = KEY_RE.exec(key ?? '');
  return m !== null && m[2]!.startsWith(m[1]!);
}

/** Short version of a photo for URLs and caches (first 16 hex digits of its hash), or null (pure). */
export function profilePhotoVersion(key: string | null | undefined): string | null {
  return isProfilePhotoKey(key) ? KEY_RE.exec(key)![2]!.slice(0, 16) : null;
}

/** Strong ETag of a photo (its full hash), or null (pure). */
export function profilePhotoEtag(key: string | null | undefined): string | null {
  return isProfilePhotoKey(key) ? `"${KEY_RE.exec(key)![2]!}"` : null;
}

/** Public description of a user's photo in API answers. */
export interface ProfilePhotoInfo { userId: string; version: string; updatedAt: string | null }

/** The API shape of a user's photo, or null without one (pure). */
export function profilePhotoInfo(userId: string, key: string | null | undefined, updatedAt: Date | null | undefined): ProfilePhotoInfo | null {
  const version = profilePhotoVersion(key);
  return version ? { userId, version, updatedAt: updatedAt ? updatedAt.toISOString() : null } : null;
}

export interface ProfilePhotoState {
  key: string;
  version: string;
  updatedAt: Date;
}

async function isReferenced(key: string): Promise<boolean> {
  return (await prisma.user.count({ where: { photoKey: key } })) > 0;
}

/**
 * Deletes `key` from the object store unless a user still references it.
 *
 * Two users may share one object (same bytes), so a save of the same photo can
 * point a user at the key between the reference check and the delete. The
 * bytes are therefore read first and put back when a reference shows up after
 * the delete; saveProfilePhoto covers the opposite order (delete before its
 * swap) by writing the object again after the swap.
 */
export async function releaseProfilePhoto(key: string | null | undefined): Promise<void> {
  if (!isProfilePhotoKey(key) || (await isReferenced(key))) return;
  const store = getObjectStore();
  let bytes: Buffer;
  try {
    bytes = await store.get(key);
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }
  await store.delete(key);
  if (await isReferenced(key)) await store.put(key, bytes, { contentType: PROFILE_PHOTO_CONTENT_TYPE });
}

/** releaseProfilePhoto that logs instead of throwing (the row is already consistent; an orphan is only wasted space). */
export async function releaseProfilePhotoQuietly(key: string | null | undefined): Promise<void> {
  try {
    await releaseProfilePhoto(key);
  } catch (err) {
    log.warn({ err, key }, 'Old profile photo could not be removed');
  }
}

/**
 * Sets `next` as the user's photo key if it still is `prev` (compare-and-set).
 * Returns the previous key on success, undefined when the user does not exist,
 * and retries with the current key when another change came first.
 */
async function swapPhotoKey(userId: string, next: string | null, now: Date): Promise<{ prev: string | null } | undefined> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const row = await prisma.user.findUnique({ where: { id: userId }, select: { photoKey: true } });
    if (!row) return undefined;
    const prev = row.photoKey ?? null;
    if (prev === next) return { prev };
    const { count } = await prisma.user.updateMany({
      where: { id: userId, photoKey: prev },
      data: { photoKey: next, photoUpdatedAt: next ? now : null },
    });
    if (count === 1) return { prev };
  }
  throw new Error('profile photo changed concurrently too often');
}

/**
 * Stores an already re-encoded photo as the user's profile photo. Returns the
 * new state, or null when the user does not exist (the object is released again).
 */
export async function saveProfilePhoto(userId: string, jpeg: Buffer, now: Date = new Date()): Promise<ProfilePhotoState | null> {
  const key = profilePhotoKey(jpeg);
  const store = getObjectStore();
  await store.put(key, jpeg, { contentType: PROFILE_PHOTO_CONTENT_TYPE });
  const swapped = await swapPhotoKey(userId, key, now);
  if (!swapped) {
    await releaseProfilePhotoQuietly(key);
    return null;
  }
  // Another user's release of the same bytes may have deleted the object between
  // the put and the swap (see releaseProfilePhoto); content-addressed, so writing
  // it again is idempotent (the filesystem driver skips an existing object).
  await store.put(key, jpeg, { contentType: PROFILE_PHOTO_CONTENT_TYPE });
  if (swapped.prev !== key) await releaseProfilePhotoQuietly(swapped.prev);
  return { key, version: profilePhotoVersion(key)!, updatedAt: now };
}

/** Removes the user's photo. Returns false when there was none (or no such user). */
export async function removeProfilePhoto(userId: string): Promise<boolean> {
  const swapped = await swapPhotoKey(userId, null, new Date());
  if (!swapped?.prev) return false;
  await releaseProfilePhotoQuietly(swapped.prev);
  return true;
}

/** The stored bytes of a photo key; rejects with ObjectNotFoundError when missing. */
export async function loadProfilePhoto(key: string): Promise<Buffer> {
  if (!isProfilePhotoKey(key)) throw new Error('not a profile photo key');
  return getObjectStore().get(key);
}
