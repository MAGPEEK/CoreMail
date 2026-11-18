/**
 * 9.4: importance of a message (high / normal / low). Pure module:
 *  - read from the top-level header of raw octets — `Importance` (RFC 2156),
 *    else `X-Priority` (1–2 high, 4–5 low), else `Priority` (urgent /
 *    non-urgent), else `X-MSMail-Priority` — stored with the message
 *    (`Message.importance`, null = normal) so the webmail can show it;
 *  - normalised for outgoing mail: the outbound builders pass a non-normal
 *    level to nodemailer's `priority` option, which writes `X-Priority`,
 *    `X-MSMail-Priority` and `Importance` (never raw client text).
 */
import { findBodyStart, headerValue, parseHeaderFields } from './mime/tree.js';

export type Importance = 'high' | 'normal' | 'low';

/** Header section bytes looked at (importance lives in the top-level header). */
const MAX_HEADER_SCAN = 256 * 1024;

/** A client / job value as an importance level; anything unknown is normal. */
export function normalizeImportance(value: unknown): Importance {
  return value === 'high' || value === 'low' ? value : 'normal';
}

/** The value stored with a message: null for normal (the column stays empty for most mail). */
export function storedImportance(level: Importance): 'high' | 'low' | null {
  return level === 'normal' ? null : level;
}

function fromImportanceHeader(v: string | null): Importance | null {
  const s = v?.trim().toLowerCase() ?? '';
  return s === 'high' || s === 'low' || s === 'normal' ? s : null;
}

function fromXPriority(v: string | null): Importance | null {
  const m = /^\s*([1-5])\b/.exec(v ?? '');
  if (!m) return null;
  const n = Number(m[1]);
  return n <= 2 ? 'high' : n >= 4 ? 'low' : 'normal';
}

function fromPriority(v: string | null): Importance | null {
  const s = v?.trim().toLowerCase() ?? '';
  if (s === 'urgent') return 'high';
  if (s === 'non-urgent') return 'low';
  return s === 'normal' ? 'normal' : null;
}

/** Importance of parsed header fields (first header that says something wins). */
export function importanceOfFields(fields: ReturnType<typeof parseHeaderFields>): Importance {
  return fromImportanceHeader(headerValue(fields, 'importance'))
    ?? fromXPriority(headerValue(fields, 'x-priority'))
    ?? fromPriority(headerValue(fields, 'priority'))
    ?? fromImportanceHeader(headerValue(fields, 'x-msmail-priority'))
    ?? 'normal';
}

/** Importance of raw RFC 5322 octets (top-level header only). */
export function importanceOfRaw(raw: Buffer): Importance {
  const s = raw.subarray(0, Math.min(raw.length, MAX_HEADER_SCAN)).toString('latin1');
  return importanceOfFields(parseHeaderFields(s, 0, findBodyStart(s, 0, s.length)));
}

/** nodemailer `priority` option for a level (normal: none — no importance headers). */
export function importanceMailOption(level: Importance): { priority: 'high' | 'low' } | Record<string, never> {
  return level === 'normal' ? {} : { priority: level };
}

/**
 * 9.4: importance stored with a delivered message — an inbox rule's "set
 * importance" (mail-rules RuleOutcome.importance) replaces the value of the
 * headers; no rule (null): the header value. Normal is stored as null. The raw
 * message stays unchanged (like Outlook, the rule sets the message property).
 */
export function deliveredImportance(header: 'high' | 'low' | null | undefined, rule: Importance | null | undefined): 'high' | 'low' | null {
  if (rule === 'high' || rule === 'normal' || rule === 'low') return storedImportance(rule);
  return header === 'high' || header === 'low' ? header : null;
}
