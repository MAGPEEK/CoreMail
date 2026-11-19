/**
 * Access to shared and delegated mailboxes in open MAPI sessions (9.5 review):
 * a revoked Shared Mailbox permission or delegation — the admin API publishes
 * `permission-change` for the grantee — or a deactivated / deleted owner ends
 * the session's logon to that mailbox at once: its objects (folders, tables,
 * messages, synchronization contexts) are released and its notifications
 * dropped, so the next ROP on them fails and no further change of the mailbox
 * reaches the session. A permission that became read-only applies to the
 * next write. When the access cannot be read the logon ends as well (it can
 * log on again).
 */
import { createLogger, onAuthInvalidation, type AuthInvalidationEvent } from '@coremail/core';
import type { MapiSession } from './session.js';
import type { SessionRegistry } from './registry.js';
import type { MailStore } from '../store/types.js';

const log = createLogger('mapi:foreign-access');

/** Re-checks every shared / delegated logon of a session; returns the logons ended. */
export async function revalidateForeignLogons(session: MapiSession, store: MailStore): Promise<number> {
  let ended = 0;
  for (const logon of [...session.logons.values()]) {
    if (logon.mailbox.kind === 'own') continue;
    const current = await store.foreignAccess(session.user, logon.mailbox).catch((err: unknown) => {
      log.warn({ err, userId: session.user.userId }, 'Mailbox access not readable — the logon ends');
      return null;
    });
    if (!current) {
      session.dropLogon(logon.logonId);
      ended++;
      log.info({ userId: session.user.userId, mailboxId: logon.mailbox.mailboxId }, 'MAPI logon ended: mailbox access revoked');
    } else if (current.readOnly !== logon.mailbox.readOnly) {
      logon.mailbox = { ...logon.mailbox, readOnly: current.readOnly };
    }
  }
  return ended;
}

/** The sessions an event of `userId` concerns: the user's own, and logons to that user's mailbox. */
export function sessionsConcerned(sessions: readonly MapiSession[], userId: string): MapiSession[] {
  return sessions.filter((s) => s.user.userId === userId
    || [...s.logons.values()].some((l) => l.mailbox.kind !== 'own' && l.mailbox.directoryId === userId));
}

export async function applyForeignAccessChange(event: AuthInvalidationEvent, deps: { sessions: SessionRegistry; store: MailStore }): Promise<number> {
  let ended = 0;
  for (const session of sessionsConcerned(deps.sessions.sessionsOf('emsmdb'), event.userId)) {
    ended += await revalidateForeignLogons(session, deps.store);
  }
  return ended;
}

/** Subscribes to the auth invalidation bus (local and remote events). Returns an unregister function. */
export function startForeignAccessWatcher(deps: { sessions: SessionRegistry; store: MailStore }): () => void {
  return onAuthInvalidation((event) => { void applyForeignAccessChange(event, deps); });
}
