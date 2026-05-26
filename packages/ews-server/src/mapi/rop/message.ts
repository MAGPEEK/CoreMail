/**
 * Message-ROP-Handler (v4.2.0 + v4.3.0)
 *
 * v4.2.0: RopOpenMessage, RopGetPropertiesAll, RopGetPropertiesSpecific
 * v4.3.0: RopCreateMessage, RopSetProperties, RopSaveChangesMessage,
 *         RopSubmitMessage
 */

import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { MapiReader, MapiWriter, MapiStatusCode } from '../codec.js';
import { RopId, PR, PropType, getPropType } from '../rop-types.js';
import {
  putRopObject, resolveHandleIndex,
} from '../rop-handle-table.js';
import { cuidToFolderId64 } from '../entry-id.js';
import { writeTaggedProperty, writePropertyValue } from '../property-codec.js';
import type { RopRequest } from '../rop-codec.js';

const log = createLogger('mapi:rop:message');

/** v4.2.0: RopOpenMessage */
export async function handleRopOpenMessage(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input) {
    return writeMsgError(RopId.OpenMessage, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  const r = new MapiReader(rop.payload);
  r.readUint16();                       // CodePageId
  const folderId64 = r.readUint64();
  r.readUint8();                        // OpenModeFlags
  const messageId64 = r.readUint64();

  // userId aus dem Input-Handle
  const userId = input.object.kind === 'mailbox' ? input.object.userId
              : input.object.kind === 'folder'  ? input.object.userId
              : null;
  if (!userId) {
    return writeMsgError(RopId.OpenMessage, rop, MapiStatusCode.EC_INVALID_PARAMETER);
  }

  // Folder via 64-bit-Hash auflösen
  const folders = await prisma.folder.findMany({
    where: { mailbox: { userId } },
    select: { id: true },
  });
  const folder = folders.find((f) => cuidToFolderId64(f.id) === folderId64);
  if (!folder) {
    return writeMsgError(RopId.OpenMessage, rop, MapiStatusCode.EC_NOT_FOUND);
  }

  // Message via 64-bit-Hash auflösen
  const messages = await prisma.message.findMany({
    where: { folderId: folder.id },
    select: { id: true },
  });
  const message = messages.find((m) => cuidToFolderId64(m.id) === messageId64);
  if (!message) {
    return writeMsgError(RopId.OpenMessage, rop, MapiStatusCode.EC_NOT_FOUND);
  }

  // Message-Handle in Tabelle anlegen
  const handle = await putRopObject(sessionToken, {
    kind: 'message', userId, folderId: folder.id, messageId: message.id,
  });
  if (handle === null) {
    return writeMsgError(RopId.OpenMessage, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  // Response: RopId, OutputHandleIndex, ReturnValue, HasNamedProperties (1B),
  //   SubjectPrefix (string), NormalizedSubject (string), RecipientCount (uint16),
  //   ColumnCount (uint16), Columns (uint32[]), RowCount (uint8), Rows (variable)
  // v4.2.0 vereinfacht — keine RecipientList
  const w = new MapiWriter();
  w.writeUint8(RopId.OpenMessage);
  w.writeUint8(rop.outputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  w.writeUint8(0);                     // HasNamedProperties = false
  w.writeUtf16String('');              // SubjectPrefix
  w.writeUtf16String('');              // NormalizedSubject (wird via GetProperties geliefert)
  w.writeUint16(0);                    // RecipientCount = 0 (v4.3 ergänzt)
  w.writeUint16(0);                    // ColumnCount = 0
  w.writeUint8(0);                     // RowCount = 0
  log.info({ messageId: message.id, handle }, 'RopOpenMessage erfolgreich');
  return w.toBuffer();
}

/** v4.2.0: RopGetPropertiesAll — alle Properties einer Message zurückgeben. */
export async function handleRopGetPropertiesAll(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input || input.object.kind !== 'message') {
    return writeMsgError(RopId.GetPropertiesAll, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  const msg = await prisma.message.findUnique({
    where: { id: input.object.messageId },
    select: { id: true, subject: true, fromAddr: true, fromName: true,
              toAddrs: true, ccAddrs: true, bccAddrs: true, replyTo: true,
              date: true, bodyText: true, bodyHtml: true, rawSize: true,
              flags: true, messageId: true, inReplyTo: true },
  });
  if (!msg) {
    return writeMsgError(RopId.GetPropertiesAll, rop, MapiStatusCode.EC_NOT_FOUND);
  }

  const props = buildMessagePropertyList(msg);

  // Response: RopId, InputHandleIndex, ReturnValue, PropertyValueCount (uint16),
  //   TaggedPropertyValues (variable)
  const w = new MapiWriter();
  w.writeUint8(RopId.GetPropertiesAll);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  w.writeUint16(props.size);
  for (const [tag, value] of props) {
    writeTaggedProperty(w, tag, value);
  }
  return w.toBuffer();
}

/** v4.2.0: RopGetPropertiesSpecific. */
export async function handleRopGetPropertiesSpecific(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input || input.object.kind !== 'message') {
    return writeMsgError(RopId.GetPropertiesSpecific, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  // Parse requested tags
  const r = new MapiReader(rop.payload);
  r.readUint16();                       // PropertySizeLimit
  r.readUint16();                       // WantUnicode
  const tagCount = r.readUint16();
  const tags: number[] = [];
  for (let i = 0; i < tagCount; i++) {
    tags.push(r.readUint32());
  }

  const msg = await prisma.message.findUnique({
    where: { id: input.object.messageId },
    select: { id: true, subject: true, fromAddr: true, fromName: true,
              toAddrs: true, ccAddrs: true, date: true, bodyText: true,
              bodyHtml: true, rawSize: true, flags: true, messageId: true },
  });
  if (!msg) {
    return writeMsgError(RopId.GetPropertiesSpecific, rop, MapiStatusCode.EC_NOT_FOUND);
  }

  const allProps = buildMessagePropertyList(msg);
  // Response: nur die requested tags, gleiche Reihenfolge wie tags[]
  const w = new MapiWriter();
  w.writeUint8(RopId.GetPropertiesSpecific);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  // PropertyRow Header: 0x00 = no errors
  w.writeUint8(0);
  for (const tag of tags) {
    const v = allProps.get(tag);
    if (v === undefined) {
      writePropertyValue(w, getPropType(tag), defaultForType(getPropType(tag)));
    } else {
      writePropertyValue(w, getPropType(tag), v);
    }
  }
  return w.toBuffer();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

interface MessageData {
  id: string;
  subject: string;
  fromAddr: string;
  fromName: string;
  toAddrs?: string[];
  ccAddrs?: string[];
  bccAddrs?: string[];
  replyTo?: string[] | string | null;
  date: Date;
  bodyText?: string;
  bodyHtml?: string;
  rawSize: number | bigint;
  flags: string[];
  messageId?: string | null;
  inReplyTo?: string | null;
}

function buildMessagePropertyList(msg: MessageData): Map<number, unknown> {
  const m = new Map<number, unknown>();
  m.set(PR.PR_SUBJECT_W, msg.subject);
  m.set(PR.PR_NORMALIZED_SUBJECT_W, msg.subject.replace(/^(Re|Fwd|Aw|Wg):\s+/i, ''));
  m.set(PR.PR_SUBJECT_PREFIX_W, '');
  m.set(PR.PR_SENDER_NAME_W, msg.fromName || msg.fromAddr);
  m.set(PR.PR_SENDER_EMAIL_ADDRESS_W, msg.fromAddr);
  m.set(PR.PR_SENT_REPRESENTING_NAME_W, msg.fromName || msg.fromAddr);
  m.set(PR.PR_SENT_REPRESENTING_EMAIL_ADDRESS_W, msg.fromAddr);
  m.set(PR.PR_DISPLAY_TO_W, (msg.toAddrs ?? []).join('; '));
  m.set(PR.PR_DISPLAY_CC_W, (msg.ccAddrs ?? []).join('; '));
  m.set(PR.PR_DISPLAY_BCC_W, (msg.bccAddrs ?? []).join('; '));
  m.set(PR.PR_MESSAGE_DELIVERY_TIME, msg.date);
  m.set(PR.PR_CLIENT_SUBMIT_TIME, msg.date);
  m.set(PR.PR_CREATION_TIME, msg.date);
  m.set(PR.PR_LAST_MODIFICATION_TIME, msg.date);
  m.set(PR.PR_BODY_W, msg.bodyText ?? '');
  if (msg.bodyHtml) {
    m.set(PR.PR_HTML, Buffer.from(msg.bodyHtml, 'utf-8'));
  }
  m.set(PR.PR_MESSAGE_SIZE,
    typeof msg.rawSize === 'bigint' ? Number(msg.rawSize) : msg.rawSize);
  // Flags: Read = 0x01
  let flagBits = 0;
  if (msg.flags.includes('\\Seen')) flagBits |= 0x01;
  m.set(PR.PR_MESSAGE_FLAGS, flagBits);
  m.set(PR.PR_MESSAGE_CLASS_W, 'IPM.Note');
  m.set(PR.PR_HAS_ATTACH, false);  // v4.4.0 erweitert
  m.set(PR.PR_PRIORITY, 0);
  m.set(PR.PR_IMPORTANCE, 1);
  if (msg.messageId) m.set(PR.PR_INTERNET_MESSAGE_ID_W, msg.messageId);
  if (msg.inReplyTo) m.set(PR.PR_IN_REPLY_TO_ID_W, msg.inReplyTo);
  m.set(PR.PR_CONVERSATION_TOPIC_W, msg.subject);
  return m;
}

function defaultForType(propType: number): unknown {
  switch (propType) {
    case PropType.Int16:
    case PropType.Int32:    return 0;
    case PropType.Int64:    return 0n;
    case PropType.Boolean:  return false;
    case PropType.Unicode:
    case PropType.String8:  return '';
    case PropType.SysTime:  return 0n;
    case PropType.Binary:   return Buffer.alloc(0);
    default:                return null;
  }
}

function writeMsgError(ropId: number, rop: RopRequest, errorCode: number): Buffer {
  const w = new MapiWriter();
  w.writeUint8(ropId);
  w.writeUint8(rop.outputHandleIndex ?? rop.inputHandleIndex ?? 0);
  w.writeUint32(errorCode);
  return w.toBuffer();
}

// ── v4.3.0 STUBS — Mail-Schreiben ────────────────────────────────────────────

/** v4.3.0: RopCreateMessage */
export async function handleRopCreateMessage(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input || (input.object.kind !== 'mailbox' && input.object.kind !== 'folder')) {
    return writeMsgError(RopId.CreateMessage, rop, MapiStatusCode.EC_INVALID_SESSION);
  }
  // v4.3.0 MVP: erlaubt nur in Drafts/Outbox. Wir geben ecNotSupported zurück
  // bis volle Implementation (DB-Write + Buffer-Akkumulation).
  return writeMsgError(RopId.CreateMessage, rop, MapiStatusCode.EC_NOT_SUPPORTED);
}

/** v4.3.0: RopSetProperties */
export async function handleRopSetProperties(
  rop: RopRequest,
  _sessionToken: string,
  _serverObjectHandles: number[],
): Promise<Buffer> {
  return writeMsgError(RopId.SetProperties, rop, MapiStatusCode.EC_NOT_SUPPORTED);
}

/** v4.3.0: RopSaveChangesMessage */
export async function handleRopSaveChangesMessage(
  rop: RopRequest,
  _sessionToken: string,
  _serverObjectHandles: number[],
): Promise<Buffer> {
  return writeMsgError(RopId.SaveChangesMessage, rop, MapiStatusCode.EC_NOT_SUPPORTED);
}

/** v4.3.0: RopSubmitMessage — wird in v4.3.0 via BullMQ-Bridge implementiert. */
export async function handleRopSubmitMessage(
  rop: RopRequest,
  _sessionToken: string,
  _serverObjectHandles: number[],
): Promise<Buffer> {
  return writeMsgError(RopId.SubmitMessage, rop, MapiStatusCode.EC_NOT_SUPPORTED);
}
