/**
 * 9.1: mailbox permission changes (Shared Mailbox permissions, the `active` flag
 * of a shared mailbox, delegations) are published on the auth invalidation bus
 * as `permission-change` for every affected grantee. The IMAP server drops its
 * cached shared-mailbox access lists and re-checks a selected foreign mailbox at
 * once ([CLOSED] for a revoked one); JMAP Basic-auth caches and other per-user
 * caches are flushed. `permission-change` never ends a live connection
 * (core live-connections.ts: neutral reason). Never throws.
 *
 * 9.4 review: every grantee also gets the realtime user event
 * `settings` / `mailboxes`, so an open webmail refreshes its folder pane at once
 * (a new or removed mailbox, a changed auto-mapping or permission).
 */
import { prisma, announceUserEvent } from '@coremail/storage';
import { publishUserAuthChange } from '@coremail/storage/auth';
import { createLogger, type UserEvent } from '@coremail/core';

const log = createLogger('api-gateway:permission-events');

/** The realtime event of a mailbox grant change (webmail: accessible mailboxes + folder pane). */
export const MAILBOX_GRANT_EVENT: Readonly<UserEvent> = Object.freeze({ type: 'settings', section: 'mailboxes', action: 'update' });

/** Publishes `permission-change` and the grant realtime event for each distinct user id. */
export async function publishPermissionChange(userIds: Iterable<string>): Promise<void> {
  const ids = [...new Set([...userIds].filter((id) => typeof id === 'string' && id.length > 0))];
  if (ids.length > 0) announceUserEvent(ids, { ...MAILBOX_GRANT_EVENT });
  await Promise.all(ids.map((id) => publishUserAuthChange(id, 'permission-change').catch((err: unknown) => {
    log.warn({ err, userId: id }, 'permission-change event not published (caches expire by TTL)');
  })));
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
