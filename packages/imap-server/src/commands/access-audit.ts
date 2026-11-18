/**
 * Mailbox access audit for IMAP (9.4, storage mailbox-access-audit.ts):
 * SELECT / EXAMINE of a Shared Mailbox or delegated mailbox (aggregated
 * "open"), EXPUNGE / MOVE out of it and folder CREATE / RENAME / DELETE in it.
 * The user's own mailbox is never audited. Fire-and-forget, never throws.
 */
import { recordMailboxAccess, type AccessibleMailbox, type MailboxAccessAction, type MailboxAccessTarget } from '@coremail/storage';
import type { ImapSession } from '../session/state.js';

/** Pure: the audit target of a foreign mailbox. */
export function accessTarget(access: AccessibleMailbox): MailboxAccessTarget {
  return { kind: access.kind, sharedMailboxId: access.sharedMailboxId, mailboxId: access.mailboxId, email: access.email };
}

/** The (cached) permission entry of the selected foreign mailbox; null for the own mailbox. */
export function selectedAccess(session: ImapSession): AccessibleMailbox | null {
  const view = session.selected;
  if (!view?.foreign) return null;
  return session.foreignAccess?.list.find((a) => a.mailboxId === view.mailboxId && a.kind === view.foreign!.kind) ?? null;
}

/** Records an event in a foreign mailbox (`access` null = own mailbox → nothing). */
export function auditImapAccess(
  session: ImapSession,
  access: AccessibleMailbox | null | undefined,
  action: MailboxAccessAction,
  changes?: Record<string, unknown>,
): void {
  if (!access || !session.userId) return;
  void recordMailboxAccess({
    actorId: session.userId,
    ...(session.userEmail ? { actorEmail: session.userEmail } : {}),
    target: accessTarget(access),
    action,
    source: 'imap',
    ...(changes ? { changes } : {}),
  });
}
