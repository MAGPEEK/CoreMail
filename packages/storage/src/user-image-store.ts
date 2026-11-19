/**
 * Per-user images that the api-gateway re-encodes as JPEG (9.5 profile photo,
 * 10.1 webmail background) — one writer for both.
 *
 * Storage: the object store under a content-addressed key
 * `<prefix><aa>/<sha256>.jpg` (never a user-supplied name); the user row holds
 * the key and the time of the last change (two columns per image kind). The
 * key's hash is also the image's version and ETag.
 *
 * Writers: save / remove change the key with a compare-and-set on the previous
 * key, so two concurrent changes of the same user never lose track of an
 * object; an object no user references any more is deleted (two users with
 * byte-identical images share one object).
 */
import { createHash } from 'node:crypto';
import { createLogger } from '@coremail/core/logger';
import { prisma } from './prisma/index.js';
import { getObjectStore, isNotFound } from './object-store/index.js';

const log = createLogger('user-image');

/** Content type of every stored image. */
export const USER_IMAGE_CONTENT_TYPE = 'image/jpeg';
/** Compare-and-set attempts before a write gives up (only concurrent changes of one user retry). */
const MAX_ATTEMPTS = 5;

/** Columns of the `User` row that hold one kind of image. */
export interface UserImageKind {
  /** Object-store prefix, e.g. `profile-photos/` (lower-case letters and dashes, trailing slash). */
  prefix: string;
  keyField: 'photoKey' | 'backgroundKey';
  updatedField: 'photoUpdatedAt' | 'backgroundUpdatedAt';
  /** Name in log lines. */
  label: string;
}

export interface UserImageState {
  key: string;
  version: string;
  updatedAt: Date;
}

export interface UserImageStore {
  /** Content-addressed key of an image (pure). */
  keyOf(jpeg: Buffer): string;
  /** True for keys written by keyOf (pure). */
  isKey(key: string | null | undefined): key is string;
  /** First 16 hex digits of the hash, or null (pure). */
  version(key: string | null | undefined): string | null;
  /** Strong ETag (the full hash), or null (pure). */
  etag(key: string | null | undefined): string | null;
  /** Deletes the object unless a user still references it. */
  release(key: string | null | undefined): Promise<void>;
  /** release() that logs instead of throwing. */
  releaseQuietly(key: string | null | undefined): Promise<void>;
  /** Stores an already re-encoded image as the user's; null when the user does not exist. */
  save(userId: string, jpeg: Buffer, now?: Date): Promise<UserImageState | null>;
  /** Removes the user's image; false when there was none (or no such user). */
  remove(userId: string): Promise<boolean>;
  /** Stored bytes of a key; rejects with ObjectNotFoundError when missing. */
  load(key: string): Promise<Buffer>;
}

export function createUserImageStore(kind: UserImageKind): UserImageStore {
  if (!/^[a-z-]+\/$/.test(kind.prefix)) throw new Error(`invalid image prefix ${kind.prefix}`);
  const keyRe = new RegExp(`^${kind.prefix.replace('/', '\\/')}([0-9a-f]{2})\\/([0-9a-f]{64})\\.jpg$`);
  const hashOf = (key: string | null | undefined): string | null => {
    const m = keyRe.exec(key ?? '');
    return m && m[2]!.startsWith(m[1]!) ? m[2]! : null;
  };
  const byKey = (key: string | null) => ({ [kind.keyField]: key });

  const isKey = (key: string | null | undefined): key is string => hashOf(key) !== null;
  const keyOf = (jpeg: Buffer): string => {
    const sha = createHash('sha256').update(jpeg).digest('hex');
    return `${kind.prefix}${sha.slice(0, 2)}/${sha}.jpg`;
  };

  async function isReferenced(key: string): Promise<boolean> {
    return (await prisma.user.count({ where: byKey(key) })) > 0;
  }

  /**
   * Two users may share one object (same bytes), so a save of the same image can
   * point a user at the key between the reference check and the delete. The
   * bytes are therefore read first and put back when a reference shows up after
   * the delete; save() covers the opposite order (delete before its swap) by
   * writing the object again after the swap.
   */
  async function release(key: string | null | undefined): Promise<void> {
    if (!isKey(key) || (await isReferenced(key))) return;
    const store = getObjectStore();
    let bytes: Buffer;
    try {
      bytes = await store.get(key);
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
    await store.delete(key);
    if (await isReferenced(key)) await store.put(key, bytes, { contentType: USER_IMAGE_CONTENT_TYPE });
  }

  async function releaseQuietly(key: string | null | undefined): Promise<void> {
    try {
      await release(key);
    } catch (err) {
      log.warn({ err, key, kind: kind.label }, 'Old user image could not be removed');
    }
  }

  /**
   * Sets `next` as the user's key if it still is the stored one (compare-and-set).
   * Returns the previous key on success, undefined when the user does not exist,
   * and retries with the current key when another change came first.
   */
  async function swapKey(userId: string, next: string | null, now: Date): Promise<{ prev: string | null } | undefined> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const row = await prisma.user.findUnique({ where: { id: userId }, select: { [kind.keyField]: true } }) as Record<string, string | null> | null;
      if (!row) return undefined;
      const prev = row[kind.keyField] ?? null;
      if (prev === next) return { prev };
      const { count } = await prisma.user.updateMany({
        where: { id: userId, ...byKey(prev) },
        data: { ...byKey(next), [kind.updatedField]: next ? now : null },
      });
      if (count === 1) return { prev };
    }
    throw new Error(`${kind.label} changed concurrently too often`);
  }

  return {
    keyOf,
    isKey,
    version: (key) => hashOf(key)?.slice(0, 16) ?? null,
    etag: (key) => { const h = hashOf(key); return h ? `"${h}"` : null; },
    release,
    releaseQuietly,
    async save(userId, jpeg, now = new Date()) {
      const key = keyOf(jpeg);
      const store = getObjectStore();
      await store.put(key, jpeg, { contentType: USER_IMAGE_CONTENT_TYPE });
      const swapped = await swapKey(userId, key, now);
      if (!swapped) {
        await releaseQuietly(key);
        return null;
      }
      // Another user's release of the same bytes may have deleted the object between
      // the put and the swap (see release); content-addressed, so writing it again is
      // idempotent (the filesystem driver skips an existing object).
      await store.put(key, jpeg, { contentType: USER_IMAGE_CONTENT_TYPE });
      if (swapped.prev !== key) await releaseQuietly(swapped.prev);
      return { key, version: hashOf(key)!.slice(0, 16), updatedAt: now };
    },
    async remove(userId) {
      const swapped = await swapKey(userId, null, new Date());
      if (!swapped?.prev) return false;
      await releaseQuietly(swapped.prev);
      return true;
    },
    async load(key) {
      if (!isKey(key)) throw new Error(`not a ${kind.label} key`);
      return getObjectStore().get(key);
    },
  };
}
