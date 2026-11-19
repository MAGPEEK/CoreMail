/**
 * Mailbox and folder permission changes on the event buses (9.1, w3).
 *
 * Every grantee whose access changed gets `permission-change` on the auth
 * invalidation bus: the IMAP server drops its cached access lists and re-checks
 * a selected foreign folder at once (`* OK [CLOSED]` when the right to read it
 * is gone); JMAP and the SSE hub flush their per-user caches.
 * `permission-change` never ends a live connection by itself (core
 * live-connections.ts: neutral reason). Each grantee also gets the realtime user
 * event `settings` / `mailboxes`, so an open webmail refreshes its folder pane.
 *
 * Never throws: caches fall back to their TTL when the buses are unavailable.
 */
import { createLogger, type UserEvent } from '@coremail/core';
import { publishUserAuthChange } from './auth/invalidation.js';
import { announceUserEvent } from './realtime/announce.js';
import { DEFAULT_GRANTEE_KEY, granteeUserId } from './folder-permissions.js';
import type { FolderPermissionChange } from './folder-access.js';

const log = createLogger('storage:permission-events');

/** The realtime event of a mailbox grant change (webmail: accessible mailboxes + folder pane). */
export const MAILBOX_GRANT_EVENT: Readonly<UserEvent> = Object.freeze({ type: 'settings', section: 'mailboxes', action: 'update' });

/** Publishes `permission-change` and the grant realtime event for each distinct user id. */
export async function publishMailboxPermissionChange(userIds: Iterable<string>): Promise<void> {
  const ids = [...new Set([...userIds].filter((id) => typeof id === 'string' && id.length > 0))];
  if (ids.length > 0) announceUserEvent(ids, { ...MAILBOX_GRANT_EVENT });
  await Promise.all(ids.map((id) => publishUserAuthChange(id, 'permission-change').catch((err: unknown) => {
    log.warn({ err, userId: id }, 'permission-change event not published (caches expire by TTL)');
  })));
}

/**
 * Pure: who must hear about folder permission changes — every user grantee,
 * and for a change of Default (everyone) `fallbackUserId`: one event is enough
 * there, because the IMAP server and the SSE hub drop every user's cached
 * access on any `permission-change` (the other webmail sessions refresh their
 * folder pane on their safety refresh).
 */
export function folderPermissionAudience(changes: readonly FolderPermissionChange[], fallbackUserId: string): string[] {
  const ids = new Set<string>();
  for (const c of changes) {
    const userId = granteeUserId(c.granteeKey);
    if (userId) ids.add(userId);
    else if (c.granteeKey === DEFAULT_GRANTEE_KEY) ids.add(fallbackUserId);
  }
  return [...ids];
}

/** Publishes the changes of setFolderPermissions(). */
export async function publishFolderPermissionChange(changes: readonly FolderPermissionChange[], fallbackUserId: string): Promise<void> {
  if (changes.length === 0) return;
  await publishMailboxPermissionChange(folderPermissionAudience(changes, fallbackUserId));
}
