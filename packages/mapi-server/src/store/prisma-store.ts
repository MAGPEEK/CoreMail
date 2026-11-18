/**
 * The production MailStore: Prisma rows, the message store (UID + modSeq for
 * every write), raw-always storage, the object store and the outbound queue.
 * Same rules as the other protocol servers:
 *  - deleting messages tombstones them (recoverable, IMAP EXPUNGE semantics);
 *  - sending: send quota, sender identity (own address, aliases, shared
 *    mailboxes with Send As / Full Access), queue, Sent copy;
 *  - drafts are stored as raw MIME with \Draft (visible to every client).
 */
import { randomUUID } from 'node:crypto';
import { createLogger, getRedisClient, CHANNEL_MAIL_NEW, CHANNEL_MAIL_UPDATE } from '@coremail/core';
import {
  prisma, listAccessibleMailboxes, ensureMailboxProvisioned, directoryIdFromLegacyDn, reservedFolderPrefix,
  DEFAULT_FOLDERS, deleteFolderMovingMail, loadRawMessage, parseRawMessage, downloadBuffer, storeRawInFolder,
  expunge, modifyFlags, moveMessages, copyMessages, isMailboxWriteBlocked, checkSendQuota,
  listAllowedSenderAddresses, isSenderAddressAllowed, normalizeSenderAddress, buildRfc822FromFields,
  type RawSourceMessage,
} from '@coremail/storage';
import { enqueueRawOutbound, type RawOutboundJob } from './outbound.js';
import {
  MailboxFullError,
  type ComposedMessage, type FolderRecord, type FolderTarget, type MailboxRef, type MailStore, type MapiUser,
  type MessageContent, type MessageSummary, type SubmitResult,
} from './types.js';

const log = createLogger('mapi:store');

const FOLDER_SELECT = {
  id: true, name: true, displayName: true, parentId: true, totalCount: true, unreadCount: true, createdAt: true,
} as const;

const SUMMARY_SELECT = {
  id: true, folderId: true, uid: true, flags: true, subject: true, fromAddr: true, fromName: true,
  toAddrs: true, ccAddrs: true, messageId: true, inReplyTo: true, date: true, createdAt: true,
  rawSize: true, modSeq: true,
} as const;

const SEEN = '\\Seen';
const DRAFT = '\\Draft';
const TOP_LEVEL_DEFAULTS = new Set(DEFAULT_FOLDERS.map((f) => f.name.toLowerCase()));

interface SummaryRow {
  id: string; folderId: string; uid: number; flags: string[]; subject: string; fromAddr: string; fromName: string;
  toAddrs: string[]; ccAddrs: string[]; messageId: string | null; inReplyTo: string | null; date: Date;
  createdAt: Date; rawSize: number; modSeq: bigint;
}

function toSummary(row: SummaryRow, withAttachments: ReadonlySet<string>): MessageSummary {
  return {
    id: row.id, folderId: row.folderId, uid: row.uid, flags: row.flags, subject: row.subject,
    fromAddr: row.fromAddr, fromName: row.fromName, toAddrs: row.toAddrs, ccAddrs: row.ccAddrs,
    messageIdHeader: row.messageId, inReplyTo: row.inReplyTo, date: row.date, createdAt: row.createdAt,
    rawSize: row.rawSize, hasAttachments: withAttachments.has(row.id), modSeq: row.modSeq,
  };
}

async function attachmentOwners(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await prisma.attachment.findMany({ where: { messageId: { in: ids } }, select: { messageId: true } });
  return new Set(rows.map((r) => r.messageId));
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1) || 'localhost';
}

/** RFC 5322 octets of a composed message. Bcc never goes into the header. */
export function buildMime(m: ComposedMessage, from: { address: string; name: string }, date: Date): Buffer {
  return buildRfc822FromFields({
    subject: m.subject, fromAddr: from.address, fromName: from.name, toAddrs: m.to, ccAddrs: m.cc,
    replyTo: null, messageId: `<${randomUUID()}@${domainOf(from.address)}>`, inReplyTo: m.inReplyTo,
    date, bodyText: m.bodyText, bodyHtml: m.bodyHtml,
  }, m.attachments);
}

function unique(addresses: readonly string[]): string[] {
  return [...new Set(addresses.map((a) => normalizeSenderAddress(a)).filter((a) => a.includes('@')))];
}

export interface PrismaStoreDeps {
  enqueue: (job: RawOutboundJob) => Promise<void>;
  now: () => Date;
  /** ProhibitSendQuota check (storage checkSendQuota). */
  sendAllowed: (userId: string) => Promise<boolean>;
  /** Addresses the user may send as (storage sender identity). */
  allowedSenders: (userId: string) => Promise<string[]>;
  /** Hard quota reached: nothing may be added to the mailbox. */
  writeBlocked: (mailboxId: string) => Promise<boolean>;
  /** Mailbox change events (Redis pub/sub: webmail event stream, IMAP IDLE). */
  publish: (channel: string, message: string) => Promise<unknown>;
}

export const defaultStoreDeps: PrismaStoreDeps = {
  enqueue: enqueueRawOutbound,
  now: () => new Date(),
  sendAllowed: async (userId) => (await checkSendQuota(userId)).allowed,
  allowedSenders: listAllowedSenderAddresses,
  writeBlocked: isMailboxWriteBlocked,
  publish: (channel, message) => getRedisClient().publish(channel, message),
};

export function createPrismaStore(deps: PrismaStoreDeps = defaultStoreDeps): MailStore {
  /** Mailbox change event; the owner (own / delegated mailbox) receives it on the webmail stream. */
  async function notify(mailbox: MailboxRef, channel: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await deps.publish(channel, JSON.stringify({
        ...(mailbox.kind !== 'shared' ? { userId: mailbox.directoryId } : {}),
        ...payload,
        source: 'mapi',
      }));
    } catch (err) {
      log.warn({ err }, 'Redis publish failed');
    }
  }

  async function ownMailboxId(user: MapiUser): Promise<string> {
    const row = await prisma.mailbox.findUnique({ where: { userId: user.userId }, select: { id: true } });
    if (row) return row.id;
    await ensureMailboxProvisioned(user.userId);
    const created = await prisma.mailbox.findUnique({ where: { userId: user.userId }, select: { id: true } });
    if (!created) throw new Error('mailbox provisioning failed');
    return created.id;
  }

  async function tombstone(mailbox: MailboxRef, folderId: string, rows: Array<{ id: string; flags: string[] }>): Promise<void> {
    if (rows.length === 0) return;
    const unread = rows.filter((r) => !r.flags.includes(SEEN)).length;
    await prisma.$transaction(async (tx) => {
      await expunge(tx, rows.map((r) => r.id), { mailboxId: mailbox.mailboxId, where: { folderId, deletedAt: null } });
      await tx.folder.update({
        where: { id: folderId },
        data: { totalCount: { decrement: rows.length }, ...(unread ? { unreadCount: { decrement: unread } } : {}) },
      });
    });
  }

  async function liveRows(folderId: string, uids: number[]): Promise<Array<{ id: string; flags: string[] }>> {
    if (uids.length === 0) return [];
    return prisma.message.findMany({ where: { folderId, uid: { in: uids }, deletedAt: null }, select: { id: true, flags: true } });
  }

  async function sentFolderId(mailboxId: string): Promise<string | null> {
    const f = await prisma.folder.findFirst({ where: { mailboxId, name: 'Sent' }, select: { id: true } });
    return f?.id ?? null;
  }

  return {
    async resolveLogon(user, essdn) {
      const directoryId = essdn.trim() === '' ? user.userId : directoryIdFromLegacyDn(essdn);
      if (!directoryId) return null;
      if (directoryId === user.userId) {
        return {
          mailboxId: await ownMailboxId(user), kind: 'own', email: user.email.toLowerCase(),
          displayName: user.displayName || user.email, readOnly: false, directoryId: user.userId,
        };
      }
      const accessible = await listAccessibleMailboxes(prisma, user.userId);
      const hit = accessible.find((a) => a.ownerUserId === directoryId || a.sharedMailboxId === directoryId);
      return hit ? {
        mailboxId: hit.mailboxId, kind: hit.kind, email: hit.email, displayName: hit.displayName,
        readOnly: hit.readOnly, directoryId,
      } : null;
    },

    async resolveLegacyDn(dn) {
      const id = directoryIdFromLegacyDn(dn);
      if (!id) return null;
      const user = await prisma.user.findFirst({ where: { id, active: true }, select: { email: true } });
      if (user) return user.email;
      const shared = await prisma.sharedMailbox.findFirst({ where: { id, active: true }, select: { email: true } });
      return shared?.email ?? null;
    },

    async listFolders(mailboxId) {
      return prisma.folder.findMany({ where: { mailboxId }, select: FOLDER_SELECT, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
    },

    async createFolder(mailbox, parent, displayName) {
      const name = parent ? `${parent.name}.${displayName}` : displayName;
      if (reservedFolderPrefix(name)) return 'invalid-name';
      if (!parent && TOP_LEVEL_DEFAULTS.has(name.toLowerCase())) return 'exists';
      const dup = await prisma.folder.findFirst({ where: { mailboxId: mailbox.mailboxId, name }, select: { id: true } });
      if (dup) return 'exists';
      const created: FolderRecord = await prisma.folder.create({
        data: { mailboxId: mailbox.mailboxId, name, displayName, ...(parent ? { parentId: parent.id } : {}) },
        select: FOLDER_SELECT,
      });
      await notify(mailbox, CHANNEL_MAIL_UPDATE, { type: 'folders' });
      return created;
    },

    async deleteFolder(mailbox, folderId, recursive) {
      const r = await deleteFolderMovingMail(prisma, { id: folderId, mailboxId: mailbox.mailboxId }, recursive ? 'recursive' : 'reparent');
      if (r.ok) await notify(mailbox, CHANNEL_MAIL_UPDATE, { type: 'folders' });
      return r.ok ? 'ok' : r.reason === 'no-trash' ? 'no-trash' : 'not-found';
    },

    async listMessages(folderId) {
      const rows = await prisma.message.findMany({
        where: { folderId, deletedAt: null, softDeletedAt: null }, select: SUMMARY_SELECT, orderBy: { uid: 'asc' },
      });
      const withAtt = await attachmentOwners(rows.map((r) => r.id));
      return rows.map((r) => toSummary(r, withAtt));
    },

    async findMessage(folderId, uid) {
      const row = await prisma.message.findFirst({ where: { folderId, uid, deletedAt: null, softDeletedAt: null }, select: SUMMARY_SELECT });
      return row ? toSummary(row, await attachmentOwners([row.id])) : null;
    },

    async loadContent(message): Promise<MessageContent> {
      const row = await prisma.message.findUnique({ where: { id: message.id } });
      if (!row) throw new Error('message vanished');
      const raw = await loadRawMessage(row as unknown as RawSourceMessage);
      const parsed = await parseRawMessage(raw);
      const attachments = await prisma.attachment.findMany({
        where: { messageId: message.id }, orderBy: { createdAt: 'asc' },
        select: { id: true, filename: true, mimeType: true, size: true, contentId: true, inline: true },
      });
      return { bodyText: parsed.bodyText, bodyHtml: parsed.bodyHtml, bccAddrs: row.bccAddrs ?? [], attachments };
    },

    async loadAttachment(attachmentId) {
      const row = await prisma.attachment.findUnique({ where: { id: attachmentId }, select: { storagePath: true } });
      if (!row) throw new Error('attachment vanished');
      return downloadBuffer(row.storagePath);
    },

    async setRead(mailbox, message, read) {
      const changed = await prisma.$transaction(async (tx) => {
        const rows = await modifyFlags(tx, [message.id], (flags) => {
          const has = flags.includes(SEEN);
          if (has === read) return null;
          return read ? [...flags, SEEN] : flags.filter((f) => f !== SEEN);
        }, { mailboxId: mailbox.mailboxId });
        if (rows.length > 0) {
          await tx.folder.update({
            where: { id: message.folderId },
            data: { unreadCount: read ? { decrement: 1 } : { increment: 1 } },
          });
        }
        return rows.length > 0;
      });
      if (changed) await notify(mailbox, CHANNEL_MAIL_UPDATE, { folderId: message.folderId, messageId: message.id });
    },

    async deleteMessages(mailbox, folderId, uids) {
      const rows = await liveRows(folderId, uids);
      await tombstone(mailbox, folderId, rows);
      if (rows.length > 0) await notify(mailbox, CHANNEL_MAIL_UPDATE, { folderId });
      return rows.length;
    },

    async moveOrCopy(source: FolderTarget, target: FolderTarget, uids, copy) {
      const rows = await liveRows(source.folderId, uids);
      if (rows.length === 0) return 0;
      const unread = rows.filter((r) => !r.flags.includes(SEEN)).length;
      const ids = rows.map((r) => r.id);
      await prisma.$transaction(async (tx) => {
        if (copy) {
          await copyMessages(tx, ids, target.folderId, { targetMailboxId: target.mailbox.mailboxId });
        } else {
          await moveMessages(tx, ids, target.folderId, {
            targetMailboxId: target.mailbox.mailboxId, sourceMailboxId: source.mailbox.mailboxId,
          });
          await tx.folder.update({
            where: { id: source.folderId },
            data: { totalCount: { decrement: rows.length }, ...(unread ? { unreadCount: { decrement: unread } } : {}) },
          });
        }
        await tx.folder.update({
          where: { id: target.folderId },
          data: { totalCount: { increment: rows.length }, ...(unread ? { unreadCount: { increment: unread } } : {}) },
        });
      });
      await notify(target.mailbox, CHANNEL_MAIL_NEW, { folderId: target.folderId });
      if (!copy) await notify(source.mailbox, CHANNEL_MAIL_UPDATE, { folderId: source.folderId });
      return rows.length;
    },

    async saveDraft(mailbox, folderId, message, replaces) {
      if (await deps.writeBlocked(mailbox.mailboxId)) throw new MailboxFullError();
      const raw = buildMime(message, { address: message.from ?? mailbox.email, name: message.from ? '' : mailbox.displayName }, deps.now());
      const row = await storeRawInFolder({
        mailboxId: mailbox.mailboxId, folderId, raw, flags: [DRAFT, SEEN], bccAddrs: unique(message.bcc),
      });
      if (replaces) await tombstone(mailbox, replaces.folderId, [{ id: replaces.id, flags: replaces.flags }]);
      await notify(mailbox, CHANNEL_MAIL_NEW, { folderId, messageId: row.id, uid: row.uid, subject: row.subject });
      return toSummary(row, await attachmentOwners([row.id]));
    },

    async submit(user, mailbox, message, opts): Promise<SubmitResult> {
      if (mailbox.readOnly) return { ok: false, reason: 'read-only' };
      const recipients = unique([...message.to, ...message.cc, ...message.bcc]);
      if (recipients.length === 0) return { ok: false, reason: 'no-recipients' };
      if (!(await deps.sendAllowed(user.userId))) return { ok: false, reason: 'over-quota' };
      const from = normalizeSenderAddress(message.from ?? mailbox.email);
      if (!isSenderAddressAllowed(from, await deps.allowedSenders(user.userId))) {
        log.warn({ userId: user.userId, from }, 'MAPI submit refused: sender not allowed');
        return { ok: false, reason: 'sender-not-allowed' };
      }
      const name = from === normalizeSenderAddress(user.email) ? user.displayName
        : from === normalizeSenderAddress(mailbox.email) ? mailbox.displayName : '';
      const raw = buildMime(message, { address: from, name }, deps.now());
      const jobId = `mapi-${randomUUID()}`;
      await deps.enqueue({ messageId: jobId, from, to: recipients, senderUserId: user.userId, rawMessage: raw.toString('base64') });
      log.info({ userId: user.userId, jobId, rcpt: recipients.length }, 'MAPI mail enqueued');
      void prisma.systemLog.create({
        data: {
          level: 'INFO', service: 'mapi-server', category: 'MAIL_FLOW',
          message: `Sent (MAPI): ${from} → ${recipients.join(', ')}`, userId: user.userId,
          metadata: { sender: from, recipient: recipients.join(', '), subject: message.subject, status: 'ACCEPTED', messageId: jobId, direction: 'OUTBOUND', protocol: 'MAPI' },
        },
      }).catch((err: unknown) => log.warn({ err }, 'MAIL_FLOW log write failed'));

      // The mail is queued: failures below must not make the client send it again.
      try {
        const sentId = opts.saveCopy ? await sentFolderId(mailbox.mailboxId) : null;
        if (sentId) {
          const row = await storeRawInFolder({ mailboxId: mailbox.mailboxId, folderId: sentId, raw, flags: [SEEN], bccAddrs: unique(message.bcc) });
          await notify(mailbox, CHANNEL_MAIL_NEW, { folderId: sentId, messageId: row.id, uid: row.uid, subject: row.subject });
        }
        if (opts.draft) await tombstone(mailbox, opts.draft.folderId, [{ id: opts.draft.id, flags: opts.draft.flags }]);
      } catch (err) {
        log.error({ err, userId: user.userId, jobId }, 'Sent copy / draft cleanup failed (mail was sent)');
      }
      return { ok: true, jobId };
    },
  };
}
