/**
 * Which notifications a mailbox change produces for one logon of a session
 * (MS-OXCNOTIF 3.2.5.1): pure, unit-tested.
 *
 *  - A RopRegisterNotification subscription matches the whole store
 *    (WantWholeStore) or one folder (FolderId, MessageId 0); subscriptions on
 *    a single message get nothing (CoreMail reports no per-message changes).
 *  - NewMail for each message that appeared in a matching folder (the
 *    subscription asked for NewMail).
 *  - ObjectModified with the new total / unread counts for each changed
 *    folder whose counts differ (the subscription asked for ObjectModified).
 *  - TableChanged for every open table that shows the change (the caller
 *    passes only tables opened without NoNotifications): contents tables of a
 *    changed folder, every hierarchy table when the folder list or any
 *    folder's counts changed.
 * Folders are identified by their global counter, messages by their UID
 * (ids.ts); the encoded IDs carry replica ID 1.
 */
import type { MailboxChangeEvent } from '@coremail/core';
import { makeId } from '../../ids.js';
import { folderModifiedData, newMailData, NotificationType, tableChangedData } from './data.js';
import type { QueuedNotification } from './queue.js';
import type { NotificationSubscription, TableSource } from '../../objects/state.js';

export interface FolderFacts { counter: bigint; total: number; unread: number }

export interface NewMessageFact { folderCounter: bigint; uid: number; read: boolean }

export interface PlanInput {
  logonId: number;
  kinds: MailboxChangeEvent['kinds'];
  /** Folder counters the change concerns; null = any folder of the mailbox. */
  changedFolders: ReadonlySet<bigint> | null;
  before: ReadonlyMap<bigint, FolderFacts>;
  after: ReadonlyMap<bigint, FolderFacts>;
  newMessages: readonly NewMessageFact[];
  subscriptions: ReadonlyArray<{ handle: number; subscription: NotificationSubscription }>;
  tables: ReadonlyArray<{ handle: number; source: TableSource }>;
}

const MSGFLAG_READ = 0x0001;
const NEW_MAIL_CLASS = 'IPM.Note';

function covers(sub: NotificationSubscription, folderCounter: bigint): boolean {
  if (sub.wholeStore) return true;
  return sub.messageId === 0n && sub.folderId === makeId(folderCounter);
}

function countsChanged(before: FolderFacts | undefined, after: FolderFacts): boolean {
  return !before || before.total !== after.total || before.unread !== after.unread;
}

export function planNotifications(input: PlanInput): QueuedNotification[] {
  const out: QueuedNotification[] = [];
  const touched = [...input.after.values()].filter((f) => !input.changedFolders || input.changedFolders.has(f.counter));
  const recounted = touched.filter((f) => countsChanged(input.before.get(f.counter), f));
  const contentChange = input.kinds.includes('messages') || input.kinds.includes('flags');

  for (const { handle, subscription: sub } of input.subscriptions) {
    if (sub.notificationTypes & NotificationType.NewMail) {
      for (const m of input.newMessages) {
        if (!covers(sub, m.folderCounter)) continue;
        out.push({
          key: `${handle}:new:${m.folderCounter}:${m.uid}`, handle, logonId: input.logonId,
          data: newMailData(makeId(m.folderCounter), makeId(BigInt(m.uid)), m.read ? MSGFLAG_READ : 0, NEW_MAIL_CLASS),
        });
      }
    }
    if (sub.notificationTypes & NotificationType.ObjectModified) {
      for (const f of recounted) {
        if (!covers(sub, f.counter)) continue;
        out.push({
          key: `${handle}:folder:${f.counter}`, handle, logonId: input.logonId,
          data: folderModifiedData(makeId(f.counter), f.total, f.unread),
        });
      }
    }
  }

  const hierarchyChange = input.kinds.includes('folders') || recounted.length > 0;
  const touchedCounters = new Set(touched.map((f) => f.counter));
  for (const { handle, source } of input.tables) {
    const shows = source.kind === 'hierarchy'
      ? hierarchyChange
      : source.kind === 'contents' && !source.associated && contentChange && touchedCounters.has(source.folderCounter);
    if (shows) out.push({ key: `${handle}:table`, handle, logonId: input.logonId, data: tableChangedData() });
  }
  return out;
}
