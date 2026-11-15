/**
 * Access checks for mailboxes other than the caller's own (Shared Mailboxes and
 * delegated user mailboxes). One implementation for every REST route that acts
 * on such a mailbox (folders/messages in routes/user.ts, recover deleted items,
 * quota):
 *
 *  - getReadableSharedMailbox  FULL_ACCESS or READ_ONLY on an ACTIVE shared mailbox
 *  - getWritableSharedMailbox  FULL_ACCESS on an ACTIVE shared mailbox
 *  - getFullAccessDelegatedMailbox  FULL_ACCESS delegation (MailboxDelegate) on a user mailbox
 *
 * Each returns null when the caller lacks the right (or the mailbox does not
 * exist) — callers answer 403/404 without telling the two apart.
 */
import { prisma } from '@coremail/storage';

export interface SharedMailboxAccess {
  mailboxId: string;
  shared: { id: string; email: string; displayName: string; active: boolean };
  permission: string;
}

/** Read access (FULL_ACCESS or READ_ONLY) to an active shared mailbox. */
export async function getReadableSharedMailbox(userId: string, sharedMailboxId: string): Promise<SharedMailboxAccess | null> {
  const perm = await prisma.sharedMailboxPerm.findFirst({
    where: {
      userId,
      sharedMailboxId,
      permission: { in: ['FULL_ACCESS', 'READ_ONLY'] },
    },
    include: {
      sharedMailbox: {
        select: { id: true, email: true, displayName: true, active: true },
      },
    },
  });
  if (!perm || !perm.sharedMailbox.active) return null;
  // The mailbox table is 1:1 with SharedMailbox via sharedBoxId
  const mailbox = await prisma.mailbox.findFirst({
    where: { sharedBoxId: sharedMailboxId },
    select: { id: true },
  });
  if (!mailbox) return null;
  return { mailboxId: mailbox.id, shared: perm.sharedMailbox, permission: perm.permission };
}

/** FULL_ACCESS to an active shared mailbox (write operations). */
export async function getWritableSharedMailbox(userId: string, sharedMailboxId: string): Promise<{ mailboxId: string } | null> {
  const perm = await prisma.sharedMailboxPerm.findFirst({
    where: { userId, sharedMailboxId, permission: 'FULL_ACCESS' },
    include: { sharedMailbox: { select: { id: true, active: true } } },
  });
  if (!perm || !perm.sharedMailbox.active) return null;
  const mailbox = await prisma.mailbox.findFirst({
    where: { sharedBoxId: sharedMailboxId }, select: { id: true },
  });
  if (!mailbox) return null;
  return { mailboxId: mailbox.id };
}

/** FULL_ACCESS delegation on a user mailbox (`mailboxId` = Mailbox.id, as listed by GET /mail/delegated-mailboxes). */
export async function getFullAccessDelegatedMailbox(userId: string, mailboxId: string): Promise<{ mailboxId: string } | null> {
  const d = await prisma.mailboxDelegate.findFirst({
    where: { granteeId: userId, mailboxId, permission: 'FULL_ACCESS' },
    select: { mailboxId: true },
  });
  return d ? { mailboxId: d.mailboxId } : null;
}
