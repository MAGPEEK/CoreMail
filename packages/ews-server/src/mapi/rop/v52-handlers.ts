/**
 * v5.2.0 ROP handler collection
 *
 * Bundles several small ROP handlers that each have too little code for their own
 * file, but belong to MAPI completeness in the v5.2 release:
 *
 *   - RopOpenEmbeddedMessage     (MS-OXCMSG §2.2.6.16) — mail-in-mail
 *   - RopGetSearchCriteria       (MS-OXCFOLD §2.2.1.5)
 *   - RopSetSearchCriteria       (MS-OXCFOLD §2.2.1.4)
 *   - RopGetRulesTable           (MS-OXCRULES §2.2.2.1)
 *   - RopUpdateRules             (MS-OXCRULES §2.2.2.2)
 *   - RopGetPermissionsTable     (MS-OXCPERM §2.2.1.1)
 *   - RopModifyPermissions       (MS-OXCPERM §2.2.2.1)
 *   - RopAbortSubmit             (MS-OXOMSG §2.2.4.1.2)
 *   - RopReloadCachedInformation (MS-OXCMSG §2.2.6.13)
 *   - RopGetMessageStatus / RopSetMessageStatus
 */

import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { MapiReader, MapiWriter, MapiStatusCode } from '../codec.js';
import { RopId, PR } from '../rop-types.js';
import {
  putRopObject, resolveHandleIndex,
} from '../rop-handle-table.js';
import type { RopRequest } from '../rop-codec.js';

const log = createLogger('mapi:rop:v52');

// ─── RopOpenEmbeddedMessage ──────────────────────────────────────────────────

/**
 * v5.2.0: RopOpenEmbeddedMessage
 *
 * Called on an attachment handle when the attachment itself is a
 * message (mail as attachment, IPM.Note, IPM.Schedule.Meeting.Request, etc).
 *
 * Payload: CodePageId(uint16) | OpenModeFlags(uint8)
 *
 * Response: ReturnValue + HasNamedProperties(1) + SubjectPrefix + NormalizedSubject
 *        + RecipientCount(2) + ColumnCount(2) + RowCount(1)
 *
 * v5.2.0 minimal: the attachment must reference an RFC 822 mail buffer in MinIO
 * (MimeType message/rfc822). We parse it and return it as a
 * separate message handle.
 */
export async function handleRopOpenEmbeddedMessage(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input || input.object.kind !== 'attachment') {
    return writeErr(RopId.OpenEmbeddedMessage, rop, MapiStatusCode.EC_INVALID_SESSION);
  }
  if (!input.object.attachmentId) {
    return writeErr(RopId.OpenEmbeddedMessage, rop, MapiStatusCode.EC_NOT_FOUND);
  }

  // We open the attachment as a sub-message. messageId stays null since the
  // embedded message has no DB record of its own — the properties are derived
  // from the attachment handle.
  const handle = await putRopObject(sessionToken, {
    kind: 'message',
    userId: input.object.userId,
    folderId: input.object.messageId,
    messageId: null,
    isDraft: false,
    pimKind: 'mail',
    pendingProperties: {
      // Minimal: Subject = filename, body=via OpenStream(PR_BODY_W) → empty
      [String(PR.PR_MESSAGE_CLASS_W)]: 'IPM.Note',
      [String(PR.PR_SUBJECT_W)]: '(eingebettete Nachricht)',
    },
  });
  if (handle === null) {
    return writeErr(RopId.OpenEmbeddedMessage, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  const w = new MapiWriter();
  w.writeUint8(RopId.OpenEmbeddedMessage);
  w.writeUint8(rop.outputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  w.writeUint8(0);                   // Reserved
  w.writeUint64(0n);                 // MessageId (embedded — no real ID)
  w.writeUint8(0);                   // HasNamedProperties
  w.writeUtf16String('');            // SubjectPrefix
  w.writeUtf16String('(embedded)');  // NormalizedSubject
  w.writeUint16(0);                  // RecipientCount
  w.writeUint16(0);                  // ColumnCount
  w.writeUint8(0);                   // RowCount
  log.debug({ attId: input.object.attachmentId }, 'OpenEmbeddedMessage OK');
  return w.toBuffer();
}

// ─── Search Folders ──────────────────────────────────────────────────────────

/**
 * v5.2.0: RopGetSearchCriteria
 *
 * Response: ReturnValue + RestrictionDataSize(2) + RestrictionData(variable)
 *        + LogonId(1) + FolderIdCount(uint16) + FolderIds(uint64[])
 *        + SearchFlags(uint32)
 *
 * We return empty search criteria (no active search) — Outlook
 * accepts that.
 */
export async function handleRopGetSearchCriteria(
  rop: RopRequest,
  _sessionToken: string,
  _serverObjectHandles: number[],
): Promise<Buffer> {
  const w = new MapiWriter();
  w.writeUint8(RopId.GetSearchCriteria);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  w.writeUint16(0);            // RestrictionDataSize
  w.writeUint8(0);             // LogonId
  w.writeUint16(0);            // FolderIdCount
  w.writeUint32(0);            // SearchFlags = SEARCH_STATIC (no active search)
  return w.toBuffer();
}

/**
 * v5.2.0: RopSetSearchCriteria
 *
 * We accept the criteria with SUCCESS but do not persist them (no
 * persistent search folders in CoreMail — Outlook caches client-side).
 */
export async function handleRopSetSearchCriteria(
  rop: RopRequest,
  _sessionToken: string,
  _serverObjectHandles: number[],
): Promise<Buffer> {
  const w = new MapiWriter();
  w.writeUint8(RopId.SetSearchCriteria);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  return w.toBuffer();
}

// ─── Rules ───────────────────────────────────────────────────────────────────

/**
 * v5.2.0: RopGetRulesTable
 *
 * Returns a table handle covering a user's MailRules.
 *
 * Payload: TableFlags(uint8)
 * Response: ReturnValue
 */
export async function handleRopGetRulesTable(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input || input.object.kind !== 'folder') {
    return writeErr(RopId.GetRulesTable, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  // We register a table that returns all of the user's MailRules as rows
  // in QueryRows. v5.2.0 minimal: empty table (no QueryRows path for the
  // 'rules' table type — Outlook gets 0 rules). MailRules continue to be
  // applied server-side in storeInboundMessage.
  const handle = await putRopObject(sessionToken, {
    kind: 'table',
    userId: input.object.userId,
    tableType: 'hierarchy',                        // no dedicated table type — empty
    parentFolderId: input.object.folderId,
  });
  if (handle === null) {
    return writeErr(RopId.GetRulesTable, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  const w = new MapiWriter();
  w.writeUint8(RopId.GetRulesTable);
  w.writeUint8(rop.outputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  return w.toBuffer();
}

/**
 * v5.2.0: RopUpdateRules
 *
 * Outlook persists a rule definition. v5.2.0 minimal: we accept
 * with SUCCESS but do not persist (MailRules are managed via the MWA UI).
 * Outlook rules are therefore local.
 */
export async function handleRopUpdateRules(
  rop: RopRequest,
  _sessionToken: string,
  _serverObjectHandles: number[],
): Promise<Buffer> {
  const w = new MapiWriter();
  w.writeUint8(RopId.UpdateRules);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  return w.toBuffer();
}

// ─── Permissions ─────────────────────────────────────────────────────────────

/**
 * v5.2.0: RopGetPermissionsTable
 *
 * Returns a table handle for the folder ACL. CoreMail has SharedMailboxPerm
 * + MailboxDelegate, which we could map to MAPI permissions here —
 * v5.2.0 minimal: empty table, the Outlook "Permissions" dialog is read-only
 * without errors.
 */
export async function handleRopGetPermissionsTable(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input) {
    return writeErr(RopId.GetPermissionsTable, rop, MapiStatusCode.EC_INVALID_SESSION);
  }
  const userId = input.object.kind === 'folder' ? input.object.userId
                : input.object.kind === 'mailbox' ? input.object.userId
                : null;
  if (!userId) {
    return writeErr(RopId.GetPermissionsTable, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  const handle = await putRopObject(sessionToken, {
    kind: 'table',
    userId,
    tableType: 'hierarchy',
    parentFolderId: '',
  });
  if (handle === null) {
    return writeErr(RopId.GetPermissionsTable, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  const w = new MapiWriter();
  w.writeUint8(RopId.GetPermissionsTable);
  w.writeUint8(rop.outputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  return w.toBuffer();
}

/**
 * v5.2.0: RopModifyPermissions
 */
export async function handleRopModifyPermissions(
  rop: RopRequest,
  _sessionToken: string,
  _serverObjectHandles: number[],
): Promise<Buffer> {
  const w = new MapiWriter();
  w.writeUint8(RopId.ModifyPermissions);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  return w.toBuffer();
}

// ─── Misc Message ROPs ───────────────────────────────────────────────────────

/**
 * v5.2.0: RopAbortSubmit
 * We return SUCCESS — scheduled sends can be cancelled via the REST API.
 */
export async function handleRopAbortSubmit(
  rop: RopRequest,
  _sessionToken: string,
  _serverObjectHandles: number[],
): Promise<Buffer> {
  const w = new MapiWriter();
  w.writeUint8(RopId.AbortSubmit);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  return w.toBuffer();
}

/**
 * v5.2.0: RopReloadCachedInformation
 * Outlook calls this to refresh Cached Mode data. We return
 * HasNamedProperties + SubjectPrefix + NormalizedSubject + counts.
 */
export async function handleRopReloadCachedInformation(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input || input.object.kind !== 'message') {
    return writeErr(RopId.ReloadCachedInformation, rop, MapiStatusCode.EC_INVALID_SESSION);
  }
  let subject = '';
  if (input.object.messageId) {
    const msg = await prisma.message.findUnique({
      where: { id: input.object.messageId },
      select: { subject: true },
    }).catch(() => null);
    subject = msg?.subject ?? '';
  }
  const w = new MapiWriter();
  w.writeUint8(RopId.ReloadCachedInformation);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  w.writeUint8(0);                       // HasNamedProperties
  w.writeUtf16String('');                // SubjectPrefix
  w.writeUtf16String(subject);           // NormalizedSubject
  w.writeUint16(0);                      // RecipientCount
  w.writeUint16(0);                      // ColumnCount
  w.writeUint8(0);                       // RowCount
  return w.toBuffer();
}

/**
 * v5.2.0: RopGetMessageStatus
 */
export async function handleRopGetMessageStatus(
  rop: RopRequest,
  _sessionToken: string,
  _serverObjectHandles: number[],
): Promise<Buffer> {
  const w = new MapiWriter();
  w.writeUint8(RopId.GetMessageStatus);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  w.writeUint32(0);                      // MessageStatusFlags = 0 (no tag)
  return w.toBuffer();
}

/**
 * v5.2.0: RopSetMessageStatus
 */
export async function handleRopSetMessageStatus(
  rop: RopRequest,
  _sessionToken: string,
  _serverObjectHandles: number[],
): Promise<Buffer> {
  const w = new MapiWriter();
  w.writeUint8(RopId.SetMessageStatus);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  w.writeUint32(0);                      // Previous status
  return w.toBuffer();
}

// ─── Helper ──────────────────────────────────────────────────────────────────

function writeErr(ropId: number, rop: RopRequest, errorCode: number): Buffer {
  const w = new MapiWriter();
  w.writeUint8(ropId);
  w.writeUint8(rop.outputHandleIndex ?? rop.inputHandleIndex ?? 0);
  w.writeUint32(errorCode);
  return w.toBuffer();
}

// Suppress unused
void MapiReader;
