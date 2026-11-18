/**
 * IMAP IDLE push (9.4): which idling sessions does a mailbox change wake?
 *
 * Every message writer (SMTP delivery, other IMAP sessions, JMAP, ActiveSync,
 * webmail, restore, retention) publishes a `mailbox:changes` event through the
 * message store. A session idling on a folder of that mailbox re-reads its view
 * and reports the difference (EXISTS, EXPUNGE, FETCH FLAGS) — never a blind
 * "EXISTS + 1". When the event names the changed folders, sessions on other
 * folders of the mailbox stay asleep. Folder-list changes never wake IDLE
 * (RFC 9051 has no untagged response for them). Pure — unit-tested.
 *
 * A shared / delegated folder is watched by other users than the mailbox owner:
 * the folder was access-checked on SELECT and the sync re-checks the permission.
 */
import type { MailboxChangeEvent } from '@coremail/core';

export interface IdleCandidate {
  idleActive: boolean;
  /** Mailbox and folder the session has selected (null when none). */
  selected: { mailboxId: string; folderId: string } | null;
}

/**
 * Queues one re-read of an idling session's view, unless one is already
 * waiting to start — it reads the database when it runs, so it covers this
 * wake-up too. A burst of changes (bulk move, retention run, many deliveries)
 * therefore costs at most one running and one waiting re-read per session.
 * Returns whether a re-read was queued.
 */
export function queueIdleSync(
  state: { idleSyncQueued?: boolean },
  enqueue: (run: () => Promise<void>) => void,
  sync: () => Promise<void>,
): boolean {
  if (state.idleSyncQueued) return false;
  state.idleSyncQueued = true;
  enqueue(() => {
    state.idleSyncQueued = false;
    return sync();
  });
  return true;
}

/** True when `change` concerns what the idling session shows. */
export function idleWakes(change: MailboxChangeEvent, session: IdleCandidate): boolean {
  if (!session.idleActive || !session.selected) return false;
  if (session.selected.mailboxId !== change.mailboxId) return false;
  if (!change.kinds.some((k) => k === 'messages' || k === 'flags')) return false;
  return !change.folderIds || change.folderIds.includes(session.selected.folderId);
}
