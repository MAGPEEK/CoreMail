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
 * Writers, compare-and-set and the release of unreferenced objects:
 * user-image-store.ts (shared with the webmail background, 10.1).
 */
import { createUserImageStore, USER_IMAGE_CONTENT_TYPE, type UserImageState } from './user-image-store.js';

/** Object-store prefix of profile photos. */
export const PROFILE_PHOTO_PREFIX = 'profile-photos/';
/** Content type of every stored photo. */
export const PROFILE_PHOTO_CONTENT_TYPE = USER_IMAGE_CONTENT_TYPE;

const photos = createUserImageStore({
  prefix: PROFILE_PHOTO_PREFIX, keyField: 'photoKey', updatedField: 'photoUpdatedAt', label: 'profile photo',
});

/** Content-addressed key of a stored photo (pure). */
export const profilePhotoKey = (jpeg: Buffer): string => photos.keyOf(jpeg);
/** True for keys written by profilePhotoKey (pure). */
export const isProfilePhotoKey = (key: string | null | undefined): key is string => photos.isKey(key);
/** Short version of a photo for URLs and caches (first 16 hex digits of its hash), or null (pure). */
export const profilePhotoVersion = (key: string | null | undefined): string | null => photos.version(key);
/** Strong ETag of a photo (its full hash), or null (pure). */
export const profilePhotoEtag = (key: string | null | undefined): string | null => photos.etag(key);

/** Public description of a user's photo in API answers. */
export interface ProfilePhotoInfo { userId: string; version: string; updatedAt: string | null }

/** The API shape of a user's photo, or null without one (pure). */
export function profilePhotoInfo(userId: string, key: string | null | undefined, updatedAt: Date | null | undefined): ProfilePhotoInfo | null {
  const version = profilePhotoVersion(key);
  return version ? { userId, version, updatedAt: updatedAt ? updatedAt.toISOString() : null } : null;
}

export type ProfilePhotoState = UserImageState;

/** Deletes `key` from the object store unless a user still references it. */
export const releaseProfilePhoto = (key: string | null | undefined): Promise<void> => photos.release(key);
/** releaseProfilePhoto that logs instead of throwing (the row is already consistent; an orphan is only wasted space). */
export const releaseProfilePhotoQuietly = (key: string | null | undefined): Promise<void> => photos.releaseQuietly(key);

/**
 * Stores an already re-encoded photo as the user's profile photo. Returns the
 * new state, or null when the user does not exist (the object is released again).
 */
export const saveProfilePhoto = (userId: string, jpeg: Buffer, now: Date = new Date()): Promise<ProfilePhotoState | null> =>
  photos.save(userId, jpeg, now);

/** Removes the user's photo. Returns false when there was none (or no such user). */
export const removeProfilePhoto = (userId: string): Promise<boolean> => photos.remove(userId);

/** The stored bytes of a photo key; rejects with ObjectNotFoundError when missing. */
export const loadProfilePhoto = (key: string): Promise<Buffer> => photos.load(key);
