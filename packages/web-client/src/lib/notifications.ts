/**
 * 10.7: the notifications panel of the rail bell — the realtime notifications
 * this tab received in this session (new mail with sender / subject, task and
 * event reminders, calendar shares). Nothing is stored: a reload starts empty.
 * The newest entry comes first; the list is bounded. Pure — unit-tested with
 * `node --test`.
 */
import { mailPath } from './mailLinks.ts';
import { parseMailboxKey } from './mailboxContext.ts';

export type NotificationKind = 'mail' | 'reminder' | 'calendar';

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  /** Main line (sender, reminder subject, …). */
  title: string;
  /** Second line (mail subject), may be empty. */
  detail: string;
  /** Epoch ms of arrival. */
  at: number;
  /** In-app path a click opens (the mail, the calendar), or null. */
  href: string | null;
  read: boolean;
}

/** Most entries kept per session. */
export const MAX_NOTIFICATIONS = 50;

/** Adds an entry on top (an id that is already listed is not added twice). */
export function addNotification(list: readonly AppNotification[], entry: AppNotification): AppNotification[] {
  if (list.some((n) => n.id === entry.id)) return [...list];
  return [entry, ...list].slice(0, MAX_NOTIFICATIONS);
}

export function unreadCount(list: readonly AppNotification[]): number {
  return list.filter((n) => !n.read).length;
}

export function markAllRead(list: readonly AppNotification[]): AppNotification[] {
  return list.map((n) => (n.read ? n : { ...n, read: true }));
}

type Obj = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Entry of a `mail:new` realtime event (payload of the gateway's SSE hub: mailbox,
 * folderId, messageId, subject, fromName, fromAddr). The link opens the message
 * in its mailbox; without ids it opens the mail view. Junk mail is not listed.
 */
export function mailNotification(data: unknown, now: number, labels: { unknownSender: string; noSubject: string }): AppNotification | null {
  const d: Obj = data && typeof data === 'object' && !Array.isArray(data) ? data as Obj : {};
  if (d['isJunk'] === true) return null;
  const messageId = str(d['messageId']);
  const folderId = str(d['folderId']);
  const href = folderId ? mailPath(parseMailboxKey(str(d['mailbox']) || 'own'), folderId, messageId || null) : '/mail';
  return {
    id: messageId ? `mail:${messageId}` : `mail:${now}:${str(d['subject'])}`,
    kind: 'mail',
    title: str(d['fromName']) || str(d['fromAddr']) || labels.unknownSender,
    detail: str(d['subject']) || labels.noSubject,
    at: now,
    href,
    read: false,
  };
}

/** Page a reminder leads to: events → calendar, flagged mails → mail, tasks → tasks (lib/reminderSources.ts ids). */
export function reminderHref(itemId: string): string {
  if (itemId.startsWith('event:')) return '/calendar';
  if (itemId.startsWith('mail:')) return '/mail';
  return '/tasks';
}

/** Entry of a task / event reminder (useTaskReminders) or another hint (calendar share). */
export function hintNotification(kind: Exclude<NotificationKind, 'mail'>, key: string, title: string, now: number, href: string | null): AppNotification {
  return { id: `${kind}:${key}`, kind, title, detail: '', at: now, href, read: false };
}
