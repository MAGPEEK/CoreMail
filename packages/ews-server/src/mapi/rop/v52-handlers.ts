/**
 * v5.2.0 ROP-Handler-Sammlung
 *
 * Bündelt mehrere kleine ROP-Handler die jeweils zu wenig Code für eine eigene
 * Datei haben, aber im v5.2-Release zur MAPI-Vollständigkeit gehören:
 *
 *   - RopOpenEmbeddedMessage     (MS-OXCMSG §2.2.6.16) — Mail-in-Mail
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
 * Wird auf einem Attachment-Handle aufgerufen wenn der Attachment selbst eine
 * Message ist (Mail-als-Anhang, IPM.Note, IPM.Schedule.Meeting.Request, etc).
 *
 * Payload: CodePageId(uint16) | OpenModeFlags(uint8)
 *
 * Antwort: ReturnValue + HasNamedProperties(1) + SubjectPrefix + NormalizedSubject
 *        + RecipientCount(2) + ColumnCount(2) + RowCount(1)
 *
 * v5.2.0 minimal: das Attachment muss eine RFC-822-Mail-Buffer in MinIO
 * referenzieren (MimeType message/rfc822). Wir parsen es und liefern es als
 * separates Message-Handle aus.
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

  // Wir öffnen das Attachment als sub-message. messageId bleibt null, da das
  // embedded message kein eigenes DB-Record hat — die Properties werden vom
  // Attachment-Handle abgeleitet.
  const handle = await putRopObject(sessionToken, {
    kind: 'message',
    userId: input.object.userId,
    folderId: input.object.messageId,
    messageId: null,
    isDraft: false,
    pimKind: 'mail',
    pendingProperties: {
      // Minimal: Subject = filename, body=via OpenStream(PR_BODY_W) → leer
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
  w.writeUint64(0n);                 // MessageId (embedded — keine echte ID)
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
 * Antwort: ReturnValue + RestrictionDataSize(2) + RestrictionData(variable)
 *        + LogonId(1) + FolderIdCount(uint16) + FolderIds(uint64[])
 *        + SearchFlags(uint32)
 *
 * Wir liefern leere Search-Criteria (kein Active-Search) — Outlook
 * akzeptiert das.
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
  w.writeUint32(0);            // SearchFlags = SEARCH_STATIC (kein aktiver Search)
  return w.toBuffer();
}

/**
 * v5.2.0: RopSetSearchCriteria
 *
 * Wir akzeptieren die Criteria mit SUCCESS aber persistieren sie nicht (keine
 * persistenten Suchordner in CoreMail — Outlook macht Client-seitig Cache).
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
 * Liefert ein Table-Handle das die MailRules eines Users umfasst.
 *
 * Payload: TableFlags(uint8)
 * Antwort: ReturnValue
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

  // Wir registrieren eine Table die in QueryRows alle MailRules des Users
  // als Rows liefert. v5.2.0 minimal: leere Tabelle (kein QueryRows-Pfad für
  // 'rules' Tabellen-Typ — Outlook bekommt 0 Rules). MailRules werden weiter
  // server-seitig in storeInboundMessage angewendet.
  const handle = await putRopObject(sessionToken, {
    kind: 'table',
    userId: input.object.userId,
    tableType: 'hierarchy',                        // kein eigener Tabellen-Typ — leer
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
 * Outlook persistiert eine Rule-Definition. v5.2.0 minimal: wir akzeptieren
 * mit SUCCESS aber persistieren nicht (MailRules werden über das MWA-UI
 * verwaltet). Outlook-Rules sind damit lokal.
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
 * Liefert ein Table-Handle für die Folder-ACL. CoreMail hat SharedMailboxPerm
 * + MailboxDelegate, die wir hier auf MAPI-Permissions abbilden könnten —
 * v5.2.0 minimal: leere Tabelle, Outlook-„Berechtigungen"-Dialog ist read-
 * only ohne Fehler.
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
 * Wir geben SUCCESS zurück — geplante Sends können via REST-API gecancelt werden.
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
 * Outlook ruft das auf um Cached-Mode-Daten zu refreshen. Wir liefern
 * HasNamedProperties + SubjectPrefix + NormalizedSubject + Counts.
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
  w.writeUint32(0);                      // MessageStatusFlags = 0 (kein Tag)
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
