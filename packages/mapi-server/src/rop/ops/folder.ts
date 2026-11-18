/**
 * Folder ROPs (MS-OXCFOLD 2.2.1): RopOpenFolder, RopCreateFolder,
 * RopDeleteFolder, RopGetHierarchyTable, RopGetContentsTable,
 * RopDeleteMessages, RopMoveCopyMessages.
 *
 * Deleting messages tombstones them (recoverable like an IMAP EXPUNGE);
 * deleting a folder moves its mail into Deleted Items (storage
 * deleteFolderMovingMail). Special folders and the default folders (Inbox,
 * Drafts, Sent Items, Deleted Items, Junk Email, Archive) cannot be deleted.
 */
import { Ec, RopError, RopId } from '../codes.js';
import {
  assertWritable, defineRop, objectAt, objectOf, okResponse, putObject, type RopDef,
} from '../context.js';
import { HANDLE_UNUSED } from '../handles.js';
import { makeId } from '../../ids.js';
import { BufferWriter } from '../../wire/writer.js';
import { counterOf, folderNode, folderRecordId, refreshView, uidOf } from './common.js';
import { loadTableRows } from './table.js';
import type { TableSource, TableState } from '../../objects/state.js';
import type { BufferReader } from '../../wire/reader.js';

// ── RopOpenFolder ────────────────────────────────────────────────────────────

interface OpenReq { inputIndex: number; outputIndex: number; folderId: bigint; mode: number }

export const ropOpenFolder = defineRop<OpenReq>({
  id: RopId.OpenFolder,
  name: 'RopOpenFolder',
  parse: (r) => ({ inputIndex: r.u8(), outputIndex: r.u8(), folderId: r.u64(), mode: r.u8() }),
  responseIndex: (req) => req.outputIndex,
  async execute(ctx, req) {
    const { logon } = objectOf(ctx, req.inputIndex, 'logon', 'folder');
    await refreshView(ctx.store, logon);
    const node = folderNode(logon, counterOf(req.folderId));
    putObject(ctx, req.outputIndex, { kind: 'folder', logon, counter: node.counter }, req.logonId);
    return okResponse(RopId.OpenFolder, req.outputIndex).u8(0).u8(0).toBuffer();
  },
});

// ── RopCreateFolder ──────────────────────────────────────────────────────────

const FOLDER_GENERIC = 1;

interface CreateReq {
  inputIndex: number; outputIndex: number; folderType: number; openExisting: boolean; displayName: string;
}

export const ropCreateFolder = defineRop<CreateReq>({
  id: RopId.CreateFolder,
  name: 'RopCreateFolder',
  parse(r) {
    const inputIndex = r.u8();
    const outputIndex = r.u8();
    const folderType = r.u8();
    const unicode = r.u8() !== 0;
    const openExisting = r.u8() !== 0;
    r.u8(); // Reserved
    const displayName = unicode ? r.utf16Z() : r.asciiZ();
    if (unicode) r.utf16Z(); else r.asciiZ(); // Comment (not stored)
    return { inputIndex, outputIndex, folderType, openExisting, displayName };
  },
  responseIndex: (req) => req.outputIndex,
  async execute(ctx, req) {
    const { logon, counter } = objectOf(ctx, req.inputIndex, 'folder');
    assertWritable(logon);
    if (req.folderType !== FOLDER_GENERIC) throw new RopError(Ec.NotSupported, 'only generic folders can be created');
    const name = req.displayName.trim();
    if (!name) throw new RopError(Ec.InvalidParameter, 'empty folder name');
    const view = await refreshView(ctx.store, logon);
    const parent = folderNode(logon, counter);
    if (!parent.record && parent.special !== 'ipmSubtree') throw new RopError(Ec.AccessDenied, 'folders cannot be created here');

    const existing = view.children(parent.counter).find((c) => c.displayName.toLowerCase() === name.toLowerCase());
    let created = false;
    let target = existing;
    if (!target) {
      const result = await ctx.store.createFolder(logon.mailbox, parent.record, name);
      if (result === 'invalid-name') throw new RopError(Ec.InvalidParameter, 'reserved folder name');
      if (result === 'exists') throw new RopError(Ec.CollidingNames, 'a folder with this name exists');
      target = (await refreshView(ctx.store, logon)).ofRecord(result.id);
      created = true;
    } else if (!req.openExisting) {
      throw new RopError(Ec.CollidingNames, 'a folder with this name exists');
    }
    if (!target) throw new RopError(Ec.GeneralFailure, 'created folder not visible');
    putObject(ctx, req.outputIndex, { kind: 'folder', logon, counter: target.counter }, req.logonId);
    const w = okResponse(RopId.CreateFolder, req.outputIndex).u64(makeId(target.counter)).u8(created ? 0 : 1);
    if (!created) w.u8(0).u8(0); // HasRules, IsGhosted
    return w.toBuffer();
  },
});

// ── RopDeleteFolder ──────────────────────────────────────────────────────────

const DEL_MESSAGES = 0x01;
const DEL_FOLDERS = 0x04;

interface DeleteFolderReq { inputIndex: number; flags: number; folderId: bigint }

export const ropDeleteFolder = defineRop<DeleteFolderReq>({
  id: RopId.DeleteFolder,
  name: 'RopDeleteFolder',
  parse: (r) => ({ inputIndex: r.u8(), flags: r.u8(), folderId: r.u64() }),
  responseIndex: (req) => req.inputIndex,
  failureTail: [0],
  async execute(ctx, req) {
    const { logon } = objectOf(ctx, req.inputIndex, 'folder');
    assertWritable(logon);
    const view = await refreshView(ctx.store, logon);
    const node = folderNode(logon, counterOf(req.folderId));
    if (!node.record || node.role) throw new RopError(Ec.AccessDenied, 'this folder cannot be deleted');
    const recursive = (req.flags & DEL_FOLDERS) !== 0;
    if (!recursive && view.children(node.counter).length > 0) throw new RopError(Ec.HasFolders);
    if ((req.flags & DEL_MESSAGES) === 0 && node.record.totalCount > 0) throw new RopError(Ec.HasMessages);
    const result = await ctx.store.deleteFolder(logon.mailbox, node.record.id, recursive);
    if (result === 'not-found') throw new RopError(Ec.NotFound);
    if (result === 'no-trash') throw new RopError(Ec.HasMessages, 'no Deleted Items folder to move the mail to');
    await refreshView(ctx.store, logon);
    return okResponse(RopId.DeleteFolder, req.inputIndex).u8(0).toBuffer();
  },
});

// ── Hierarchy / contents tables ──────────────────────────────────────────────

const TABLE_ASSOCIATED = 0x02;
const TABLE_DEPTH = 0x04;
/** MS-OXCFOLD 2.2.1.13/14 TableFlags NoNotifications: no TableModified notifications. */
const TABLE_NO_NOTIFICATIONS = 0x10;

interface TableReq { inputIndex: number; outputIndex: number; tableFlags: number }

function openTable(kind: 'hierarchy' | 'contents'): RopDef {
  return defineRop<TableReq>({
    id: kind === 'hierarchy' ? RopId.GetHierarchyTable : RopId.GetContentsTable,
    name: kind === 'hierarchy' ? 'RopGetHierarchyTable' : 'RopGetContentsTable',
    parse: (r) => ({ inputIndex: r.u8(), outputIndex: r.u8(), tableFlags: r.u8() }),
    responseIndex: (req) => req.outputIndex,
    async execute(ctx, req) {
      const { logon, counter } = objectOf(ctx, req.inputIndex, 'folder');
      await refreshView(ctx.store, logon);
      folderNode(logon, counter);
      const source: TableSource = kind === 'hierarchy'
        ? { kind, folderCounter: counter, depth: (req.tableFlags & TABLE_DEPTH) !== 0 }
        : { kind, folderCounter: counter, associated: (req.tableFlags & TABLE_ASSOCIATED) !== 0 };
      const table: TableState = {
        source, columns: [], sort: [], restriction: null, position: 0, rows: null,
        notify: (req.tableFlags & TABLE_NO_NOTIFICATIONS) === 0,
      };
      const rows = await loadTableRows(ctx, logon, table);
      putObject(ctx, req.outputIndex, { kind: 'table', logon, table }, req.logonId);
      return okResponse(kind === 'hierarchy' ? RopId.GetHierarchyTable : RopId.GetContentsTable, req.outputIndex)
        .u32(rows.length).toBuffer();
    },
  });
}

export const ropGetHierarchyTable = openTable('hierarchy');
export const ropGetContentsTable = openTable('contents');

// ── RopDeleteMessages / RopMoveCopyMessages ──────────────────────────────────

function readIds(r: BufferReader): bigint[] {
  const n = r.u16();
  const ids: bigint[] = [];
  for (let i = 0; i < n; i++) ids.push(r.u64());
  return ids;
}

interface DeleteMessagesReq { inputIndex: number; messageIds: bigint[] }

export const ropDeleteMessages = defineRop<DeleteMessagesReq>({
  id: RopId.DeleteMessages,
  name: 'RopDeleteMessages',
  parse(r) {
    const inputIndex = r.u8();
    r.u8(); // WantAsynchronous
    r.u8(); // NotifyNonRead
    return { inputIndex, messageIds: readIds(r) };
  },
  responseIndex: (req) => req.inputIndex,
  failureTail: [0],
  async execute(ctx, req) {
    const { logon, counter } = objectOf(ctx, req.inputIndex, 'folder');
    assertWritable(logon);
    await refreshView(ctx.store, logon);
    const folderId = folderRecordId(folderNode(logon, counter));
    const uids = req.messageIds.map(uidOf);
    const deleted = await ctx.store.deleteMessages(logon.mailbox, folderId, uids);
    return okResponse(RopId.DeleteMessages, req.inputIndex).u8(deleted < uids.length ? 1 : 0).toBuffer();
  },
});

interface MoveCopyReq { sourceIndex: number; destIndex: number; messageIds: bigint[]; copy: boolean }

export const ropMoveCopyMessages = defineRop<MoveCopyReq>({
  id: RopId.MoveCopyMessages,
  name: 'RopMoveCopyMessages',
  parse(r) {
    const sourceIndex = r.u8();
    const destIndex = r.u8();
    const messageIds = readIds(r);
    r.u8(); // WantAsynchronous
    return { sourceIndex, destIndex, messageIds, copy: r.u8() !== 0 };
  },
  responseIndex: (req) => req.sourceIndex,
  failureTail: [0],
  async execute(ctx, req) {
    const source = objectOf(ctx, req.sourceIndex, 'folder');
    const destHandle = ctx.handles[req.destIndex];
    if (destHandle === undefined || destHandle === HANDLE_UNUSED) {
      // Null destination failure response (MS-OXCROPS 2.2.4.6.3).
      return new BufferWriter(11).u8(RopId.MoveCopyMessages).u8(req.sourceIndex).u32(Ec.NullDestinationObject)
        .u32(req.destIndex).u8(0).toBuffer();
    }
    const dest = objectAt(ctx, req.destIndex);
    if (dest.kind !== 'folder') throw new RopError(Ec.NotSupported, 'destination is not a folder');
    if (!req.copy) assertWritable(source.logon);
    assertWritable(dest.logon);
    await refreshView(ctx.store, source.logon);
    if (dest.logon !== source.logon) await refreshView(ctx.store, dest.logon);
    const from = { mailbox: source.logon.mailbox, folderId: folderRecordId(folderNode(source.logon, source.counter)) };
    const to = { mailbox: dest.logon.mailbox, folderId: folderRecordId(folderNode(dest.logon, dest.counter)) };
    const uids = req.messageIds.map(uidOf);
    const done = await ctx.store.moveOrCopy(from, to, uids, req.copy);
    return okResponse(RopId.MoveCopyMessages, req.sourceIndex).u8(done < uids.length ? 1 : 0).toBuffer();
  },
});

export const folderRops: RopDef[] = [
  ropOpenFolder, ropCreateFolder, ropDeleteFolder, ropGetHierarchyTable, ropGetContentsTable,
  ropDeleteMessages, ropMoveCopyMessages,
];
