/**
 * Web Push payload of a new-mail notification (9.4) — pure, unit-tested.
 *
 * Without the per-device preview opt-in (PushSubscription.showPreview) the
 * notification is generic: product name + "Neue Nachricht", no sender, no
 * subject (lock screens). The click target is a webmail deep link to the
 * message when folder and message are known, else /mail. Junk is not announced.
 */
import type { PushPayload } from './push.js';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAILBOX_RE = /^(?:own|shared:[A-Za-z0-9_-]{1,64}|delegated:[A-Za-z0-9_-]{1,64})$/;
const MAX_TEXT = 120;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const clip = (s: string): string => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);

/** Webmail URL that opens the message (or the mail view). */
export function mailDeepLink(payload: Record<string, unknown>): string {
  const folderId = str(payload['folderId']);
  const messageId = str(payload['messageId']);
  if (!ID_RE.test(folderId) || !ID_RE.test(messageId)) return '/mail';
  const params = new URLSearchParams();
  const mailbox = str(payload['mailbox']);
  if (MAILBOX_RE.test(mailbox) && mailbox !== 'own') params.set('mailbox', mailbox);
  params.set('folder', folderId);
  params.set('message', messageId);
  return `/mail?${params.toString()}`;
}

/** Should a mail:new event become a notification at all? */
export function isNotifiable(payload: Record<string, unknown>): boolean {
  return payload['isJunk'] !== true;
}

/** Notification for one device: with or without sender/subject. */
export function mailNotification(
  payload: Record<string, unknown>,
  opts: { preview: boolean; productName: string },
): PushPayload {
  const messageId = str(payload['messageId']);
  const base = {
    tag: `mail-${ID_RE.test(messageId) ? messageId : 'new'}`,
    url: mailDeepLink(payload),
    data: { kind: 'mail.new' },
  };
  if (!opts.preview) return { ...base, title: opts.productName, body: 'Neue Nachricht' };
  const from = str(payload['fromName']).trim() || str(payload['fromAddr']).trim() || 'Unbekannter Absender';
  const subject = str(payload['subject']).trim() || '(Kein Betreff)';
  return { ...base, title: clip(from), body: clip(subject) };
}
