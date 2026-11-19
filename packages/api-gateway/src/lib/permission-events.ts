/**
 * 9.1: mailbox permission changes (Shared Mailbox permissions, the `active` flag
 * of a shared mailbox, delegations — w3: folder permissions) are published on
 * the auth invalidation bus as `permission-change` for every affected grantee,
 * plus the realtime user event `settings` / `mailboxes` (webmail folder pane).
 * The implementation lives in @coremail/storage permission-events.ts (shared
 * with the IMAP server's SETACL); see there. Never throws.
 */
import { prisma, publishMailboxPermissionChange, MAILBOX_GRANT_EVENT } from '@coremail/storage';
import { createLogger } from '@coremail/core';

const log = createLogger('api-gateway:permission-events');

export { MAILBOX_GRANT_EVENT };

/** Publishes `permission-change` and the grant realtime event for each distinct user id. */
export async function publishPermissionChange(userIds: Iterable<string>): Promise<void> {
  await publishMailboxPermissionChange(userIds);
}

/** Every user holding any permission on the shared mailbox. */
export async function sharedMailboxGrantees(sharedMailboxId: string): Promise<string[]> {
  try {
    const rows = await prisma.sharedMailboxPerm.findMany({ where: { sharedMailboxId }, select: { userId: true } });
    return [...new Set(rows.map((r) => r.userId))];
  } catch (err) {
    log.warn({ err, sharedMailboxId }, 'shared mailbox grantees not loaded');
    return [];
  }
}
