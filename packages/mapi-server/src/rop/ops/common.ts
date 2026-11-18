/** Helpers shared by the ROP handlers. */
import { Ec, RopError } from '../codes.js';
import { globcntOf, replidOf, REPLID } from '../../ids.js';
import { MailboxView, type FolderNode } from '../../objects/mailbox-view.js';
import type { LogonState } from '../../objects/state.js';
import type { MailStore } from '../../store/types.js';

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

/** Message UID from a message ID (database messages only). */
export function uidOf(messageId: bigint): number {
  const c = counterOf(messageId);
  if (c <= 0n || c > 0xffffffffn) throw new RopError(Ec.NotFound, 'message id outside the stored range');
  return Number(c);
}
