/**
 * The production MailStore: Prisma rows, the message store (UID + modSeq for
 * every write), raw-always storage, the object store and the outbound queue.
 * Same rules as the other protocol servers:
 *  - deleting messages tombstones them (recoverable, IMAP EXPUNGE semantics);
 *  - sending: the submission limits shared with REST, JMAP and ActiveSync
 *    (storage submissionLimitsForUser: global size / recipients, per-mailbox
 *    MailFlowPolicy values), send quota, sender identity (own address, aliases,
 *    shared mailboxes with Send As / Full Access), queue, Sent copy; a send as /
 *    on behalf of a Shared Mailbox gets the worker's afterForeignSend step;
 *  - realtime: every message write goes through the message store (mailbox:changes
 *    after the commit), folder list changes are announced; units that finish
 *    rows after the message transaction run in deferMailboxChanges;
 *  - mailbox access audit for logons to shared / delegated mailboxes (open,
 *    folder create / delete, message move / delete), source `mapi`;
 *  - drafts are stored as raw MIME with \Draft (visible to every client).
 */
import { randomUUID } from 'node:crypto';
import { createLogger } from '@coremail/core';
import {
  prisma, listAccessibleMailboxes, ensureMailboxProvisioned, directoryIdFromLegacyDn, reservedFolderPrefix,
  DEFAULT_FOLDERS, deleteFolderMovingMail, loadRawMessage, parseRawMessage, downloadBuffer, storeRawInFolder,
  expunge, modifyFlags, moveMessages, copyMessages, isMailboxWriteBlocked, checkSendQuota,
  listAllowedSenderAddresses, isSenderAddressAllowed, normalizeSenderAddress, buildRfc822FromFields, submissionLimitsForUser,
  announceFolderListChange, deferMailboxChanges, recordMailboxAccess,
  type RawSourceMessage, type MailboxAccessEvent, type MailboxAccessAction,
} from '@coremail/storage';
import { enqueueRawOutbound, type RawOutboundJob } from './outbound.js';
import {
  MailboxFullError,
  type ComposedMessage, type FolderRecord, type FolderTarget, type MailboxRef, type MailStore, type MapiUser,
  type MessageContent, type MessageSummary, type SubmissionLimits, type SubmitResult,
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
  /** Submission limits of a user (storage submissionLimitsForUser: global + per mailbox). */
  limits: (userId: string) => Promise<SubmissionLimits>;
  /** Mailbox access audit entry (storage recordMailboxAccess; never throws). */
  audit: (event: MailboxAccessEvent) => Promise<unknown>;
}

export const defaultStoreDeps: PrismaStoreDeps = {
  enqueue: enqueueRawOutbound,
  now: () => new Date(),
  sendAllowed: async (userId) => (await checkSendQuota(userId)).allowed,
  allowedSenders: listAllowedSenderAddresses,
  writeBlocked: isMailboxWriteBlocked,
  limits: async (userId) => {
    const l = await submissionLimitsForUser(userId);
    return { maxMessageBytes: l.maxBytes, maxRecipients: l.maxRecipients };
  },
  audit: recordMailboxAccess,
};

export function createPrismaStore(deps: PrismaStoreDeps = defaultStoreDeps): MailStore {
  /** Mailbox access audit of an open / write in a shared or delegated mailbox (fire-and-forget). */
  function audit(mailbox: MailboxRef, action: MailboxAccessAction, changes?: Record<string, unknown>): void {
    if (mailbox.kind === 'own' || !mailbox.actor) return;
    void Promise.resolve()
      .then(() => deps.audit({
        actorId: mailbox.actor!.userId,
        actorEmail: mailbox.actor!.email,
        target: {
          kind: mailbox.kind === 'shared' ? 'shared' : 'delegated',
          sharedMailboxId: mailbox.kind === 'shared' ? mailbox.directoryId : null,
          mailboxId: mailbox.mailboxId,
          email: mailbox.email,
        },
        action,
        source: 'mapi',
        ...(changes ? { changes } : {}),
      }))
      .catch((err: unknown) => log.warn({ err }, 'Mailbox access audit failed'));
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
      if (!hit) return null;
      const mailbox: MailboxRef = {
        mailboxId: hit.mailboxId, kind: hit.kind, email: hit.email, displayName: hit.displayName,
        readOnly: hit.readOnly, directoryId, actor: { userId: user.userId, email: user.email },
      };
      audit(mailbox, 'mailbox.foreign.open');
      return mailbox;
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
      announceFolderListChange(mailbox.mailboxId);
      audit(mailbox, 'mailbox.foreign.folder.create', { count: 1 });
      return created;
    },

    async deleteFolder(mailbox, folderId, recursive) {
      const r = await deleteFolderMovingMail(prisma, { id: folderId, mailboxId: mailbox.mailboxId }, recursive ? 'recursive' : 'reparent');
      // deleteFolderMovingMail announces the folder list itself
      if (r.ok) audit(mailbox, 'mailbox.foreign.folder.delete', { count: 1 });
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
    },

    async deleteMessages(mailbox, folderId, uids) {
      const rows = await liveRows(folderId, uids);
      await tombstone(mailbox, folderId, rows);
      if (rows.length > 0) audit(mailbox, 'mailbox.foreign.message.delete', { count: rows.length });
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
      if (!copy) audit(source.mailbox, 'mailbox.foreign.message.move', { count: rows.length });
      return rows.length;
    },

    async saveDraft(mailbox, folderId, message, replaces) {
      if (await deps.writeBlocked(mailbox.mailboxId)) throw new MailboxFullError();
      const raw = buildMime(message, { address: message.from ?? mailbox.email, name: message.from ? '' : mailbox.displayName }, deps.now());
      // one announcement once the new draft is complete and the replaced one is gone
      const row = await deferMailboxChanges(async () => {
        const stored = await storeRawInFolder({
          mailboxId: mailbox.mailboxId, folderId, raw, flags: [DRAFT, SEEN], bccAddrs: unique(message.bcc),
        });
        if (replaces) await tombstone(mailbox, replaces.folderId, [{ id: replaces.id, flags: replaces.flags }]);
        return stored;
      });
      return toSummary(row, await attachmentOwners([row.id]));
    },

    submissionLimits: (user) => deps.limits(user.userId),

    async submit(user, mailbox, message, opts): Promise<SubmitResult> {
      if (mailbox.readOnly) return { ok: false, reason: 'read-only' };
      const recipients = unique([...message.to, ...message.cc, ...message.bcc]);
      if (recipients.length === 0) return { ok: false, reason: 'no-recipients' };
      const limits = await deps.limits(user.userId);
      if (recipients.length > limits.maxRecipients) return { ok: false, reason: 'too-many-recipients' };
      if (!(await deps.sendAllowed(user.userId))) return { ok: false, reason: 'over-quota' };
      const from = normalizeSenderAddress(message.from ?? mailbox.email);
      if (!isSenderAddressAllowed(from, await deps.allowedSenders(user.userId))) {
        log.warn({ userId: user.userId, from }, 'MAPI submit refused: sender not allowed');
        return { ok: false, reason: 'sender-not-allowed' };
      }
      const name = from === normalizeSenderAddress(user.email) ? user.displayName
        : from === normalizeSenderAddress(mailbox.email) ? mailbox.displayName : '';
      const raw = buildMime(message, { address: from, name }, deps.now());
      if (raw.length > limits.maxMessageBytes) return { ok: false, reason: 'too-large' };
      const jobId = `mapi-${randomUUID()}`;
      // A From: other than the user's own address may be a send as / on behalf of a
      // Shared Mailbox: the worker audits it and files the box's Sent copy — audit
      // only when this logon is that box and keeps the copy itself.
      const foreign = from !== normalizeSenderAddress(user.email)
        ? { foreignSendSource: 'mapi' as const, ...(mailbox.kind === 'shared' && opts.saveCopy ? { foreignSendAuditOnly: true as const } : {}) }
        : {};
      await deps.enqueue({ messageId: jobId, from, to: recipients, senderUserId: user.userId, rawMessage: raw.toString('base64'), ...foreign });
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
        await deferMailboxChanges(async () => {
          const sentId = opts.saveCopy ? await sentFolderId(mailbox.mailboxId) : null;
          if (sentId) {
            await storeRawInFolder({ mailboxId: mailbox.mailboxId, folderId: sentId, raw, flags: [SEEN], bccAddrs: unique(message.bcc) });
          }
          if (opts.draft) await tombstone(mailbox, opts.draft.folderId, [{ id: opts.draft.id, flags: opts.draft.flags }]);
        });
      } catch (err) {
        log.error({ err, userId: user.userId, jobId }, 'Sent copy / draft cleanup failed (mail was sent)');
      }
      return { ok: true, jobId };
    },
  };
}
