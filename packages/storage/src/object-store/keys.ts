/**
 * Object key rules shared by all drivers.
 *
 * Keys are relative, `/`-separated paths. The filesystem driver maps them 1:1
 * to files under STORAGE_PATH, so every key written by CoreMail must be a safe
 * path on every driver (otherwise a MinIO install could hold objects that can
 * never be migrated to the filesystem).
 */
import { InvalidObjectKeyError } from './types.js';

/** Prefix of in-flight temp files of the filesystem driver (never a valid key segment). */
export const TEMP_PREFIX = '.tmp-';

const MAX_KEY_LENGTH = 1024;
const MAX_SEGMENT_LENGTH = 255;
// Characters Windows refuses in file names (only enforced on win32, where the
// filesystem driver would otherwise create alternate data streams / fail).
const WIN32_FORBIDDEN = /[<>:"|?*]/;

export interface KeyRuleOptions {
  /** Defaults to process.platform. */
  platform?: NodeJS.Platform;
}

/** Throws {@link InvalidObjectKeyError} unless `key` is a safe relative object path. */
export function validateObjectKey(key: string, opts: KeyRuleOptions = {}): void {
  const platform = opts.platform ?? process.platform;
  if (typeof key !== 'string' || key.length === 0) throw new InvalidObjectKeyError(String(key), 'empty');
  if (key.length > MAX_KEY_LENGTH) throw new InvalidObjectKeyError(key, 'too long');
  if (key.includes('\0')) throw new InvalidObjectKeyError(key, 'contains NUL');
  if (key.includes('\\')) throw new InvalidObjectKeyError(key, 'contains a backslash');
  if (key.startsWith('/')) throw new InvalidObjectKeyError(key, 'absolute key');
  if (/^[a-zA-Z]:/.test(key)) throw new InvalidObjectKeyError(key, 'drive-letter key');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(key)) throw new InvalidObjectKeyError(key, 'contains control characters');
  for (const seg of key.split('/')) {
    if (seg === '') throw new InvalidObjectKeyError(key, 'empty path segment');
    if (seg === '.' || seg === '..') throw new InvalidObjectKeyError(key, 'dot segment');
    if (seg.length > MAX_SEGMENT_LENGTH) throw new InvalidObjectKeyError(key, 'path segment too long');
    if (seg.startsWith(TEMP_PREFIX)) throw new InvalidObjectKeyError(key, 'reserved temp-file name');
    if (platform === 'win32') {
      if (WIN32_FORBIDDEN.test(seg)) throw new InvalidObjectKeyError(key, 'character not allowed on Windows');
      if (/[. ]$/.test(seg)) throw new InvalidObjectKeyError(key, 'trailing dot/space not allowed on Windows');
    }
  }
}

export function isValidObjectKey(key: string, opts?: KeyRuleOptions): boolean {
  try { validateObjectKey(key, opts); return true; } catch { return false; }
}

/** Validates a listing prefix: '' or a key-like string (may end with '/'). */
export function validateObjectPrefix(prefix: string, opts?: KeyRuleOptions): void {
  if (prefix === '') return;
  const trimmed = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  validateObjectKey(trimmed, opts);
}

const CONTENT_ADDRESSED = /^raw\/[0-9a-f]{2}\/([0-9a-f]{64})\.eml$/;

/** True for content-addressed raw message keys (`raw/<aa>/<sha256>.eml`), which are written once. */
export function isContentAddressedKey(key: string): boolean {
  return CONTENT_ADDRESSED.test(key);
}

/** sha256 hex encoded in a content-addressed key, or null. */
export function contentAddressOf(key: string): string | null {
  return CONTENT_ADDRESSED.exec(key)?.[1] ?? null;
}

/**
 * Turns arbitrary text (e.g. a user-supplied file name) into one safe key
 * segment: percent-encoded, never `.`/`..`, never a temp-file name, ≤ 200 chars.
 */
export function safeKeySegment(text: string): string {
  let s = encodeURIComponent(text).replace(/[!'()*~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  if (s.length > 200) s = s.slice(0, 200).replace(/%[0-9A-F]?$/, '');
  if (s === '' || s === '.' || s === '..' || s.startsWith('.')) s = '_' + s;
  if (s.endsWith('.')) s = s + '_';
  return s;
}
