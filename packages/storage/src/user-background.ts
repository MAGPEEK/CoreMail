/**
 * Webmail background image (10.1) — one optional uploaded background per user
 * (Einstellungen → Darstellung → Hintergrund → "Eigenes Bild hochladen…").
 *
 * The api-gateway decodes and re-encodes every upload (JPEG, at most
 * 2560 px wide, no metadata) before it reaches this module. Storage like the
 * profile photo (user-image-store.ts): content-addressed key
 * `backgrounds/<aa>/<sha256>.jpg`, `User.backgroundKey` + `backgroundUpdatedAt`,
 * the hash is version and ETag. Only the owner ever reads it.
 *
 * Which background the webmail shows is a roaming preference
 * (`appearance.background`: none | builtin:<id> | custom, null = organisation
 * default from the branding); the built-in ids are BUILTIN_BACKGROUND_IDS.
 */
import { createUserImageStore, USER_IMAGE_CONTENT_TYPE, type UserImageState } from './user-image-store.js';

export const USER_BACKGROUND_PREFIX = 'backgrounds/';
export const USER_BACKGROUND_CONTENT_TYPE = USER_IMAGE_CONTENT_TYPE;

/**
 * Built-in backgrounds drawn by CoreMail (web-client lib/backgrounds.ts holds the
 * pictures): Bergsee bei Nacht, Morgendämmerung, Wald, Küste, Dünen, Wellen,
 * Polarlicht, Neutral. KEEP IN STEP with the web client.
 */
export const BUILTIN_BACKGROUND_IDS = ['lake', 'dawn', 'forest', 'coast', 'dunes', 'waves', 'aurora', 'neutral'] as const;
export type BuiltinBackgroundId = typeof BUILTIN_BACKGROUND_IDS[number];

/** Organisation default (branding): none or a built-in background. */
export type DefaultBackground = 'none' | `builtin:${BuiltinBackgroundId}`;

/** `none` / `builtin:<id>` → the value, anything else → null (pure). */
export function normalizeDefaultBackground(v: unknown): DefaultBackground | null {
  if (v === 'none') return 'none';
  if (typeof v !== 'string' || !v.startsWith('builtin:')) return null;
  const id = v.slice('builtin:'.length);
  return (BUILTIN_BACKGROUND_IDS as readonly string[]).includes(id) ? (v as DefaultBackground) : null;
}

const backgrounds = createUserImageStore({
  prefix: USER_BACKGROUND_PREFIX, keyField: 'backgroundKey', updatedField: 'backgroundUpdatedAt', label: 'background',
});

/** Version of a stored background (16 hex digits), or null (pure). */
export const userBackgroundVersion = (key: string | null | undefined): string | null => backgrounds.version(key);
/** Strong ETag of a stored background, or null (pure). */
export const userBackgroundEtag = (key: string | null | undefined): string | null => backgrounds.etag(key);
export const isUserBackgroundKey = (key: string | null | undefined): key is string => backgrounds.isKey(key);

/** API shape of the own uploaded background, or null without one (pure). */
export interface UserBackgroundInfo { version: string; updatedAt: string | null }
export function userBackgroundInfo(key: string | null | undefined, updatedAt: Date | null | undefined): UserBackgroundInfo | null {
  const version = userBackgroundVersion(key);
  return version ? { version, updatedAt: updatedAt ? updatedAt.toISOString() : null } : null;
}

export type UserBackgroundState = UserImageState;

/** Stores an already re-encoded background; null when the user does not exist. */
export const saveUserBackground = (userId: string, jpeg: Buffer, now: Date = new Date()): Promise<UserBackgroundState | null> =>
  backgrounds.save(userId, jpeg, now);
/** Removes the uploaded background; false when there was none. */
export const removeUserBackground = (userId: string): Promise<boolean> => backgrounds.remove(userId);
/** Stored bytes of a background key; rejects with ObjectNotFoundError when missing. */
export const loadUserBackground = (key: string): Promise<Buffer> => backgrounds.load(key);
/** Releases an object no user references any more (account deletion); logs instead of throwing. */
export const releaseUserBackgroundQuietly = (key: string | null | undefined): Promise<void> => backgrounds.releaseQuietly(key);
