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

export function sameMailLocation(a: MailLocation, b: MailLocation): boolean {
  return mailboxKey(a.mailbox) === mailboxKey(b.mailbox) && a.folderId === b.folderId && a.messageId === b.messageId;
}

export function calendarEventPath(id: string): string {
  return `/calendar/event/${encodeURIComponent(id)}`;
}

export function contactPath(id: string): string {
  return `/contacts/${encodeURIComponent(id)}`;
}

/** Id from /calendar/event/<id> or /contacts/<id> (after the given prefix), else null. */
export function itemIdFromPath(pathname: string, prefix: '/calendar/event/' | '/contacts/'): string | null {
  if (!pathname.startsWith(prefix)) return null;
  return segment(pathname.slice(prefix.length).split('/')[0]);
}
