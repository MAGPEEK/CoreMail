/**
 * Message ROP handler (v4.2.0 + v4.3.0)
 *
 * v4.2.0: RopOpenMessage, RopGetPropertiesAll, RopGetPropertiesSpecific
 * v4.3.0: RopCreateMessage, RopSetProperties, RopSaveChangesMessage,
 *         RopSubmitMessage
 */

import { prisma } from '@coremail/storage';
import { createLogger, createBullMqConnection } from '@coremail/core';
import { Queue } from 'bullmq';
import { MapiReader, MapiWriter, MapiStatusCode } from '../codec.js';
import { RopId, PR, PropType, getPropType } from '../rop-types.js';
import {
  putRopObject, resolveHandleIndex, updateRopObject,
  type RopObject,
} from '../rop-handle-table.js';
import { cuidToFolderId64 } from '../entry-id.js';
import { writeTaggedProperty, writePropertyValue, readPropertyValue } from '../property-codec.js';
import { VIRTUAL_FOLDERS } from './folder.js';
import { buildPimPropertyList } from './pim-properties.js';
import type { RopRequest } from '../rop-codec.js';

/**
 * Local BullMQ queue handle for the smtp-outbound queue. We import
 * `Queue` directly from 'bullmq' (instead of from smtp-server) to avoid
 * cross-package dependencies — the queue name ('smtp-outbound') is the
 * shared convention with the consumer in smtp-server.
 */
let _mapiOutboundQueue: Queue | null = null;
function getMapiOutboundQueue(): Queue {
  if (!_mapiOutboundQueue) {
    _mapiOutboundQueue = new Queue('smtp-outbound', {
      connection: createBullMqConnection(),
      defaultJobOptions: {
        attempts: 10,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: { count: 100 },
        removeOnFail:     { count: 500 },
      },
    });
  }
  return _mapiOutboundQueue;
}

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

  // userId from the input handle
  const userId = input.object.kind === 'mailbox' ? input.object.userId
              : input.object.kind === 'folder'  ? input.object.userId
              : null;
  if (!userId) {
    return writeMsgError(RopId.OpenMessage, rop, MapiStatusCode.EC_INVALID_PARAMETER);
  }

  // v4.6.0: Check virtual PIM folders first
  const vf = VIRTUAL_FOLDERS.find((v) => cuidToFolderId64(v.id) === folderId64);
  if (vf) {
    return openVirtualPimMessage(rop, sessionToken, userId, vf.id, messageId64);
  }

  // Resolve folder via 64-bit hash (standard mail folder)
  const folders = await prisma.folder.findMany({
    where: { mailbox: { userId } },
    select: { id: true },
  });
  const folder = folders.find((f) => cuidToFolderId64(f.id) === folderId64);
  if (!folder) {
    return writeMsgError(RopId.OpenMessage, rop, MapiStatusCode.EC_NOT_FOUND);
  }

  // Resolve message via 64-bit hash
  const messages = await prisma.message.findMany({
    where: { folderId: folder.id },
    select: { id: true },
  });
  const message = messages.find((m) => cuidToFolderId64(m.id) === messageId64);
  if (!message) {
    return writeMsgError(RopId.OpenMessage, rop, MapiStatusCode.EC_NOT_FOUND);
  }

  // Create message handle in the table
  const handle = await putRopObject(sessionToken, {
    kind: 'message', userId, folderId: folder.id, messageId: message.id,
  });
  if (handle === null) {
    return writeMsgError(RopId.OpenMessage, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  // Response: RopId, OutputHandleIndex, ReturnValue, HasNamedProperties (1B),
  //   SubjectPrefix (string), NormalizedSubject (string), RecipientCount (uint16),
  //   ColumnCount (uint16), Columns (uint32[]), RowCount (uint8), Rows (variable)
  // v4.2.0 simplified — no RecipientList
  const w = new MapiWriter();
  w.writeUint8(RopId.OpenMessage);
  w.writeUint8(rop.outputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  w.writeUint8(0);                     // HasNamedProperties = false
  w.writeUtf16String('');              // SubjectPrefix
  w.writeUtf16String('');              // NormalizedSubject (delivered via GetProperties)
  w.writeUint16(0);                    // RecipientCount = 0 (added in v4.3)
  w.writeUint16(0);                    // ColumnCount = 0
  w.writeUint8(0);                     // RowCount = 0
  log.info({ messageId: message.id, handle }, 'RopOpenMessage successful');
  return w.toBuffer();
}

/** v4.2.0: RopGetPropertiesAll — return all properties of a message. */
export async function handleRopGetPropertiesAll(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input || input.object.kind !== 'message') {
    return writeMsgError(RopId.GetPropertiesAll, rop, MapiStatusCode.EC_INVALID_SESSION);
  }
  if (input.object.messageId === null) {
    // Draft not yet persisted — v4.3.0 returns accumulated properties here
    return writeMsgError(RopId.GetPropertiesAll, rop, MapiStatusCode.EC_NOT_FOUND);
  }
  const messageId: string = input.object.messageId;

  // v5.1.0: PIM item dispatch
  let props: Map<number, unknown>;
  if (input.object.pimKind && input.object.pimKind !== 'mail') {
    props = await buildPimPropertyList(sessionToken, input.object.pimKind, messageId);
  } else {
    const msg = await prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, subject: true, fromAddr: true, fromName: true,
                toAddrs: true, ccAddrs: true, bccAddrs: true, replyTo: true,
                date: true, bodyText: true, bodyHtml: true, rawSize: true,
                flags: true, messageId: true, inReplyTo: true,
                _count: { select: { attachments: true } } },
    });
    if (!msg) {
      return writeMsgError(RopId.GetPropertiesAll, rop, MapiStatusCode.EC_NOT_FOUND);
    }
    props = buildMessagePropertyList({ ...msg, hasAttach: (msg._count?.attachments ?? 0) > 0 });
  }

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
  if (input.object.messageId === null) {
    return writeMsgError(RopId.GetPropertiesSpecific, rop, MapiStatusCode.EC_NOT_FOUND);
  }
  const messageId: string = input.object.messageId;

  // Parse requested tags
  const r = new MapiReader(rop.payload);
  r.readUint16();                       // PropertySizeLimit
  r.readUint16();                       // WantUnicode
  const tagCount = r.readUint16();
  const tags: number[] = [];
  for (let i = 0; i < tagCount; i++) {
    tags.push(r.readUint32());
  }

  // v5.1.0: PIM item dispatch
  let allProps: Map<number, unknown>;
  if (input.object.pimKind && input.object.pimKind !== 'mail') {
    allProps = await buildPimPropertyList(sessionToken, input.object.pimKind, messageId);
  } else {
    const msg = await prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, subject: true, fromAddr: true, fromName: true,
                toAddrs: true, ccAddrs: true, date: true, bodyText: true,
                bodyHtml: true, rawSize: true, flags: true, messageId: true,
                _count: { select: { attachments: true } } },
    });
    if (!msg) {
      return writeMsgError(RopId.GetPropertiesSpecific, rop, MapiStatusCode.EC_NOT_FOUND);
    }
    allProps = buildMessagePropertyList({ ...msg, hasAttach: (msg._count?.attachments ?? 0) > 0 });
  }
  // Response: only the requested tags, same order as tags[]
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
  hasAttach?: boolean;
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
  m.set(PR.PR_HAS_ATTACH, msg.hasAttach ?? false);
  if (msg.hasAttach) {
    // Add the PR_MESSAGE_FLAGS HasAttach bit (0x10)
    const cur = m.get(PR.PR_MESSAGE_FLAGS) as number | undefined;
    m.set(PR.PR_MESSAGE_FLAGS, (cur ?? 0) | 0x10);
  }
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

// ── v4.6.0 — Virtual PIM Message Open (Calendar/Contact/Task/Note) ────────────

async function openVirtualPimMessage(
  rop: RopRequest,
  sessionToken: string,
  userId: string,
  virtualFolderId: string,
  messageId64: bigint,
): Promise<Buffer> {
  let foundId: string | null = null;
  let pimKind: 'appointment' | 'contact' | 'task' | 'note' | null = null;
  switch (virtualFolderId) {
    case 'virtual-calendar': {
      const events = await prisma.calendarEvent.findMany({
        where: { calendar: { userId } },
        select: { id: true },
      }).catch(() => []);
      const e = events.find((x) => cuidToFolderId64(x.id) === messageId64);
      if (e) { foundId = e.id; pimKind = 'appointment'; }
      break;
    }
    case 'virtual-contacts': {
      const contacts = await prisma.contact.findMany({
        where: { userId }, select: { id: true },
      }).catch(() => []);
      const c = contacts.find((x) => cuidToFolderId64(x.id) === messageId64);
      if (c) { foundId = c.id; pimKind = 'contact'; }
      break;
    }
    case 'virtual-tasks': {
      const tasks = await prisma.task.findMany({
        where: { userId }, select: { id: true },
      }).catch(() => []);
      const t = tasks.find((x) => cuidToFolderId64(x.id) === messageId64);
      if (t) { foundId = t.id; pimKind = 'task'; }
      break;
    }
    case 'virtual-notes': {
      const notes = await prisma.note.findMany({
        where: { userId }, select: { id: true },
      }).catch(() => []);
      const n = notes.find((x) => cuidToFolderId64(x.id) === messageId64);
      if (n) { foundId = n.id; pimKind = 'note'; }
      break;
    }
  }
  if (!foundId || !pimKind) {
    return writeMsgError(RopId.OpenMessage, rop, MapiStatusCode.EC_NOT_FOUND);
  }

  // v5.1.0: Set pimKind on the handle → GetPropertiesAll/Specific
  // dispatch to buildPimPropertyList for the full detail view.
  const handle = await putRopObject(sessionToken, {
    kind: 'message', userId, folderId: virtualFolderId, messageId: foundId, pimKind,
  });
  if (handle === null) {
    return writeMsgError(RopId.OpenMessage, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  const w = new MapiWriter();
  w.writeUint8(RopId.OpenMessage);
  w.writeUint8(rop.outputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  w.writeUint8(0);                     // HasNamedProperties
  w.writeUtf16String('');              // SubjectPrefix
  w.writeUtf16String('');              // NormalizedSubject
  w.writeUint16(0);                    // RecipientCount
  w.writeUint16(0);                    // ColumnCount
  w.writeUint8(0);                     // RowCount
  log.info({ virtualFolderId, itemId: foundId }, 'openVirtualPimMessage OK');
  return w.toBuffer();
}

// ── v4.3.0 — Composing + sending mail ────────────────────────────────────────

/**
 * v4.3.0: RopCreateMessage
 *
 * Payload: CodePageId(uint16) | FolderId(uint64) | AssociatedFlag(uint8)
 *
 * Response: ReturnValue + HasMessageId(1B = 0)
 *
 * We create a draft message handle (messageId = null until SaveChangesMessage),
 * with empty pendingProperties + pendingRecipients accumulation.
 */
export async function handleRopCreateMessage(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input || (input.object.kind !== 'mailbox' && input.object.kind !== 'folder')) {
    return writeMsgError(RopId.CreateMessage, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  const userId = input.object.userId;
  const r = new MapiReader(rop.payload);
  r.readUint16();                       // CodePageId
  const folderId64 = r.readUint64();
  r.readUint8();                        // AssociatedFlag

  // Resolve folder via 64-bit hash
  const folders = await prisma.folder.findMany({
    where: { mailbox: { userId } },
    select: { id: true, name: true },
  });
  const folder = folders.find((f) => cuidToFolderId64(f.id) === folderId64);
  if (!folder) {
    log.warn({ folderId64: folderId64.toString(16), userId }, 'CreateMessage: folder not found');
    return writeMsgError(RopId.CreateMessage, rop, MapiStatusCode.EC_NOT_FOUND);
  }

  // Create draft message handle
  const handle = await putRopObject(sessionToken, {
    kind: 'message',
    userId,
    folderId: folder.id,
    messageId: null,                    // set on SaveChangesMessage
    isDraft: true,
    pendingProperties: {},
    pendingRecipients: [],
  });
  if (handle === null) {
    return writeMsgError(RopId.CreateMessage, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  // Response: RopId + OutputHandleIndex + ReturnValue + HasMessageId(0)
  const w = new MapiWriter();
  w.writeUint8(RopId.CreateMessage);
  w.writeUint8(rop.outputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  w.writeUint8(0);                      // HasMessageId = false (we only deliver the ID on save)
  log.info({ folder: folder.name, handle }, 'RopCreateMessage draft created');
  return w.toBuffer();
}

/**
 * v4.3.0: RopSetProperties
 *
 * Payload: PropertyValueSize(uint16) | PropertyValueCount(uint16) | PropertyValues
 *
 * Response: ReturnValue + PropertyProblemCount(uint16 = 0)
 *
 * We accumulate TaggedPropertyValues in `pendingProperties` on the
 * message handle (stringified tag → unknown). On SaveChangesMessage they
 * are mapped onto the Prisma message.
 */
export async function handleRopSetProperties(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input || input.object.kind !== 'message') {
    return writeMsgError(RopId.SetProperties, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  const r = new MapiReader(rop.payload);
  r.readUint16();                       // PropertyValueSize (byte length)
  const count = r.readUint16();
  const updates: Record<string, unknown> = { ...(input.object.pendingProperties ?? {}) };

  for (let i = 0; i < count; i++) {
    try {
      const tag = r.readUint32();
      const propType = getPropType(tag);
      const value = readPropertyValue(r, propType);
      // JSON-safe encoding for session persistence in Redis
      updates[String(tag)] = jsonifyPropValue(value);
    } catch (err) {
      log.warn({ err, i }, 'SetProperties: property parse error — skipping remainder');
      break;
    }
  }

  await updateRopObject(sessionToken, input.handle, { pendingProperties: updates } as Partial<RopObject>);

  // Response: ReturnValue + PropertyProblemCount(uint16=0)
  const w = new MapiWriter();
  w.writeUint8(RopId.SetProperties);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  w.writeUint16(0);                     // PropertyProblemCount
  log.debug({ count, handle: input.handle }, 'RopSetProperties OK');
  return w.toBuffer();
}

/**
 * v4.3.0: RopModifyRecipients
 *
 * Payload: ColumnCount(uint16) | Columns[ColumnCount] (uint32 each = PropertyTag)
 *        | RowCount(uint16) | Rows[RowCount] (ModifyRecipientRow)
 *
 * Each ModifyRecipientRow:
 *   RowId(uint32) | RecipientType(uint8) | RecipientRow bytes
 *   RecipientRow: RecipientFlags(uint16) | DisplayName byte block | EmailAddress byte block | ...
 *
 * For the v4.3.0 MVP we only extract:
 *   - RecipientType (1=TO, 2=CC, 3=BCC)
 *   - DisplayName + EmailAddress from the columns (typically PR_DISPLAY_NAME_W
 *     + PR_EMAIL_ADDRESS_W or PR_SMTP_ADDRESS_W)
 */
export async function handleRopModifyRecipients(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input || input.object.kind !== 'message') {
    return writeMsgError(RopId.ModifyRecipients, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  const recipients = parseModifyRecipientsPayload(rop.payload);
  await updateRopObject(sessionToken, input.handle, { pendingRecipients: recipients } as Partial<RopObject>);

  const w = new MapiWriter();
  w.writeUint8(RopId.ModifyRecipients);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  log.info({ count: recipients.length, handle: input.handle }, 'RopModifyRecipients OK');
  return w.toBuffer();
}

/**
 * v4.3.0: RopSaveChangesMessage
 *
 * Payload: ResponseHandleIndex(uint8) | SaveFlags(uint8)
 *
 * Response: ReturnValue + InputHandleIndex + FolderId(uint64) + MessageId(uint64)
 *
 * Persists the accumulated properties+recipients to the Prisma DB. For a
 * draft (messageId === null) a new DB record is created; otherwise
 * an update.
 */
export async function handleRopSaveChangesMessage(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input || input.object.kind !== 'message') {
    return writeMsgError(RopId.SaveChangesMessage, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  const handleObj = input.object;
  const props = handleObj.pendingProperties ?? {};
  const recipients = handleObj.pendingRecipients ?? [];

  // Extract properties (tags as string keys, Outlook delivers them as uint32)
  const getProp = (tag: number): unknown => props[String(tag)];
  const subject = String(getProp(PR.PR_SUBJECT_W) ?? '');
  const bodyText = String(getProp(PR.PR_BODY_W) ?? '');
  const bodyHtmlVal = getProp(PR.PR_HTML);
  const bodyHtml = bodyHtmlVal !== undefined ? jsonValueToString(bodyHtmlVal) : '';
  const messageClass = String(getProp(PR.PR_MESSAGE_CLASS_W) ?? 'IPM.Note');

  // Split recipients into toAddrs/ccAddrs/bccAddrs
  const toAddrs = recipients.filter((r) => r.type === 'TO').map((r) => r.address);
  const ccAddrs = recipients.filter((r) => r.type === 'CC').map((r) => r.address);
  const bccAddrs = recipients.filter((r) => r.type === 'BCC').map((r) => r.address);

  // From address from the user's mailbox
  const user = await prisma.user.findUnique({
    where: { id: handleObj.userId },
    select: { email: true, displayName: true },
  });
  if (!user) {
    return writeMsgError(RopId.SaveChangesMessage, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  let newMessageId: string;
  if (handleObj.messageId === null) {
    // New draft: create in the Drafts folder
    const mailbox = await prisma.mailbox.findFirst({
      where: { userId: handleObj.userId },
      select: { id: true, uidNext: true, highestModSeq: true },
    });
    if (!mailbox) {
      return writeMsgError(RopId.SaveChangesMessage, rop, MapiStatusCode.EC_NOT_FOUND);
    }
    const updatedMbx = await prisma.mailbox.update({
      where: { id: mailbox.id },
      data: { uidNext: { increment: 1 }, highestModSeq: { increment: 1 } },
    });
    const uid = updatedMbx.uidNext - 1;
    const modSeq = updatedMbx.highestModSeq;

    const created = await prisma.message.create({
      data: {
        folderId:  handleObj.folderId,
        uid, modSeq,
        flags:     ['\\Draft'],
        subject,
        fromAddr:  user.email,
        fromName:  user.displayName ?? '',
        toAddrs,
        ccAddrs,
        bccAddrs,
        date:      new Date(),
        bodyText,
        bodyHtml,
        rawSize:   bodyText.length + bodyHtml.length,
        changeKey: modSeq.toString(),
      },
      select: { id: true },
    });
    newMessageId = created.id;

    // Increment folder counters
    await prisma.folder.update({
      where: { id: handleObj.folderId },
      data:  { totalCount: { increment: 1 }, changeKey: modSeq.toString() },
    });
  } else {
    // Existing message: update
    await prisma.message.update({
      where: { id: handleObj.messageId },
      data: {
        subject,
        toAddrs, ccAddrs, bccAddrs,
        bodyText, bodyHtml,
      },
    });
    newMessageId = handleObj.messageId;
  }

  // Update handle: set messageId + clear pendings
  await updateRopObject(sessionToken, input.handle, {
    messageId: newMessageId,
    isDraft: false,
    pendingProperties: {},
    pendingRecipients: [],
  } as Partial<RopObject>);

  // Response: ReturnValue + InputHandleIndex + FolderId(uint64) + MessageId(uint64)
  const w = new MapiWriter();
  w.writeUint8(RopId.SaveChangesMessage);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  w.writeUint8(rop.inputHandleIndex ?? 0);   // ResponseHandleIndex
  w.writeUint64(cuidToFolderId64(handleObj.folderId));
  w.writeUint64(cuidToFolderId64(newMessageId));
  log.info({
    messageClass, subject: subject.substring(0, 60), recipientCount: recipients.length, messageId: newMessageId,
  }, 'RopSaveChangesMessage persisted');
  return w.toBuffer();
}

/**
 * v4.3.0: RopSubmitMessage
 *
 * Payload: SubmitFlags(uint8)
 *
 * Response: ReturnValue
 *
 * Submits the message for delivery via the BullMQ smtp-outbound queue.
 * Imports dynamically from @coremail/smtp-server to avoid circular imports.
 */
export async function handleRopSubmitMessage(
  rop: RopRequest,
  sessionToken: string,
  serverObjectHandles: number[],
): Promise<Buffer> {
  const input = await resolveHandleIndex(sessionToken, serverObjectHandles, rop.inputHandleIndex);
  if (!input || input.object.kind !== 'message') {
    return writeMsgError(RopId.SubmitMessage, rop, MapiStatusCode.EC_INVALID_SESSION);
  }
  if (input.object.messageId === null) {
    log.warn({ handle: input.handle }, 'SubmitMessage on unsaved draft');
    return writeMsgError(RopId.SubmitMessage, rop, MapiStatusCode.EC_INVALID_PARAMETER);
  }

  const msg = await prisma.message.findUnique({
    where: { id: input.object.messageId },
    select: {
      id: true, subject: true, fromAddr: true, fromName: true,
      toAddrs: true, ccAddrs: true, bccAddrs: true,
      bodyText: true, bodyHtml: true, messageId: true, date: true,
      attachments: {
        select: { filename: true, mimeType: true, storagePath: true, size: true },
      },
    },
  });
  if (!msg) {
    return writeMsgError(RopId.SubmitMessage, rop, MapiStatusCode.EC_NOT_FOUND);
  }

  // User + domain for the DKIM key
  const user = await prisma.user.findUnique({
    where: { id: input.object.userId },
    select: { id: true, email: true, displayName: true, domain: { select: {
      name: true, dkimPrivateKey: true, dkimSelector: true,
    } } },
  });
  if (!user) {
    return writeMsgError(RopId.SubmitMessage, rop, MapiStatusCode.EC_INVALID_SESSION);
  }

  const trackingId = `mapi-${msg.id}`;
  const smtpRecipients = [...(msg.toAddrs ?? []), ...(msg.ccAddrs ?? []), ...(msg.bccAddrs ?? [])];
  const internetMessageId = msg.messageId ?? `<${trackingId}@${user.domain.name}>`;

  try {
    const queue = getMapiOutboundQueue();
    await queue.add('send', {
      messageId:    trackingId,
      from:         msg.fromAddr,
      to:           smtpRecipients,
      senderUserId: user.id,
      ...(user.domain.dkimPrivateKey ? {
        dkimDomain:     user.domain.name,
        dkimSelector:   user.domain.dkimSelector ?? 'mail',
        dkimPrivateKey: user.domain.dkimPrivateKey,
      } : {}),
      message: {
        from:        msg.fromAddr,
        fromName:    msg.fromName ?? '',
        to:          msg.toAddrs ?? [],
        cc:          msg.ccAddrs ?? [],
        bcc:         msg.bccAddrs ?? [],
        subject:     msg.subject,
        html:        msg.bodyHtml ?? '',
        text:        msg.bodyText ?? '',
        messageId:   internetMessageId,
        date:        (msg.date ?? new Date()).toISOString(),
        attachments: (msg.attachments ?? []).map((a) => ({
          filename:    a.filename,
          minioPath:   a.storagePath,
          contentType: a.mimeType,
          size:        a.size,
        })),
      },
    }, { jobId: trackingId });
  } catch (err) {
    log.error({ err, msgId: msg.id }, 'SubmitMessage: queue add failed');
    return writeMsgError(RopId.SubmitMessage, rop, MapiStatusCode.EC_NOT_SUPPORTED);
  }

  // Move mail to "Sent": folder lookup → update
  try {
    const sent = await prisma.folder.findFirst({
      where: { mailbox: { userId: user.id }, name: 'Sent' },
      select: { id: true },
    });
    if (sent) {
      await prisma.message.update({
        where: { id: msg.id },
        data: { folderId: sent.id, flags: ['\\Seen'] },
      });
    }
  } catch (e) {
    log.warn({ err: e, msgId: msg.id }, 'SubmitMessage: move to Sent failed (non-fatal)');
  }

  // Response: ReturnValue
  const w = new MapiWriter();
  w.writeUint8(RopId.SubmitMessage);
  w.writeUint8(rop.inputHandleIndex ?? 0);
  w.writeUint32(MapiStatusCode.SUCCESS);
  log.info({ msgId: msg.id, recipientCount: smtpRecipients.length, trackingId }, 'RopSubmitMessage enqueued to outbound queue');
  return w.toBuffer();
}

// ── Helpers v4.3.0 ────────────────────────────────────────────────────────

/**
 * Parses the MS-OXCMSG §2.2.3.1.2 RopModifyRecipients payload.
 *
 * Format:
 *   ColumnCount(uint16) | Columns[ColumnCount] (uint32 each = PropertyTag)
 *   RowCount(uint16) | Rows[RowCount]
 *
 * Each row (ModifyRecipientRow):
 *   RowId(uint32) | RecipientType(uint8) | RecipientRow bytes
 *
 * The RecipientRow is itself a variable structure — we only extract what is
 * necessary (DisplayName + EmailAddress). On parse errors we abort the
 * loop and return the recipients parsed so far.
 */
function parseModifyRecipientsPayload(payload: Buffer): Array<{
  type: 'TO' | 'CC' | 'BCC'; name: string; address: string;
}> {
  const recipients: Array<{ type: 'TO' | 'CC' | 'BCC'; name: string; address: string }> = [];
  if (payload.length < 4) return recipients;
  try {
    const r = new MapiReader(payload);
    const columnCount = r.readUint16();
    const columnTags: number[] = [];
    for (let i = 0; i < columnCount; i++) {
      columnTags.push(r.readUint32());
    }
    const rowCount = r.readUint16();

    for (let i = 0; i < rowCount; i++) {
      r.readUint32();                       // RowId
      const recType = r.readUint8();        // 1=TO, 2=CC, 3=BCC
      // RecipientRow header
      const recipientFlags = r.readUint16();
      // If the R flag is set, PR_ADDRTYPE follows
      const hasAddrType = (recipientFlags & 0x0008) !== 0;
      const hasEmailAddr = (recipientFlags & 0x0010) !== 0;
      const hasDispName = (recipientFlags & 0x0020) !== 0;
      const hasSimpleDispName = (recipientFlags & 0x0400) !== 0;
      const hasTransmittableDispName = (recipientFlags & 0x0080) !== 0;

      if (hasAddrType) r.readUtf16String();                // PR_ADDRTYPE_W
      const emailAddress = hasEmailAddr ? r.readUtf16String() : '';
      const displayName = hasDispName ? r.readUtf16String() : '';
      if (hasSimpleDispName) r.readUtf16String();
      if (hasTransmittableDispName) r.readUtf16String();

      // Properties (column-values)
      r.readUint16();                       // RecipientColumnCount (Outlook sets this)
      // We skip the property parsing (complex). If no e-mail was obtained
      // from the header bytes, we use DisplayName as a
      // fallback (Outlook types e.g. "User Name <name@dom.de>")
      const addr = emailAddress || extractEmailFromName(displayName) || displayName;

      const type: 'TO' | 'CC' | 'BCC' = recType === 2 ? 'CC' : recType === 3 ? 'BCC' : 'TO';
      if (addr) {
        recipients.push({ type, name: displayName, address: addr });
      }
    }
  } catch (err) {
    log.warn({ err, parsedCount: recipients.length }, 'parseModifyRecipientsPayload: aborted early');
  }
  return recipients;
}

function extractEmailFromName(s: string): string | null {
  const m = s.match(/<([^<>@\s]+@[^<>@\s]+)>/);
  return m?.[1] ?? null;
}

/**
 * Converts a property value for JSON persistence into a form suitable for
 * session state (Buffer → { type:'Buffer', data:[...] }, BigInt → String).
 */
function jsonifyPropValue(value: unknown): unknown {
  if (value instanceof Buffer) {
    return { _t: 'Buffer', data: Array.from(value) };
  }
  if (typeof value === 'bigint') {
    return { _t: 'BigInt', v: value.toString() };
  }
  if (value instanceof Date) {
    return { _t: 'Date', iso: value.toISOString() };
  }
  return value;
}

function jsonValueToString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Buffer) return value.toString('utf-8');
  if (typeof value === 'object' && value !== null) {
    const v = value as { _t?: string; data?: number[] };
    if (v._t === 'Buffer' && Array.isArray(v.data)) {
      return Buffer.from(v.data).toString('utf-8');
    }
  }
  return String(value ?? '');
}
