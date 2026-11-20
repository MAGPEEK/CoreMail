/**
 * Message ROPs (MS-OXCMSG 2.2.3, MS-OXOMSG 2.2.3.1): RopOpenMessage,
 * RopCreateMessage, RopSaveChangesMessage, RopModifyRecipients,
 * RopSetMessageReadFlag, RopSubmitMessage and the attachment ROPs
 * RopGetAttachmentTable, RopOpenAttachment, RopCreateAttachment,
 * RopSaveChangesAttachment.
 *
 * Storage model: a message created by the client lives in the session until
 * RopSaveChangesMessage writes it as a draft (raw MIME through the message
 * store) or RopSubmitMessage sends it. Messages created in the Outbox and
 * folder-associated messages stay in the session. Saving an opened received
 * message does not rewrite it (CoreMail keeps the original MIME).
 */
import { Ec, RopError, RopId } from '../codes.js';
import {
  assertMemory, assertWritable, defineRop, NeedsMoreSpace, objectOf, okResponse, putObject, type RopDef,
} from '../context.js';
import { valueBytes } from '../../objects/footprint.js';
import { lookupProperty, setProperty, stringProp, type PropertyBag } from '../../props/bag.js';
import { MessageFlag, RecipientKind, Tag } from '../../props/tags.js';
import { makeId } from '../../ids.js';
import { messageCounter } from '../../ics/keys.js';
import {
  messageSummaryBag, newAttachment, newMessageBag, recipientsFromRow, splitSubject,
} from '../../objects/props.js';
import { counterOf, folderNode, keepMessageId, messagesByIds, refreshView } from './common.js';
import { ensureContent } from './content.js';
import { composeMessage } from './compose.js';
import { saveImported } from './sync-import.js';
import { readRecipientRow, writeSmtpRecipientRow, writeTypedString, type ParsedRecipientRow } from './recipients.js';
import type { LogonState, MessageState, RecipientState, TableState } from '../../objects/state.js';
import { MailboxFullError, type MailStore } from '../../store/types.js';
import type { BufferReader } from '../../wire/reader.js';

const OPEN_READ_ONLY = 0x00;
const DRAFT_FLAG = '\\Draft';
/**
 * Per-message caps (the submission limits of the user still apply when the
 * message is sent; the session memory budget bounds what a client can pile up):
 *  - attachments: RopCreateAttachment beyond the cap → ecMaxAttachmentExceeded
 *    (MS-OXCMSG 3.2.5.13);
 *  - recipients: RopModifyRecipients has no count error (MS-OXCMSG 3.2.5.5) —
 *    the memory budget protects it; the hard cap is checked at RopSubmitMessage
 *    with ecTooManyRecips (MS-OXCDATA 2.4.1), as high as the largest per-mailbox
 *    recipient limit (storage MAX_FLOW_RECIPIENTS).
 */
export const MAX_RECIPIENTS = 10_000;
export const MAX_ATTACHMENTS = 250;

/** Message properties including the recipient display strings. */
export function messageBagWithRecipients(message: MessageState): PropertyBag {
  const bag = new Map(message.props);
  if (message.summary === null || message.contentLoaded) {
    const display = (t: number): string => message.recipients.filter((r) => r.type === t).map((r) => r.displayName || r.email).join('; ');
    bag.set(Tag.DisplayTo, display(RecipientKind.To));
    bag.set(Tag.DisplayCc, display(RecipientKind.Cc));
    bag.set(Tag.DisplayBcc, display(RecipientKind.Bcc));
  }
  const attached = message.attachments.some((a) => a.saved);
  bag.set(Tag.HasAttachments, attached);
  const flags = lookupProperty(bag, Tag.MessageFlags);
  const base = flags.found && 'value' in flags && typeof flags.value === 'number' ? flags.value : 0;
  bag.set(Tag.MessageFlags, attached ? base | MessageFlag.HasAttach : base & ~MessageFlag.HasAttach);
  return bag;
}

function isDraft(message: MessageState): boolean {
  return message.summary === null || message.summary.flags.includes(DRAFT_FLAG);
}

// ── RopOpenMessage ───────────────────────────────────────────────────────────

/** OpenRecipientRow header (7) + SMTP RecipientRow (flags, two strings, column count, row flag). */
function openRecipientRowSize(r: RecipientState): number {
  return 7 + 2 + (r.email.length + 1) * 2 + ((r.displayName || r.email).length + 1) * 2 + 2 + 1;
}

interface OpenReq { inputIndex: number; outputIndex: number; folderId: bigint; mode: number; messageId: bigint }

/** RopId … ReturnValue (6) + HasNamedProperties (1) + 2 TypedStrings (≥2) + counts (5). */
const OPEN_MIN = 14;

export const ropOpenMessage = defineRop<OpenReq>({
  id: RopId.OpenMessage,
  name: 'RopOpenMessage',
  parse(r) {
    const inputIndex = r.u8();
    const outputIndex = r.u8();
    r.u16(); // CodePageId
    const folderId = r.u64();
    const mode = r.u8();
    return { inputIndex, outputIndex, folderId, mode, messageId: r.u64() };
  },
  responseIndex: (req) => req.outputIndex,
  async execute(ctx, req) {
    const { logon } = objectOf(ctx, req.inputIndex, 'logon', 'folder');
    await refreshView(ctx.store, logon);
    const folderCounter = counterOf(req.folderId);
    const node = folderNode(logon, folderCounter);
    // Special folders (Outbox …) hold no stored messages.
    const summary = node.record ? (await messagesByIds(ctx.store, node.record.id, [req.messageId]))[0] : undefined;
    if (!summary) throw new RopError(Ec.NotFound, 'message not found');
    const message: MessageState = {
      folderCounter, counter: messageCounter(summary), summary,
      props: messageSummaryBag(logon, folderCounter, summary),
      recipients: recipientsFromRow(summary, null), attachments: [], nextAttachNum: 0,
      readOnly: req.mode === OPEN_READ_ONLY || logon.mailbox.readOnly,
      contentLoaded: false, submitted: false, associated: false, imported: null,
    };
    putObject(ctx, req.outputIndex, { kind: 'message', logon, message }, req.logonId);

    const { prefix, normalized } = splitSubject(summary.subject);
    const w = okResponse(RopId.OpenMessage, req.outputIndex).u8(0);
    writeTypedString(w, prefix);
    writeTypedString(w, normalized);
    const rows: RecipientState[] = [];
    let rowBytes = 0;
    const room = ctx.budget - w.length - 5;
    if (room < 0) throw new NeedsMoreSpace(OPEN_MIN);
    for (const rcpt of message.recipients.slice(0, 255)) {
      const size = openRecipientRowSize(rcpt);
      if (rowBytes + size > room) break;
      rows.push(rcpt);
      rowBytes += size;
    }
    // RecipientCount = rows sent, so the client never needs RopReadRecipients.
    w.u16(rows.length).u16(0).u8(rows.length);
    for (const rcpt of rows) {
      w.u8(rcpt.type).u16(0x04e4).u16(0);
      const sizeAt = w.length;
      w.u16(0);
      writeSmtpRecipientRow(w, rcpt.displayName, rcpt.email);
      w.patchU16(sizeAt, w.length - sizeAt - 2);
    }
    return w.toBuffer();
  },
});

// ── RopCreateMessage ─────────────────────────────────────────────────────────

interface CreateReq { inputIndex: number; outputIndex: number; folderId: bigint; associated: boolean }

export const ropCreateMessage = defineRop<CreateReq>({
  id: RopId.CreateMessage,
  name: 'RopCreateMessage',
  parse(r) {
    const inputIndex = r.u8();
    const outputIndex = r.u8();
    r.u16(); // CodePageId
    const folderId = r.u64();
    return { inputIndex, outputIndex, folderId, associated: r.u8() !== 0 };
  },
  responseIndex: (req) => req.outputIndex,
  async execute(ctx, req) {
    const { logon } = objectOf(ctx, req.inputIndex, 'logon', 'folder');
    assertWritable(logon);
    const folderCounter = counterOf(req.folderId);
    const node = folderNode(logon, folderCounter);
    if (!node.record && node.special !== 'outbox') throw new RopError(Ec.AccessDenied, 'messages cannot be created here');
    const counter = ctx.session.nextDraftCounter();
    const message: MessageState = {
      folderCounter, counter, summary: null, props: newMessageBag(logon, folderCounter, counter, ctx.now()),
      recipients: [], attachments: [], nextAttachNum: 0, readOnly: false, contentLoaded: true,
      submitted: false, associated: req.associated, imported: null,
    };
    putObject(ctx, req.outputIndex, { kind: 'message', logon, message }, req.logonId);
    return okResponse(RopId.CreateMessage, req.outputIndex).u8(0).toBuffer();
  },
});

// ── RopSaveChangesMessage ────────────────────────────────────────────────────

interface SaveReq { responseIndex: number; inputIndex: number; saveFlags: number }

async function persistDraft(store: MailStore, logon: LogonState, message: MessageState): Promise<void> {
  const node = folderNode(logon, message.folderCounter);
  if (message.associated || !node.record || !isDraft(message)) return;
  const composed = await composeMessage(store, message);
  const previous = message.summary;
  const saved = await store.saveDraft(logon.mailbox, node.record.id, composed, previous).catch((err: unknown) => {
    throw err instanceof MailboxFullError ? new RopError(Ec.QuotaExceeded, err.message) : err;
  });
  // A draft the client created in cached mode keeps the ID it assigned.
  message.summary = previous?.clientId != null ? await keepMessageId(store, logon.mailbox.mailboxId, previous, saved, previous.pcl) : saved;
  message.counter = messageCounter(message.summary);
  setProperty(message.props, Tag.Mid, makeId(message.counter));
}

export const ropSaveChangesMessage = defineRop<SaveReq>({
  id: RopId.SaveChangesMessage,
  name: 'RopSaveChangesMessage',
  parse: (r) => ({ responseIndex: r.u8(), inputIndex: r.u8(), saveFlags: r.u8() }),
  responseIndex: (req) => req.responseIndex,
  async execute(ctx, req) {
    const { logon, message } = objectOf(ctx, req.inputIndex, 'message');
    if (message.readOnly || message.submitted) throw new RopError(Ec.AccessDenied, 'message is read-only');
    assertWritable(logon);
    await refreshView(ctx.store, logon);
    if (message.imported) await saveImported(ctx.store, logon, message);
    else await persistDraft(ctx.store, logon, message);
    return okResponse(RopId.SaveChangesMessage, req.responseIndex).u8(req.inputIndex).u64(makeId(message.counter)).toBuffer();
  },
});

// ── RopModifyRecipients ──────────────────────────────────────────────────────

interface ModifyRow { rowId: number; type: number; row: ParsedRecipientRow | null }
interface ModifyReq { inputIndex: number; rows: ModifyRow[] }

function recipientRowBytes(row: ParsedRecipientRow): number {
  let n = 64 + valueBytes(row.displayName ?? '') + valueBytes(row.emailAddress ?? '') + valueBytes(row.x500Dn ?? '');
  for (const v of row.props.values()) n += valueBytes(v);
  return n;
}

export const ropModifyRecipients = defineRop<ModifyReq>({
  id: RopId.ModifyRecipients,
  name: 'RopModifyRecipients',
  parse(r: BufferReader) {
    const inputIndex = r.u8();
    const columns: number[] = [];
    const nCols = r.u16();
    for (let i = 0; i < nCols; i++) columns.push(r.u32());
    const nRows = r.u16();
    const rows: ModifyRow[] = [];
    for (let i = 0; i < nRows; i++) {
      const rowId = r.u32();
      const type = r.u8() & 0x0f;
      const size = r.u16();
      rows.push({ rowId, type, row: size > 0 ? readRecipientRow(r.slice(size), columns) : null });
    }
    return { inputIndex, rows };
  },
  responseIndex: (req) => req.inputIndex,
  async execute(ctx, req) {
    const { logon, message } = objectOf(ctx, req.inputIndex, 'message');
    assertWritable(logon);
    if (message.readOnly || message.submitted) throw new RopError(Ec.AccessDenied, 'message is read-only');
    // Rows are replaced by RowId; a row without data removes the recipient.
    const kept = new Map(message.recipients.map((r) => [r.rowId, r]));
    const changed = new Map<number, ModifyRow & { row: ParsedRecipientRow }>();
    for (const m of req.rows) {
      kept.delete(m.rowId);
      changed.delete(m.rowId);
      if (m.row) changed.set(m.rowId, { ...m, row: m.row });
    }
    assertMemory(ctx, [...changed.values()].reduce((n, m) => n + recipientRowBytes(m.row), 0));
    for (const m of changed.values()) {
      const email = await recipientAddress(ctx.store, m.row);
      kept.set(m.rowId, {
        rowId: m.rowId, type: m.type, email: email ?? '', displayName: m.row.displayName ?? email ?? '', props: m.row.props,
      });
    }
    message.recipients = [...kept.values()].sort((a, b) => a.rowId - b.rowId);
    return okResponse(RopId.ModifyRecipients, req.inputIndex).toBuffer();
  },
});

/** SMTP address of a recipient row: PidTagSmtpAddress, an SMTP address, or a resolved X500 DN. */
async function recipientAddress(store: MailStore, row: ParsedRecipientRow): Promise<string | null> {
  const smtp = stringProp(row.props, Tag.SmtpAddress);
  if (smtp) return smtp;
  if (row.addressType.toUpperCase() === 'SMTP' && row.emailAddress) return row.emailAddress;
  const propType = stringProp(row.props, Tag.AddressType);
  const propAddr = stringProp(row.props, Tag.EmailAddress);
  if (propType?.toUpperCase() === 'SMTP' && propAddr) return propAddr;
  const dn = row.x500Dn ?? (propType?.toUpperCase() === 'EX' ? propAddr ?? null : null);
  return dn ? store.resolveLegacyDn(dn) : null;
}

// ── RopSetMessageReadFlag ────────────────────────────────────────────────────

const CLEAR_READ_FLAG = 0x04;
const RECEIPT_ONLY_FLAGS = 0x10 | 0x20 | 0x40;

interface ReadFlagReq { responseIndex: number; inputIndex: number; readFlags: number }

export const ropSetMessageReadFlag = defineRop<ReadFlagReq>({
  id: RopId.SetMessageReadFlag,
  name: 'RopSetMessageReadFlag',
  // ClientData is only present for public-folder logons, which this server does not offer.
  parse: (r) => ({ responseIndex: r.u8(), inputIndex: r.u8(), readFlags: r.u8() }),
  responseIndex: (req) => req.responseIndex,
  async execute(ctx, req) {
    const { logon, message } = objectOf(ctx, req.inputIndex, 'message');
    if ((req.readFlags & RECEIPT_ONLY_FLAGS) === 0) {
      const read = (req.readFlags & CLEAR_READ_FLAG) === 0;
      if (message.summary) {
        assertWritable(logon);
        await ctx.store.setRead(logon.mailbox, message.summary, read);
        const flags = message.summary.flags.filter((f) => f !== '\\Seen');
        message.summary = { ...message.summary, flags: read ? [...flags, '\\Seen'] : flags };
      }
      const current = lookupProperty(message.props, Tag.MessageFlags);
      const base = current.found && 'value' in current && typeof current.value === 'number' ? current.value : 0;
      message.props.set(Tag.MessageFlags, read ? base | MessageFlag.Read : base & ~MessageFlag.Read);
      message.props.set(Tag.Read, read);
    }
    return okResponse(RopId.SetMessageReadFlag, req.responseIndex).u8(0).toBuffer();
  },
});

// ── RopSubmitMessage ─────────────────────────────────────────────────────────

interface SubmitReq { inputIndex: number; submitFlags: number }

/** MS-OXOMSG, Receiving a RopSubmitMessage ROP Request (error codes). */
const SUBMIT_ERRORS = {
  'no-recipients': Ec.NoRecipients,
  'too-many-recipients': Ec.TooManyRecips,
  'too-large': Ec.MaxSubmissionExceeded,
  'sender-not-allowed': Ec.AccessDenied,
  'over-quota': Ec.QuotaExceeded,
  'read-only': Ec.AccessDenied,
  // 10.5: the hourly send rate (storage submission-rate.ts) is a submission quota
  'rate-limited': Ec.QuotaExceeded,
} as const;

export const ropSubmitMessage = defineRop<SubmitReq>({
  id: RopId.SubmitMessage,
  name: 'RopSubmitMessage',
  parse: (r) => ({ inputIndex: r.u8(), submitFlags: r.u8() }),
  responseIndex: (req) => req.inputIndex,
  async execute(ctx, req) {
    const { logon, message } = objectOf(ctx, req.inputIndex, 'message');
    if (message.submitted) throw new RopError(Ec.AccessDenied, 'already submitted');
    if (message.associated) throw new RopError(Ec.AccessDenied, 'folder associated information cannot be sent');
    if (message.readOnly || !isDraft(message)) throw new RopError(Ec.AccessDenied, 'only unsent messages can be submitted');
    if (message.recipients.length > MAX_RECIPIENTS) throw new RopError(Ec.TooManyRecips, `more than ${MAX_RECIPIENTS} recipients`);
    const composed = await composeMessage(ctx.store, message);
    const deleteAfter = lookupProperty(message.props, Tag.DeleteAfterSubmit);
    const result = await ctx.store.submit(ctx.session.user, logon.mailbox, composed, {
      saveCopy: !(deleteAfter.found && 'value' in deleteAfter && deleteAfter.value === true),
      draft: message.summary,
    });
    if (!result.ok) throw new RopError(SUBMIT_ERRORS[result.reason], `submit refused: ${result.reason}`);
    message.submitted = true;
    return okResponse(RopId.SubmitMessage, req.inputIndex).toBuffer();
  },
});

// ── Attachments ──────────────────────────────────────────────────────────────

interface TableReq { inputIndex: number; outputIndex: number; tableFlags: number }

export const ropGetAttachmentTable = defineRop<TableReq>({
  id: RopId.GetAttachmentTable,
  name: 'RopGetAttachmentTable',
  parse: (r) => ({ inputIndex: r.u8(), outputIndex: r.u8(), tableFlags: r.u8() }),
  responseIndex: (req) => req.outputIndex,
  async execute(ctx, req) {
    const { logon, message } = objectOf(ctx, req.inputIndex, 'message');
    await ensureContent(ctx.store, message);
    const table: TableState = {
      source: { kind: 'attachments', message }, columns: [], sort: [], restriction: null, position: 0, rows: null, notify: false,
    };
    putObject(ctx, req.outputIndex, { kind: 'table', logon, table }, req.logonId);
    return okResponse(RopId.GetAttachmentTable, req.outputIndex).toBuffer();
  },
});

interface OpenAttachmentReq { inputIndex: number; outputIndex: number; attachmentId: number }

export const ropOpenAttachment = defineRop<OpenAttachmentReq>({
  id: RopId.OpenAttachment,
  name: 'RopOpenAttachment',
  parse(r) {
    const inputIndex = r.u8();
    const outputIndex = r.u8();
    r.u8(); // OpenAttachmentFlags
    return { inputIndex, outputIndex, attachmentId: r.u32() };
  },
  responseIndex: (req) => req.outputIndex,
  async execute(ctx, req) {
    const { logon, message } = objectOf(ctx, req.inputIndex, 'message');
    await ensureContent(ctx.store, message);
    const attachment = message.attachments.find((a) => a.num === req.attachmentId);
    if (!attachment) throw new RopError(Ec.NotFound, 'attachment not found');
    putObject(ctx, req.outputIndex, { kind: 'attachment', logon, message, attachment }, req.logonId);
    return okResponse(RopId.OpenAttachment, req.outputIndex).toBuffer();
  },
});

interface CreateAttachmentReq { inputIndex: number; outputIndex: number }

export const ropCreateAttachment = defineRop<CreateAttachmentReq>({
  id: RopId.CreateAttachment,
  name: 'RopCreateAttachment',
  parse: (r) => ({ inputIndex: r.u8(), outputIndex: r.u8() }),
  responseIndex: (req) => req.outputIndex,
  async execute(ctx, req) {
    const { logon, message } = objectOf(ctx, req.inputIndex, 'message');
    assertWritable(logon);
    if (message.readOnly || message.submitted) throw new RopError(Ec.AccessDenied, 'message is read-only');
    await ensureContent(ctx.store, message);
    if (message.attachments.length >= MAX_ATTACHMENTS) throw new RopError(Ec.MaxAttachmentExceeded, `more than ${MAX_ATTACHMENTS} attachments`);
    const attachment = newAttachment(message.nextAttachNum++);
    message.attachments.push(attachment);
    putObject(ctx, req.outputIndex, { kind: 'attachment', logon, message, attachment }, req.logonId);
    return okResponse(RopId.CreateAttachment, req.outputIndex).u32(attachment.num).toBuffer();
  },
});

interface SaveAttachmentReq { responseIndex: number; inputIndex: number; saveFlags: number }

export const ropSaveChangesAttachment = defineRop<SaveAttachmentReq>({
  id: RopId.SaveChangesAttachment,
  name: 'RopSaveChangesAttachment',
  parse: (r) => ({ responseIndex: r.u8(), inputIndex: r.u8(), saveFlags: r.u8() }),
  responseIndex: (req) => req.responseIndex,
  async execute(ctx, req) {
    const { attachment } = objectOf(ctx, req.inputIndex, 'attachment');
    attachment.saved = true;
    return okResponse(RopId.SaveChangesAttachment, req.responseIndex).toBuffer();
  },
});

export const messageRops: RopDef[] = [
  ropOpenMessage, ropCreateMessage, ropSaveChangesMessage, ropModifyRecipients, ropSetMessageReadFlag,
  ropSubmitMessage, ropGetAttachmentTable, ropOpenAttachment, ropCreateAttachment, ropSaveChangesAttachment,
];
