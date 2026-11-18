/**
 * Access checks for mailboxes other than the caller's own (Shared Mailboxes and
 * delegated user mailboxes). One implementation for every REST route that acts
 * on such a mailbox (folders/messages in routes/user.ts, recover deleted items,
 * quota):
 *
 *  - getReadableSharedMailbox  FULL_ACCESS or READ_ONLY on an ACTIVE shared mailbox
 *  - getWritableSharedMailbox  FULL_ACCESS on an ACTIVE shared mailbox
 *  - getFullAccessDelegatedMailbox  FULL_ACCESS delegation (MailboxDelegate) on the
 *    mailbox of an existing, ACTIVE user other than the caller
 *
 * 9.1: all three resolve through `listAccessibleMailboxes()` from @coremail/storage —
 * the same rule IMAP (Shared/ + Other Users/ namespaces), JMAP account resolution and
 * the web attachment download use. A delegation on a deactivated owner, on a mailbox
 * without a user, or on the caller's own mailbox grants nothing.
 *
 * Each returns null when the caller lacks the right (or the mailbox does not
 * exist) — callers answer 403/404 without telling the two apart.
 */
import { prisma, listAccessibleMailboxes, accessibleMailboxRef, type AccessibleMailbox, type MailboxAccessDb } from '@coremail/storage';

export interface SharedMailboxAccess {
  mailboxId: string;
  shared: { id: string; email: string; displayName: string; active: boolean };
  permission: string;
}

async function accessible(userId: string): Promise<AccessibleMailbox[]> {
  return listAccessibleMailboxes(prisma as unknown as MailboxAccessDb, userId);
}

/** Read access (FULL_ACCESS or READ_ONLY) to an active shared mailbox. */
export async function getReadableSharedMailbox(userId: string, sharedMailboxId: string): Promise<SharedMailboxAccess | null> {
  if (!sharedMailboxId) return null;
  const entry = (await accessible(userId)).find((a) => a.kind === 'shared' && a.sharedMailboxId === sharedMailboxId);
  if (!entry) return null;
  return {
    mailboxId: entry.mailboxId,
    shared: { id: sharedMailboxId, email: entry.email, displayName: entry.displayName, active: true },
    permission: entry.readOnly ? 'READ_ONLY' : 'FULL_ACCESS',
  };
}

/** FULL_ACCESS to an active shared mailbox (write operations). */
export async function getWritableSharedMailbox(userId: string, sharedMailboxId: string): Promise<{ mailboxId: string } | null> {
  if (!sharedMailboxId) return null;
  const entry = (await accessible(userId)).find((a) => a.kind === 'shared' && a.sharedMailboxId === sharedMailboxId && !a.readOnly);
  return entry ? { mailboxId: entry.mailboxId } : null;
}

/**
 * 9.3: one foreign mailbox by its webmail reference — `kind` 'shared' with the
 * SharedMailbox id, or 'delegated' with the Mailbox id (GET /mail/delegated-mailboxes
 * → mailboxId). Read access (FULL_ACCESS or READ_ONLY); `readOnly` tells callers
 * whether write operations are allowed. null when the caller has no access.
 */
export async function getForeignMailbox(userId: string, kind: 'shared' | 'delegated', id: string): Promise<AccessibleMailbox | null> {
  if (!id) return null;
  return (await accessible(userId)).find((a) =>
    a.kind === kind && (kind === 'shared' ? a.sharedMailboxId === id : a.mailboxId === id)) ?? null;
}

/** Every foreign mailbox the caller may read (9.3 webmail folder pane). */
export async function listForeignMailboxes(userId: string): Promise<AccessibleMailbox[]> {
  return accessible(userId);
}

/** Webmail reference of a foreign mailbox: "shared:<sharedMailboxId>" | "delegated:<mailboxId>". */
export function foreignMailboxRef(a: AccessibleMailbox): string {
  return accessibleMailboxRef(a);
}

/**
 * FULL_ACCESS delegation on a user mailbox (`mailboxId` = Mailbox.id, as listed by
 * GET /mail/delegated-mailboxes). The owner must exist, be active and not be the caller.
 */
export async function getFullAccessDelegatedMailbox(userId: string, mailboxId: string): Promise<{ mailboxId: string } | null> {
  if (!mailboxId) return null;
  const entry = (await accessible(userId)).find((a) => a.kind === 'delegated' && a.mailboxId === mailboxId && !a.readOnly);
  return entry ? { mailboxId: entry.mailboxId } : null;
}
