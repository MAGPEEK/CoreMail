/**
 * Change bus of the MAPI server: Redis `mailbox:changes` (every message and
 * folder writer publishes it, docs/realtime.md) → the mailbox sessions that
 * have a logon on that mailbox → planned notifications (planner.ts) on the
 * session's queue, which wakes a waiting NotificationWait.
 *
 * Per logon with a notification subscription or an open notifying table, a
 * change re-reads the folder list (new counts) and, for NewMail, the messages
 * that appeared since the last announcement (by the mailbox modSeq). Changes
 * are handled one after the other per session. Tables that get a
 * TableChanged drop their row snapshot, so the client's re-read is current.
 * Sessions ended by a credential change or the protocol switch are gone from
 * the registry and get nothing.
 */
import { CHANNEL_MAILBOX_CHANGES, createLogger, getRedisClient, parseMailboxChange, type MailboxChangeEvent } from '@coremail/core';
import { refreshView } from '../../rop/ops/common.js';
import { NotificationType } from './data.js';
import { planNotifications, type FolderFacts, type NewMessageFact } from './planner.js';
import { messageCounter } from '../../ics/keys.js';
import type { MailboxView } from '../../objects/mailbox-view.js';
import type { LogonState, NotificationSubscription, TableSource, TableState } from '../../objects/state.js';
import type { MapiSession } from '../../session/session.js';
import type { SessionRegistry } from '../../session/registry.js';
import type { MailStore } from '../../store/types.js';

const log = createLogger('mapi:notify');

/** NewMail notifications per change and logon (a bulk import must not flood the client). */
export const MAX_NEW_MAIL_PER_CHANGE = 50;

export interface NotifyBusDeps {
  sessions: SessionRegistry;
  store: MailStore;
}

const chains = new WeakMap<MapiSession, Promise<void>>();

function folderFacts(view: MailboxView): Map<bigint, FolderFacts> {
  const out = new Map<bigint, FolderFacts>();
  for (const node of view.descendants(view.special('root').counter)) {
    const r = node.node.record;
    if (r) out.set(node.node.counter, { counter: node.node.counter, total: r.totalCount, unread: r.unreadCount });
  }
  return out;
}

interface LogonTargets {
  subscriptions: Array<{ handle: number; subscription: NotificationSubscription }>;
  tables: Array<{ handle: number; source: TableSource; table: TableState }>;
}

function targetsOf(session: MapiSession, logon: LogonState): LogonTargets {
  const out: LogonTargets = { subscriptions: [], tables: [] };
  for (const { handle, object } of session.objects.withHandles()) {
    if (object.kind === 'notification' && object.logon === logon) out.subscriptions.push({ handle, subscription: object.subscription });
    if (object.kind === 'table' && object.logon === logon && object.table.notify && object.table.source.kind !== 'attachments') {
      out.tables.push({ handle, source: object.table.source, table: object.table });
    }
  }
  return out;
}

/** Messages that appeared since the last announcement (folders that can receive mail). */
async function newMessages(store: MailStore, logon: LogonState, view: MailboxView, change: MailboxChangeEvent): Promise<NewMessageFact[]> {
  if (logon.notifiedModSeq === null) return [];
  const excluded = new Set([view.role('sent')?.counter, view.role('drafts')?.counter]);
  const folderIds = (change.folderIds ?? [...folderFacts(view).keys()].map((c) => view.get(c)!.record!.id))
    .filter((id) => { const node = view.ofRecord(id); return node !== undefined && !excluded.has(node.counter); });
  const rows = await store.messagesCreatedSince(folderIds, logon.notifiedModSeq, MAX_NEW_MAIL_PER_CHANGE);
  const last = rows.at(-1)?.createdModSeq ?? logon.notifiedModSeq;
  const announced = change.modSeq !== undefined && rows.length < MAX_NEW_MAIL_PER_CHANGE ? BigInt(change.modSeq) : last;
  logon.notifiedModSeq = announced > logon.notifiedModSeq ? announced : logon.notifiedModSeq;
  return rows.map((r) => ({ folderCounter: view.ofRecord(r.folderId)!.counter, counter: messageCounter(r), read: r.read }));
}

async function notifyLogon(session: MapiSession, logon: LogonState, change: MailboxChangeEvent, store: MailStore): Promise<void> {
  const targets = targetsOf(session, logon);
  if (targets.subscriptions.length === 0 && targets.tables.length === 0) return;
  const before = folderFacts(logon.view);
  const view = await refreshView(store, logon);
  const wantsNewMail = targets.subscriptions.some((s) => s.subscription.notificationTypes & NotificationType.NewMail);
  const arrived = change.kinds.includes('messages') && wantsNewMail ? await newMessages(store, logon, view, change) : [];
  const changedFolders = change.folderIds
    ? new Set(change.folderIds.map((id) => view.ofRecord(id)?.counter).filter((c): c is bigint => c !== undefined))
    : null;
  const planned = planNotifications({
    logonId: logon.logonId, kinds: change.kinds, changedFolders, before, after: folderFacts(view),
    newMessages: arrived, subscriptions: targets.subscriptions, tables: targets.tables,
  });
  const changedTables = new Set(planned.filter((n) => n.key.endsWith(':table')).map((n) => n.handle));
  for (const t of targets.tables) if (changedTables.has(t.handle)) t.table.rows = null;
  if (!session.closed) session.notifications.push(planned);
}

/** Routes one change to every mailbox session with a logon on that mailbox. Returns the sessions notified. */
export async function dispatchMailboxChange(change: MailboxChangeEvent, deps: NotifyBusDeps): Promise<number> {
  const runs: Array<Promise<void>> = [];
  for (const session of deps.sessions.sessionsOf('emsmdb')) {
    const logons = [...session.logons.values()].filter((l) => l.mailbox.mailboxId === change.mailboxId);
    if (logons.length === 0) continue;
    const run = (chains.get(session) ?? Promise.resolve()).then(async () => {
      for (const logon of logons) await notifyLogon(session, logon, change, deps.store);
    }).catch((err: unknown) => log.warn({ err, userId: session.user.userId }, 'MAPI notifications not built'));
    chains.set(session, run);
    runs.push(run);
  }
  await Promise.all(runs);
  return runs.length;
}

/** Subscribes to `mailbox:changes` (a duplicated Redis connection). */
export function startNotificationBus(deps: NotifyBusDeps): void {
  const sub = getRedisClient().duplicate();
  void sub.subscribe(CHANNEL_MAILBOX_CHANGES).catch((err: unknown) => {
    log.error({ err }, 'MAPI notification bus subscription failed — NotificationWait only ends by its timer');
  });
  sub.on('message', (channel: string, message: string) => {
    if (channel !== CHANNEL_MAILBOX_CHANGES) return;
    const change = parseMailboxChange(message);
    if (!change) { log.warn('Malformed mailbox change ignored'); return; }
    void dispatchMailboxChange(change, deps);
  });
  log.info('MAPI notification bus started (mailbox:changes)');
}
