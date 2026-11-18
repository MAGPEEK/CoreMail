/**
 * 9.4: sensitivity of a message (normal / personal / private / confidential).
 * Pure module:
 *  - read from the top-level `Sensitivity` header of raw octets (values
 *    `Personal`, `Private`, `Company-Confidential`; anything else is normal) —
 *    stored with the message (`Message.sensitivity`, null = normal) so the
 *    webmail reader can show a badge;
 *  - written for outgoing mail from a validated level only (never raw client
 *    text): drafts, the outbound worker and the sender's Sent copy.
 */
import { findBodyStart, headerValue, parseHeaderFields } from './mime/tree.js';

export type Sensitivity = 'normal' | 'personal' | 'private' | 'confidential';

export const SENSITIVITY_LEVELS: readonly Sensitivity[] = ['normal', 'personal', 'private', 'confidential'];

export const SENSITIVITY_HEADER = 'Sensitivity';

/** Header section bytes looked at (sensitivity lives in the top-level header). */
const MAX_HEADER_SCAN = 256 * 1024;

const HEADER_VALUE: Record<Exclude<Sensitivity, 'normal'>, string> = {
  personal: 'Personal',
  private: 'Private',
  confidential: 'Company-Confidential',
};

/** A client / job value as a sensitivity level; anything unknown is normal. */
export function normalizeSensitivity(value: unknown): Sensitivity {
  return value === 'personal' || value === 'private' || value === 'confidential' ? value : 'normal';
}

/** The value stored with a message: null for normal (the column stays empty for most mail). */
export function storedSensitivity(level: Sensitivity): Exclude<Sensitivity, 'normal'> | null {
  return level === 'normal' ? null : level;
}

/** Level of a `Sensitivity` header value (case-insensitive; unknown values are normal). */
export function sensitivityOfHeader(value: string | null | undefined): Sensitivity {
  const s = (value ?? '').trim().toLowerCase();
  if (s === 'personal') return 'personal';
  if (s === 'private') return 'private';
  if (s === 'company-confidential' || s === 'confidential') return 'confidential';
  return 'normal';
}

/** Sensitivity of raw RFC 5322 octets (top-level header only). */
export function sensitivityOfRaw(raw: Buffer): Sensitivity {
  const s = raw.subarray(0, Math.min(raw.length, MAX_HEADER_SCAN)).toString('latin1');
  return sensitivityOfHeader(headerValue(parseHeaderFields(s, 0, findBodyStart(s, 0, s.length)), 'sensitivity'));
}

/** Extra header for nodemailer's `headers` option (normal: none). */
export function sensitivityHeaders(level: Sensitivity): Record<string, string> {
  return level === 'normal' ? {} : { [SENSITIVITY_HEADER]: HEADER_VALUE[level] };
}
