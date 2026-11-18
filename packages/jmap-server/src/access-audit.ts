/**
 * Mailbox access audit for JMAP (9.4, storage mailbox-access-audit.ts): use of
 * a Shared Mailbox / delegated account (aggregated "open") and the writes of
 * Email/set and Mailbox/set in it. The user's own account is never audited.
 */
import type { MailboxAccessAction, MailboxAccessTarget } from '@coremail/storage';
import type { AccountContext, JmapUser, JsonObject } from './types.js';

/** Pure: the audit target of an account; null for the personal account. */
export function foreignTarget(acc: AccountContext): MailboxAccessTarget | null {
  if (acc.isPersonal) return null;
  return acc.sharedMailboxId
    ? { kind: 'shared', sharedMailboxId: acc.sharedMailboxId, mailboxId: acc.mailboxId, email: acc.email }
    : { kind: 'delegated', sharedMailboxId: null, mailboxId: acc.mailboxId, email: acc.email };
}

export interface AccessEvent { action: MailboxAccessAction; count: number }

const count = (v: unknown): number => (Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0);

/** Pure: audit events of an Email/set response (moves = updates that change mailboxIds). */
export function emailSetAccessEvents(update: Record<string, JsonObject>, response: JsonObject): AccessEvent[] {
  const updated = (response['updated'] ?? {}) as Record<string, unknown>;
  const moved = Object.keys(updated).filter((id) => Object.keys(update[id] ?? {}).some((k) => k === 'mailboxIds' || k.startsWith('mailboxIds/'))).length;
  const out: AccessEvent[] = [];
  if (moved > 0) out.push({ action: 'mailbox.foreign.message.move', count: moved });
  const destroyed = count(response['destroyed']);
  if (destroyed > 0) out.push({ action: 'mailbox.foreign.message.delete', count: destroyed });
  return out;
}

/** Pure: audit events of a Mailbox/set response. */
export function mailboxSetAccessEvents(response: JsonObject): AccessEvent[] {
  const pairs: Array<[MailboxAccessAction, number]> = [
    ['mailbox.foreign.folder.create', count(response['created'])],
    ['mailbox.foreign.folder.update', count(response['updated'])],
    ['mailbox.foreign.folder.delete', count(response['destroyed'])],
  ];
  return pairs.filter(([, n]) => n > 0).map(([action, n]) => ({ action, count: n }));
}

/**
 * Records events for a foreign account (fire-and-forget; recording never
 * throws). Storage is loaded on first use: the dispatcher does not open a
 * database client at import time.
 */
export function auditForeignAccess(user: JmapUser, acc: AccountContext, events: readonly AccessEvent[]): void {
  const target = foreignTarget(acc);
  if (!target || events.length === 0) return;
  void import('@coremail/storage').then(({ recordMailboxAccess }) => Promise.all(events.map((e) => recordMailboxAccess({
    actorId: user.userId, actorEmail: user.email, target, action: e.action, source: 'jmap',
    ...(e.action === 'mailbox.foreign.open' ? {} : { changes: { count: e.count } }),
  })))).catch(() => undefined);
}
