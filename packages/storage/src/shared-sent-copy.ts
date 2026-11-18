/**
 * Mail sent as / on behalf of a Shared Mailbox (9.4) — one helper for every
 * sending path (webmail and JMAP through the outbound worker, SMTP submission,
 * ActiveSync):
 *
 *  - classifies the message: From: names a Shared Mailbox (primary address or
 *    alias) the user holds SEND_AS / FULL_ACCESS on → "send as"; From: names a
 *    box the user holds SEND_ON_BEHALF on and Sender: names the user → "send on
 *    behalf";
 *  - writes the mailbox access audit entry (mailbox.foreign.send_as /
 *    send_on_behalf, mailbox-access-audit.ts);
 *  - when the box has the matching switch on (SharedMailbox.sentCopySendAs /
 *    sentCopySendOnBehalf), stores a copy in the box's Sent folder through the
 *    message store (raw original kept) — in addition to the sender's own Sent.
 *
 * Runs after the message was accepted for sending and never throws.
 */
import { createLogger } from '@coremail/core';
import { prisma } from './prisma/index.js';
import { parseRawMessage } from './mime/index.js';
import { findBodyStart, parseHeaderFields } from './mime/tree.js';
import { addressesOf } from './mime/address.js';
import { storeRawMessage } from './raw-message-default.js';
import { truncateBodyColumn } from './raw-message.js';
import { createMessage } from './message-store.js';
import { deferMailboxChanges } from './realtime/change-scope.js';
import { uploadBuffer, attachmentKey } from './minio/index.js';
import { normalizeSenderAddress } from './sender-identity.js';
import { recordMailboxAccess, type MailboxAccessSource } from './mailbox-access-audit.js';

const log = createLogger('storage:shared-sent-copy');

export type ForeignSendMode = 'send_as' | 'send_on_behalf';

/** What the user may do with one Shared Mailbox when sending. */
export interface SendGrant {
  sharedMailboxId: string;
  email: string;
  /** Primary address and active aliases, lower case. */
  addresses: string[];
  mailboxId: string | null;
  sendAs: boolean;
  onBehalf: boolean;
  copySendAs: boolean;
  copySendOnBehalf: boolean;
}

export interface ForeignSend { mode: ForeignSendMode; grant: SendGrant }

/**
 * Pure: is a message with these From: / Sender: addresses sent as or on behalf
 * of a Shared Mailbox? null for the user's own addresses and anything the user
 * holds no send permission for.
 */
export function classifyForeignSend(
  from: string | null,
  sender: string | null,
  ownAddresses: readonly string[],
  grants: readonly SendGrant[],
): ForeignSend | null {
  const f = normalizeSenderAddress(from ?? '');
  if (!f) return null;
  const own = new Set(ownAddresses.map(normalizeSenderAddress));
  if (own.has(f)) return null;
  const grant = grants.find((g) => g.addresses.includes(f));
  if (!grant) return null;
  const s = normalizeSenderAddress(sender ?? '');
  if (s && s !== f && own.has(s) && grant.onBehalf) return { mode: 'send_on_behalf', grant };
  if (grant.sendAs) return { mode: 'send_as', grant };
  return null;
}

/** Pure: should the box keep a copy of this send? */
export function wantsSentCopy(send: ForeignSend): boolean {
  return send.mode === 'send_as' ? send.grant.copySendAs : send.grant.copySendOnBehalf;
}

interface GrantRow {
  permission: string;
  sharedMailbox: {
    id: string; email: string; sentCopySendAs: boolean; sentCopySendOnBehalf: boolean;
    aliases: Array<{ address: string }>; mailbox: { id: string } | null;
  };
}

/** Pure: one grant per box from the permission rows. */
export function grantsFromRows(rows: readonly GrantRow[]): SendGrant[] {
  const out = new Map<string, SendGrant>();
  for (const r of rows) {
    const b = r.sharedMailbox;
    const g = out.get(b.id) ?? {
      sharedMailboxId: b.id,
      email: b.email.toLowerCase(),
      addresses: [b.email, ...b.aliases.map((a) => a.address)].map(normalizeSenderAddress),
      mailboxId: b.mailbox?.id ?? null,
      sendAs: false,
      onBehalf: false,
      copySendAs: b.sentCopySendAs === true,
      copySendOnBehalf: b.sentCopySendOnBehalf === true,
    };
    if (r.permission === 'SEND_AS' || r.permission === 'FULL_ACCESS') g.sendAs = true;
    if (r.permission === 'SEND_ON_BEHALF') g.onBehalf = true;
    out.set(b.id, g);
  }
  return [...out.values()];
}

/** Pure: the first From: and Sender: addresses of a raw message. */
export function headerSenders(raw: Buffer): { from: string | null; sender: string | null } {
  const s = raw.subarray(0, Math.min(raw.length, 256 * 1024)).toString('latin1');
  const fields = parseHeaderFields(s, 0, findBodyStart(s, 0, s.length));
  const first = (name: string): string | null => {
    const f = fields.find((x) => x.name.toLowerCase() === name);
    return f ? (addressesOf(f.value)[0] ?? null) : null;
  };
  return { from: first('from'), sender: first('sender') };
}

async function loadSendContext(userId: string): Promise<{ email: string; own: string[]; grants: SendGrant[] } | null> {
  const user = await prisma.user.findFirst({ where: { id: userId, active: true }, select: { email: true } });
  if (!user) return null;
  const [aliases, rows] = await Promise.all([
    prisma.emailAlias.findMany({ where: { targetUserId: userId, active: true }, select: { address: true } }),
    prisma.sharedMailboxPerm.findMany({
      where: { userId, permission: { in: ['FULL_ACCESS', 'SEND_AS', 'SEND_ON_BEHALF'] }, sharedMailbox: { active: true } },
      select: {
        permission: true,
        sharedMailbox: {
          select: {
            id: true, email: true, sentCopySendAs: true, sentCopySendOnBehalf: true,
            aliases: { where: { active: true }, select: { address: true } },
            mailbox: { select: { id: true } },
          },
        },
      },
    }),
  ]);
  return { email: user.email, own: [user.email, ...aliases.map((a) => a.address)], grants: grantsFromRows(rows as GrantRow[]) };
}

/**
 * Stores `raw` in the Sent folder of `mailboxId` (\Seen, raw original kept,
 * attachment rows). Returns the new message id, or null without a Sent folder.
 * The realtime announcement follows once the attachments and the folder
 * counter are written (deferMailboxChanges).
 */
export function storeRawInSentFolder(mailboxId: string, raw: Buffer): Promise<string | null> {
  return deferMailboxChanges(() => storeInSentFolder(mailboxId, raw));
}

async function storeInSentFolder(mailboxId: string, raw: Buffer): Promise<string | null> {
  const sent =await prisma.folder.findFirst({ where: { mailboxId, name: 'Sent' }, select: { id: true } });
  if (!sent) return null;
  const parsed = await parseRawMessage(raw);
  const { storagePath } = await storeRawMessage(raw);
  // UID + modSeq are allocated atomically by the message store.
  const msg = await prisma.$transaction((tx) => createMessage(tx, mailboxId, sent.id, {
    flags: ['\\Seen'],
    subject: parsed.subject,
    fromAddr: parsed.fromAddr,
    fromName: parsed.fromName,
    toAddrs: parsed.toAddrs,
    ccAddrs: parsed.ccAddrs,
    bccAddrs: parsed.bccAddrs,
    replyTo: parsed.replyTo,
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    date: parsed.date,
    bodyText: truncateBodyColumn(parsed.bodyText),
    bodyHtml: truncateBodyColumn(parsed.bodyHtml),
    rawSize: raw.length,
    storagePath,
  }));
  for (const [index, att] of parsed.attachments.entries()) {
    const key = attachmentKey(msg.id, `${index}-${att.sha256.slice(0, 16)}`);
    await uploadBuffer(key, att.buffer, att.mimeType);
    await prisma.attachment.create({
      data: {
        messageId: msg.id, contentId: att.contentId, filename: att.filename, mimeType: att.mimeType,
        size: att.size, sha256: att.sha256, storagePath: key, inline: att.inline,
      },
    });
  }
  await prisma.folder.update({ where: { id: sent.id }, data: { totalCount: { increment: 1 }, changeKey: msg.modSeq.toString() } });
  return msg.id;
}

export interface AfterForeignSendInput {
  userId: string;
  /** The message as sent (unsigned original). */
  raw: Buffer;
  source: MailboxAccessSource;
  ipAddress?: string;
  /**
   * false: audit only — the message is already stored in the Shared Mailbox
   * (JMAP submission from the Shared Mailbox account). Default true.
   */
  sentCopy?: boolean;
}

export interface AfterForeignSendResult { mode: ForeignSendMode; sharedMailboxId: string; copyMessageId: string | null }

/**
 * Audit + optional Sent copy of a message sent as / on behalf of a Shared
 * Mailbox. null when the message is the user's own. Never throws.
 */
export async function afterForeignSend(input: AfterForeignSendInput): Promise<AfterForeignSendResult | null> {
  try {
    const ctx = await loadSendContext(input.userId);
    if (!ctx || ctx.grants.length === 0) return null;
    const { from, sender } = headerSenders(input.raw);
    const send = classifyForeignSend(from, sender, ctx.own, ctx.grants);
    if (!send) return null;
    const { grant } = send;
    await recordMailboxAccess({
      actorId: input.userId,
      actorEmail: ctx.email,
      target: { kind: 'shared', sharedMailboxId: grant.sharedMailboxId, mailboxId: grant.mailboxId ?? '', email: grant.email },
      action: send.mode === 'send_as' ? 'mailbox.foreign.send_as' : 'mailbox.foreign.send_on_behalf',
      source: input.source,
      changes: { from: normalizeSenderAddress(from ?? '') },
      ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}),
    });
    let copyMessageId: string | null = null;
    if (input.sentCopy !== false && wantsSentCopy(send) && grant.mailboxId) {
      copyMessageId = await storeRawInSentFolder(grant.mailboxId, input.raw);
      if (!copyMessageId) log.warn({ sharedMailboxId: grant.sharedMailboxId }, 'Shared mailbox has no Sent folder — no sent copy stored');
    }
    return { mode: send.mode, sharedMailboxId: grant.sharedMailboxId, copyMessageId };
  } catch (err) {
    log.error({ err, userId: input.userId, source: input.source }, 'Shared mailbox sent copy / audit failed');
    return null;
  }
}
