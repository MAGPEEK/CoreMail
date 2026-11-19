/** Helpers shared by the ROP handlers. */
import { Ec, RopError } from '../codes.js';
import { globcntOf, replidOf, REPLID } from '../../ids.js';
import { MailboxView, type FolderNode } from '../../objects/mailbox-view.js';
import { messageCounter } from '../../ics/keys.js';
import type { LogonState } from '../../objects/state.js';
import type { MailStore, MessageSummary } from '../../store/types.js';

/** Reloads the folder tree of a logon (counts, new or deleted folders). */
export async function refreshView(store: MailStore, logon: LogonState): Promise<MailboxView> {
  logon.view = new MailboxView(await store.listFolders(logon.mailbox.mailboxId));
  return logon.view;
}

/** The global counter of a folder/message ID of this store. */
export function counterOf(id: bigint): bigint {
  if (replidOf(id) !== REPLID) throw new RopError(Ec.NotFound, 'foreign replica id');
  return globcntOf(id);
}

export function folderNode(logon: LogonState, counter: bigint): FolderNode {
  const node = logon.view.get(counter);
  if (!node) throw new RopError(Ec.NotFound, 'folder not found');
  return node;
}

/** The database row of a folder; special folders have none. */
export function folderRecordId(node: FolderNode): string {
  if (!node.record) throw new RopError(Ec.NotSupported, `no content in special folder ${node.special}`);
  return node.record.id;
}

/**
 * Stored messages of a folder by message ID — a UID, or an ID a client
 * assigned (cached mode); unknown IDs are left out.
 */
export async function messagesByIds(store: MailStore, folderId: string, ids: readonly bigint[]): Promise<MessageSummary[]> {
  const counters = ids.map(counterOf);
  const found = await store.findMessagesByCounters(folderId, counters);
  return counters.map((c) => found.get(c)).filter((s): s is MessageSummary => s !== undefined);
}

/**
 * A message saved again as a new row (a draft) keeps its message ID: the new
 * row is bound to the previous counter (MapiObject), with the PCL of an
 * uploaded version.
 */
export async function keepMessageId(store: MailStore, mailboxId: string, previous: MessageSummary, saved: MessageSummary, pcl: Buffer | null): Promise<MessageSummary> {
  const clientId = messageCounter(previous);
  await store.bindMapiObject(mailboxId, { messageId: saved.id }, { clientId, ...(pcl ? { pcl } : {}) });
  return { ...saved, clientId, pcl };
}
