/**
 * 9.4: deep links. The address bar holds what the mail view shows —
 * `/mail/<mailbox>/<folderId>/<messageId>` with <mailbox> = own | shared:<id> |
 * delegated:<id> — so back/forward work and a link can be shared (it opens for
 * anyone with access to that mailbox; access is checked by the API as always).
 * Calendar items: `/calendar/event/<id>`, contacts: `/contacts/<id>`.
 * No imports besides mailboxContext — unit-tested with `node --test`.
 */
import { OWN_MAILBOX, mailboxKey, parseMailboxKey, type MailboxRef } from './mailboxContext.ts';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface MailLocation {
  mailbox: MailboxRef;
  folderId: string | null;
  messageId: string | null;
}

export function mailPath(mailbox: MailboxRef, folderId?: string | null, messageId?: string | null): string {
  if (!folderId) return mailbox.kind === 'own' ? '/mail' : `/mail/${encodeURIComponent(mailboxKey(mailbox))}`;
  const base = `/mail/${encodeURIComponent(mailboxKey(mailbox))}/${encodeURIComponent(folderId)}`;
  return messageId ? `${base}/${encodeURIComponent(messageId)}` : base;
}

function segment(s: string | undefined): string | null {
  if (!s) return null;
  let v: string;
  try { v = decodeURIComponent(s); } catch { return null; }
  return ID_RE.test(v) ? v : null;
}

/** Parses a /mail… path; null for other paths. Invalid parts are dropped. */
export function parseMailPath(pathname: string): MailLocation | null {
  const parts = pathname.replace(/\/+$/, '').split('/').slice(1);
  if (parts[0] !== 'mail') return null;
  let key = 'own';
  try { key = decodeURIComponent(parts[1] ?? 'own'); } catch { /* invalid → own */ }
  const mailbox = key === 'own' ? OWN_MAILBOX : parseMailboxKey(key);
  const folderId = segment(parts[2]);
  return { mailbox, folderId, messageId: folderId ? segment(parts[3]) : null };
}

/**
 * Query parameters of the older link forms: `?mailbox=` (pre-9.4) and
 * `?folder=…&message=…` (Web Push notification clicks, built by the gateway's
 * lib/mail-notification.ts). The view → URL step drops them.
 */
export const LEGACY_MAIL_PARAMS = ['mailbox', 'folder', 'message'] as const;

function idParam(v: string | null): string | null {
  return v && ID_RE.test(v) ? v : null;
}

/**
 * What a /mail… URL asks to show (path form first; the legacy parameters only
 * complete a folder-less path). Null for other paths; invalid ids are dropped.
 */
export function mailLocationFromUrl(pathname: string, search: string): MailLocation | null {
  const parsed = parseMailPath(pathname);
  if (!parsed || parsed.folderId) return parsed;
  const q = new URLSearchParams(search);
  const legacy = q.get('mailbox');
  const mailbox = legacy ? parseMailboxKey(legacy) : parsed.mailbox;
  const folderId = idParam(q.get('folder'));
  return { mailbox, folderId, messageId: folderId ? idParam(q.get('message')) : null };
}

/** True when the search part still holds one of the legacy parameters. */
export function hasLegacyMailParams(search: string): boolean {
  const q = new URLSearchParams(search);
  return LEGACY_MAIL_PARAMS.some((p) => q.has(p));
}

/** Search part without the legacy parameters (other parameters, e.g. ?q=, stay). */
export function searchWithoutLegacyMailParams(search: string): string {
  const q = new URLSearchParams(search);
  for (const p of LEGACY_MAIL_PARAMS) q.delete(p);
  const s = q.toString();
  return s ? `?${s}` : '';
}

export function sameMailLocation(a: MailLocation, b: MailLocation): boolean {
  return mailboxKey(a.mailbox) === mailboxKey(b.mailbox) && a.folderId === b.folderId && a.messageId === b.messageId;
}

export function calendarEventPath(id: string): string {
  return `/calendar/event/${encodeURIComponent(id)}`;
}

/** 9.4: one occurrence of a series (`occurrence` = its original start, ISO). */
export function calendarOccurrencePath(id: string, occurrence: string): string {
  return `${calendarEventPath(id)}?occurrence=${encodeURIComponent(occurrence)}`;
}

/** The `occurrence` of a calendar event link (location.search), null when absent or invalid. */
export function occurrenceFromSearch(search: string): string | null {
  const v = new URLSearchParams(search).get('occurrence');
  return v && !isNaN(new Date(v).getTime()) ? v : null;
}

export function contactPath(id: string): string {
  return `/contacts/${encodeURIComponent(id)}`;
}

/** Id from /calendar/event/<id> or /contacts/<id> (after the given prefix), else null. */
export function itemIdFromPath(pathname: string, prefix: '/calendar/event/' | '/contacts/'): string | null {
  if (!pathname.startsWith(prefix)) return null;
  return segment(pathname.slice(prefix.length).split('/')[0]);
}
