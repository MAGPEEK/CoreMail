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
import { createLogger, getRedisClient } from '@coremail/core';
import {
  prisma, listAccessibleMailboxes, ensureMailboxProvisioned, directoryIdFromLegacyDn, reservedFolderPrefix,
  DEFAULT_FOLDERS, deleteFolderMovingMail, loadRawMessage, parseRawMessage, downloadBuffer, storeRawInFolder,
  expunge, modifyFlags, moveMessages, copyMessages, isMailboxWriteBlocked, checkSendQuota,
  listAllowedSenderAddresses, isSenderAddressAllowed, normalizeSenderAddress, buildRfc822FromFields, submissionLimitsForUser,
  announceFolderListChange, deferMailboxChanges, recordMailboxAccess,
  type RawSourceMessage, type MailboxAccessEvent, type MailboxAccessAction,
} from '@coremail/storage';
import { enqueueRawOutbound, type RawOutboundJob } from './outbound.js';
import { createRedisLocalIdStore, type LocalIdRedis, type LocalIdStore } from './local-ids.js';
import { isServerMessageId, LOCAL_ID_BASE } from '../ics/keys.js';
import { contains, normalize } from '../ics/globset.js';
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
  rawSize: true, modSeq: true, createdModSeq: true,
} as const;

const SEEN = '\\Seen';
const DRAFT = '\\Draft';
const TOP_LEVEL_DEFAULTS = new Set(DEFAULT_FOLDERS.map((f) => f.name.toLowerCase()));
/** Upper bound of the client IDs one download looks up (assignedClientIds). */
const MAX_ASSIGNED_LOOKUP = 200_000;

interface SummaryRow {
  id: string; folderId: string; uid: number; flags: string[]; subject: string; fromAddr: string; fromName: string;
  toAddrs: string[]; ccAddrs: string[]; messageId: string | null; inReplyTo: string | null; date: Date;
  createdAt: Date; rawSize: number; modSeq: bigint; createdModSeq: bigint | null;
}

/** Cached-mode data of a row (MapiObject). */
interface MapiInfo { clientId: bigint | null; pcl: Buffer | null }

function toSummary(row: SummaryRow, withAttachments: ReadonlySet<string>, mapi?: MapiInfo): MessageSummary {
  return {
    id: row.id, folderId: row.folderId, uid: row.uid, flags: row.flags, subject: row.subject,
    fromAddr: row.fromAddr, fromName: row.fromName, toAddrs: row.toAddrs, ccAddrs: row.ccAddrs,
    messageIdHeader: row.messageId, inReplyTo: row.inReplyTo, date: row.date, createdAt: row.createdAt,
    rawSize: row.rawSize, hasAttachments: withAttachments.has(row.id), modSeq: row.modSeq,
    createdModSeq: row.createdModSeq ?? 0n, clientId: mapi?.clientId ?? null, pcl: mapi?.pcl ?? null,
  };
}

async function attachmentOwners(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await prisma.attachment.findMany({ where: { messageId: { in: ids } }, select: { messageId: true } });
  return new Set(rows.map((r) => r.messageId));
}

/**
 * MapiObject data of message rows — only while a row lies in the mailbox its
 * client ID belongs to (a row moved to another mailbox shows its UID there).
 */
async function mapiInfoOf(rows: ReadonlyArray<{ id: string; folderId: string }>): Promise<Map<string, MapiInfo>> {
  const out = new Map<string, MapiInfo>();
  if (rows.length === 0) return out;
  const objects = await prisma.mapiObject.findMany({
    where: { messageId: { in: rows.map((r) => r.id) } }, select: { messageId: true, mailboxId: true, clientId: true, pcl: true },
  });
  if (objects.length === 0) return out;
  const folders = await prisma.folder.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.folderId))] } }, select: { id: true, mailboxId: true } });
  const mailboxOfFolder = new Map(folders.map((f) => [f.id, f.mailboxId]));
  const folderOfRow = new Map(rows.map((r) => [r.id, r.folderId]));
  for (const o of objects) {
    if (!o.messageId || mailboxOfFolder.get(folderOfRow.get(o.messageId) ?? '') !== o.mailboxId) continue;
    out.set(o.messageId, { clientId: o.clientId, pcl: o.pcl ? Buffer.from(o.pcl) : null });
  }
  return out;
}

async function summariesOf(rows: SummaryRow[]): Promise<MessageSummary[]> {
  const [withAttachments, mapi] = await Promise.all([attachmentOwners(rows.map((r) => r.id)), mapiInfoOf(rows)]);
  return rows.map((r) => toSummary(r, withAttachments, mapi.get(r.id)));
}

type FolderRow = Omit<FolderRecord, 'clientId'>;

async function withClientIds(rows: FolderRow[]): Promise<FolderRecord[]> {
  const objects = rows.length === 0 ? [] : await prisma.mapiObject.findMany({
    where: { folderId: { in: rows.map((r) => r.id) } }, select: { folderId: true, clientId: true },
  });
  const byFolder = new Map(objects.map((o) => [o.folderId, o.clientId]));
  return rows.map((r) => ({ ...r, clientId: byFolder.get(r.id) ?? null }));
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
  /** Client-assigned IDs of cached mode (Redis, shared by every instance). */
  localIds: LocalIdStore;
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
  localIds: createRedisLocalIdStore(() => getRedisClient() as unknown as LocalIdRedis),
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
      return withClientIds(await prisma.folder.findMany({ where: { mailboxId }, select: FOLDER_SELECT, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }));
    },

    async createFolder(mailbox, parent, displayName) {
      const name = parent ? `${parent.name}.${displayName}` : displayName;
      if (reservedFolderPrefix(name)) return 'invalid-name';
      if (!parent && TOP_LEVEL_DEFAULTS.has(name.toLowerCase())) return 'exists';
      const dup = await prisma.folder.findFirst({ where: { mailboxId: mailbox.mailboxId, name }, select: { id: true } });
      if (dup) return 'exists';
      const created: FolderRow = await prisma.folder.create({
        data: { mailboxId: mailbox.mailboxId, name, displayName, ...(parent ? { parentId: parent.id } : {}) },
        select: FOLDER_SELECT,
      });
      announceFolderListChange(mailbox.mailboxId);
      audit(mailbox, 'mailbox.foreign.folder.create', { count: 1 });
      return { ...created, clientId: null };
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
      return summariesOf(rows);
    },

    async findMessage(folderId, uid) {
      const row = await prisma.message.findFirst({ where: { folderId, uid, deletedAt: null, softDeletedAt: null }, select: SUMMARY_SELECT });
      return row ? (await summariesOf([row]))[0]! : null;
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
      return prisma.$transaction(async (tx) => {
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
        return rows[0]?.modSeq ?? null;
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

    async highestModSeq(mailboxId) {
      const row = await prisma.mailbox.findUnique({ where: { id: mailboxId }, select: { highestModSeq: true } });
      return row?.highestModSeq ?? 0n;
    },

    async messagesCreatedSince(folderIds, sinceModSeq, limit) {
      if (folderIds.length === 0) return [];
      const rows = await prisma.message.findMany({
        where: { folderId: { in: [...folderIds] }, createdModSeq: { gt: sinceModSeq }, deletedAt: null, softDeletedAt: null },
        select: { id: true, folderId: true, uid: true, flags: true, createdModSeq: true },
        orderBy: { createdModSeq: 'asc' },
        take: limit,
      });
      const mapi = await mapiInfoOf(rows);
      return rows.map((r) => ({
        folderId: r.folderId, uid: r.uid, read: r.flags.includes(SEEN), createdModSeq: r.createdModSeq ?? 0n,
        clientId: mapi.get(r.id)?.clientId ?? null,
      }));
    },

    async importMessage(mailbox, folderId, message, opts) {
      if (await deps.writeBlocked(mailbox.mailboxId)) throw new MailboxFullError();
      const own = message.from === null;
      const raw = buildMime(message, { address: message.from ?? mailbox.email, name: own ? mailbox.displayName : '' }, opts.date ?? deps.now());
      const row = await storeRawInFolder({
        mailboxId: mailbox.mailboxId, folderId, raw, flags: opts.read ? [SEEN] : [], bccAddrs: unique(message.bcc),
      });
      return toSummary(row, await attachmentOwners([row.id]));
    },

    async renameFolder(mailbox, folderId, parent, displayName) {
      const name = parent ? `${parent.name}.${displayName}` : displayName;
      if (reservedFolderPrefix(name)) return 'invalid-name';
      if (!parent && TOP_LEVEL_DEFAULTS.has(name.toLowerCase())) return 'exists';
      const folders = await prisma.folder.findMany({ where: { mailboxId: mailbox.mailboxId }, select: { id: true, name: true } });
      const folder = folders.find((f) => f.id === folderId);
      if (!folder) return 'not-found';
      const moving = folders.filter((f) => f.id === folderId || f.name.startsWith(`${folder.name}.`));
      if (parent && moving.some((f) => f.id === parent.id)) return 'invalid-name'; // into itself
      const renames = moving.map((f) => ({ id: f.id, name: name + f.name.slice(folder.name.length) }));
      const others = new Set(folders.filter((f) => !moving.includes(f)).map((f) => f.name));
      if (renames.some((r) => others.has(r.name))) return 'exists';
      await prisma.$transaction(async (tx) => {
        await tx.folder.update({ where: { id: folderId }, data: { name, displayName, parentId: parent?.id ?? null } });
        for (const r of renames) if (r.id !== folderId) await tx.folder.update({ where: { id: r.id }, data: { name: r.name } });
      });
      announceFolderListChange(mailbox.mailboxId);
      audit(mailbox, 'mailbox.foreign.folder.update', { count: 1 });
      return 'ok';
    },

    async reserveLocalIds(mailboxId, count) {
      // Above every client ID the mailbox's objects keep, also when the Redis counter was lost.
      const top = await prisma.mapiObject.findFirst({
        where: { mailboxId, clientId: { gte: LOCAL_ID_BASE } }, select: { clientId: true }, orderBy: { clientId: 'desc' },
      });
      return deps.localIds.reserve(mailboxId, count, (top?.clientId ?? 0n) + 1n);
    },
    replacedLocalIds: (mailboxId) => deps.localIds.replaced(mailboxId),
    addReplacedLocalIds: (mailboxId, ids) => deps.localIds.addReplaced(mailboxId, ids),
    localIdsHandedOutBelow: (mailboxId) => deps.localIds.handedOutBelow(mailboxId),

    async findMessagesByCounters(folderId, counters) {
      const out = new Map<bigint, MessageSummary>();
      const uids = counters.filter(isServerMessageId).map(Number);
      if (uids.length > 0) {
        const rows = await prisma.message.findMany({ where: { folderId, uid: { in: uids }, deletedAt: null, softDeletedAt: null }, select: SUMMARY_SELECT });
        for (const s of await summariesOf(rows)) out.set(BigInt(s.uid), s);
      }
      const rest = counters.filter((c) => !out.has(c));
      if (rest.length === 0) return out;
      const folder = await prisma.folder.findUnique({ where: { id: folderId }, select: { mailboxId: true } });
      if (!folder) return out;
      const objects = await prisma.mapiObject.findMany({
        where: { mailboxId: folder.mailboxId, clientId: { in: [...rest] }, messageId: { not: null } }, select: { messageId: true },
      });
      if (objects.length === 0) return out;
      const rows = await prisma.message.findMany({
        where: { id: { in: objects.map((o) => o.messageId!) }, folderId, deletedAt: null, softDeletedAt: null }, select: SUMMARY_SELECT,
      });
      for (const s of await summariesOf(rows)) if (s.clientId !== null) out.set(s.clientId, s);
      return out;
    },

    async messageByRowId(id) {
      const row = await prisma.message.findFirst({ where: { id, deletedAt: null, softDeletedAt: null }, select: SUMMARY_SELECT });
      return row ? (await summariesOf([row]))[0]! : null;
    },

    async clientIdOwner(mailboxId, clientId) {
      const o = await prisma.mapiObject.findFirst({ where: { mailboxId, clientId }, select: { messageId: true, folderId: true } });
      if (!o) return null;
      if (o.folderId) return { kind: 'folder', folderId: o.folderId };
      if (o.messageId) {
        const live = await prisma.message.findFirst({ where: { id: o.messageId, deletedAt: null, softDeletedAt: null }, select: { id: true } });
        if (live) return { kind: 'message', messageId: o.messageId };
      }
      return { kind: 'retired' };
    },

    async assignedClientIds(mailboxId, ranges) {
      if (ranges.length === 0) return [];
      const low = ranges.reduce((m, r) => (r.low < m ? r.low : m), ranges[0]!.low);
      const high = ranges.reduce((m, r) => (r.high > m ? r.high : m), ranges[0]!.high);
      const rows = await prisma.mapiObject.findMany({
        where: { mailboxId, clientId: { gte: low, lte: high } }, select: { clientId: true }, take: MAX_ASSIGNED_LOOKUP,
      });
      const sorted = normalize(ranges);
      return rows.map((r) => r.clientId!).filter((id) => contains(sorted, id));
    },

    async bindMapiObject(mailboxId, target, data) {
      const own = 'messageId' in target ? { messageId: target.messageId } : { folderId: target.folderId };
      const bind = 'messageId' in target ? { messageId: target.messageId, folderId: null } : { folderId: target.folderId, messageId: null };
      const pcl = data.pcl ? { pcl: data.pcl } : {};
      await prisma.$transaction(async (tx) => {
        let mine = await tx.mapiObject.findFirst({ where: own, select: { id: true, clientId: true } });
        if (data.clientId !== undefined && mine && mine.clientId !== null && mine.clientId !== data.clientId) {
          // The row's previous client ID retires (its clients are told it is gone).
          await tx.mapiObject.update({ where: { id: mine.id }, data: { messageId: null, folderId: null } });
          mine = null;
        }
        const holder = data.clientId === undefined ? null
          : await tx.mapiObject.findFirst({ where: { mailboxId, clientId: data.clientId }, select: { id: true } });
        if (holder && holder.id !== mine?.id) {
          if (mine) await tx.mapiObject.deleteMany({ where: { id: mine.id } });
          await tx.mapiObject.update({ where: { id: holder.id }, data: { ...bind, ...pcl } });
        } else if (mine) {
          await tx.mapiObject.update({ where: { id: mine.id }, data: { ...(data.clientId !== undefined ? { clientId: data.clientId } : {}), ...pcl } });
        } else {
          await tx.mapiObject.create({ data: { mailboxId, ...bind, ...(data.clientId !== undefined ? { clientId: data.clientId } : {}), ...pcl } });
        }
      });
    },

    async foreignAccess(user, mailbox) {
      const accessible = await listAccessibleMailboxes(prisma, user.userId);
      const hit = accessible.find((a) => a.mailboxId === mailbox.mailboxId);
      return hit ? { ...mailbox, readOnly: hit.readOnly } : null;
    },
  };
}
