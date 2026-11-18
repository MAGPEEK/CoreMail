import { Router, type Router as RouterType, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { isoDateTime } from '../lib/zod-compat.js';
import { Readable } from 'stream';
import multer from 'multer';
import nodemailer, { type SendMailOptions } from 'nodemailer';
import { Queue } from 'bullmq';
import {
  prisma, parseRawMessage, uploadBuffer, outboundAttachKey,
  createMessage, moveMessages, setFlags, touchMessages, expunge, nextModSeq,
  loadRawMessage, storeRawMessage, truncateBodyColumn, getObjectStream, getObjectStore, downloadBuffer,
  checkSendQuota, reservedFolderPrefix, reservedFolderNameError, submissionLimitsForUser,
  importanceMailOption, normalizeImportance, type Importance,
  normalizeSensitivity, sensitivityHeaders, type Sensitivity,
} from '@coremail/storage';
import { getOutboundJobOptions } from '@coremail/storage/queue-options';
import {
  createAttachmentDownloadHandler, readableMailboxWhere, contentDisposition,
} from '../lib/attachment-download.js';
import { getRedisClient, createBullMqConnection, CHANNEL_MAIL_NEW, createLogger } from '@coremail/core';
import { requireAuth } from '../middleware/auth.js';
import { announceFolderListChange, CRLF_STREAM_TRANSPORT, canonicalAddress, addressVariants } from '@coremail/storage';
import { checkFolderParent, type FolderLookup } from '../lib/folder-tree.js';
import { withBodyLimit, checkRecipients, envelopeRecipients, deliveryReceiptDsn, maxRecipients, MAX_SEND_FILES } from '../lib/send-limits.js';
import { createUserRateLimiter, envInt } from '../lib/user-rate-limit.js';
import { resolveReplyHeaders, prismaReplyLookup, parseClientReferences } from '../lib/reply-headers.js';
import { rspamdControllerHeaders } from '../lib/rspamd-controller.js';
import { createImageProxyHandler } from '../lib/image-proxy.js';
import { deleteFolder, folderDeleteFailure, folderDeleteOptions, folderDeleteRefusal } from '../lib/folder-delete.js';
import { markReadRequested } from '../lib/mark-read.js';
import { messageOrderBy } from '../lib/message-sort.js';
import {
  parseSearchQuery, buildSearchConditions, resolveFolderScope, searchChips, hasCriteria,
  MAX_QUERY_LENGTH, type FolderRef,
} from '../lib/search-query.js';

export const replyLookup = prismaReplyLookup(
  prisma as unknown as Parameters<typeof prismaReplyLookup>[0],
  (p) => (p.storagePath ? loadRawMessage(p as unknown as Parameters<typeof loadRawMessage>[0], { persist: false }) : Promise.resolve(null)),
);

const log = createLogger('api:mail');
export const mailRouter: RouterType = Router();

// ── rspamd Bayes learning ─────────────────────────────────────────────────────
const RSPAMD_URL = process.env['RSPAMD_URL'] ?? 'http://rspamd:11334';

/** Sends a mail to rspamd /learnspam or /learnham (fire and forget). */
async function rspamdLearn(action: 'learnspam' | 'learnham', raw: Buffer): Promise<void> {
  await fetch(`${RSPAMD_URL}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...rspamdControllerHeaders() },
    body: raw,
    signal: AbortSignal.timeout(10_000),
  });
}

/**
 * For all given message IDs: load the raw content from MinIO (or reconstruct it)
 * and send it to rspamd learnspam/learnham. Errors are logged, not propagated.
 */
async function rspamdLearnBatch(ids: string[], action: 'learnspam' | 'learnham', userId: string): Promise<void> {
  for (const id of ids) {
    try {
      const msg = await prisma.message.findFirst({
        where: { id, folder: { mailbox: { userId } } },
        include: { attachments: true },
      });
      if (!msg) continue;

      // Original message (legacy rows: sanitized reconstruction, not persisted here).
      const raw = await loadRawMessage(msg, { persist: false });
      await rspamdLearn(action, raw);
      log.debug({ id, action }, 'rspamd learning successful');
    } catch (err) {
      log.warn({ err, id, action }, 'rspamd learning failed — skipped');
    }
  }
}
mailRouter.use(requireAuth);

// ── Multer (attachments) ──────────────────────────────────────────────────────
// 8.0.x: the WHOLE request (all files + fields) is limited to the configured
// max. message size, and at most MAX_SEND_FILES files (was 20 × 25 MB ≈ 500 MB
// buffered in memory per request).
export const sendUploadMiddleware = withBodyLimit((limit) => multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: limit, files: MAX_SEND_FILES, fields: 50, fieldSize: limit, parts: MAX_SEND_FILES + 50 },
}).array('attachments', MAX_SEND_FILES));

// 8.0.x: per-user send rate limit (default 30 messages / 60 s, 0 disables)
export const sendRateLimiter = createUserRateLimiter({
  scope: 'mail-send',
  limit: envInt('MAIL_SEND_RATE_LIMIT', 30),
  windowSec: Math.max(1, envInt('MAIL_SEND_RATE_WINDOW_SEC', 60)),
});

// ── BullMQ outbound queue (same as smtp-server) ───────────────────────────────
let _outboundQueue: Queue | null = null;
export function getOutboundQueue(): Queue {
  // Test seam (route tests install an in-memory queue)
  const seam = (globalThis as { __outboundQueue?: Queue }).__outboundQueue;
  if (seam) return seam;
  if (!_outboundQueue) {
    // BullMQ v5 requires maxRetriesPerRequest: null — createBullMqConnection() provides that.
    // getRedisClient() (shared, maxRetriesPerRequest: 3) crashes the process when BullMQ
    // runs internal blocking commands → unhandled rejection → NetworkError in the browser.
    // BullMQ v5: no ':' allowed in the queue name — smtp-server uses 'smtp-outbound'
    _outboundQueue = new Queue('smtp-outbound', {
      connection: createBullMqConnection(),
      // retry/retention per job from QueueSettings (getOutboundJobOptions)
    });
  }
  return _outboundQueue;
}

// ── Nodemailer: build raw MIME message ────────────────────────────────────────
// IMPORTANT: CRLF line ends — the SMTP protocol (RFC 5321) requires CRLF (\r\n);
// nodemailer's value for that is 'windows' ('crlf' is no valid value: it left LF).
// nodemailer's smtp-connection does NOT normalize Buffer content automatically
// (only string content). With 'unix' (LF-only) the receiving MTA cannot detect
// the header/body separator (\r\n\r\n) → raw MIME text in the body.
export async function buildRawMime(options: SendMailOptions): Promise<Buffer> {
  const transport = nodemailer.createTransport(CRLF_STREAM_TRANSPORT);
  const info = await transport.sendMail(options);
  const stream = info.message as Readable;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

// Helper: parse comma-separated addresses
function parseAddrs(val: unknown): string[] {
  if (!val) return [];
  return String(val).split(',').map((s) => s.trim()).filter(Boolean);
}

export const SYSTEM_FOLDER_NAMES = new Set(['INBOX', 'Drafts', 'Sent', 'Trash', 'Junk', 'Archive', 'Outbox']);

// GET /api/v1/mail/folders — list all folders
mailRouter.get('/folders', async (req: Request, res: Response) => {
  const mailbox = await prisma.mailbox.findFirst({ where: { userId: req.apiUser!.userId } });
  if (!mailbox) { res.json([]); return; }

  const folders = await prisma.folder.findMany({
    where: { mailboxId: mailbox.id },
    select: {
      id: true, name: true, displayName: true, parentId: true,
      totalCount: true, unreadCount: true,
      isFavorite: true, sortOrder: true, color: true,
      retentionTagId: true,
      retentionTag: { select: { id: true, name: true, retentionDays: true, action: true } },
    },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
  res.json(folders.map((f) => ({ ...f, isSystem: SYSTEM_FOLDER_NAMES.has(f.name) })));
});

// POST /api/v1/mail/folders — create user folder
const CreateFolderSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[^/\\]+$/, 'Ungültiger Ordnername'),
  parentId: z.string().nullable().optional(),
  color: z.string().optional(),
});
/**
 * 9.1: a new folder name must not start with an IMAP namespace prefix
 * ("Shared/", "Other Users/", any case) — such a personal folder could never be
 * selected over IMAP. Renaming an existing one AWAY from the prefix stays possible.
 */
function rejectReservedFolderName(name: unknown, res: Response): boolean {
  if (typeof name !== 'string') return false;
  const prefix = reservedFolderPrefix(name);
  if (!prefix) return false;
  res.status(400).json({ error: reservedFolderNameError(prefix), code: 'RESERVED_FOLDER_NAME' });
  return true;
}

mailRouter.post('/folders', async (req: Request, res: Response) => {
  if (rejectReservedFolderName((req.body as { name?: unknown } | undefined)?.name, res)) return;
  const parsed = CreateFolderSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const mailbox = await prisma.mailbox.findFirst({ where: { userId: req.apiUser!.userId } });
  if (!mailbox) { res.status(404).json({ error: 'Mailbox not found' }); return; }

  if (SYSTEM_FOLDER_NAMES.has(parsed.data.name)) {
    res.status(400).json({ error: 'Reservierter Systemordner-Name' }); return;
  }

  const exists = await prisma.folder.findFirst({
    where: { mailboxId: mailbox.id, name: parsed.data.name },
  });
  if (exists) { res.status(409).json({ error: 'Ordner existiert bereits' }); return; }

  if (parsed.data.parentId) {
    const parent = await prisma.folder.findFirst({
      where: { id: parsed.data.parentId, mailboxId: mailbox.id },
    });
    if (!parent) { res.status(404).json({ error: 'Übergeordneter Ordner nicht gefunden' }); return; }
  }

  const folder = await prisma.folder.create({
    data: {
      mailboxId: mailbox.id,
      name: parsed.data.name,
      displayName: parsed.data.name,
      ...(parsed.data.parentId ? { parentId: parsed.data.parentId } : {}),
      ...(parsed.data.color ? { color: parsed.data.color } : {}),
    },
  });
  announceFolderListChange(mailbox.id);
  res.json(folder);
});

// PATCH /api/v1/mail/folders/:id — rename / favorite / sort / color
const PatchFolderSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[^/\\]+$/).optional(),
  isFavorite: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  color: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
});
mailRouter.patch('/folders/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  if (rejectReservedFolderName((req.body as { name?: unknown } | undefined)?.name, res)) return;
  const parsed = PatchFolderSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const folder = await prisma.folder.findFirst({
    where: { id, mailbox: { userId: req.apiUser!.userId } },
  });
  if (!folder) { res.status(404).json({ error: 'Folder not found' }); return; }

  if (parsed.data.name && SYSTEM_FOLDER_NAMES.has(folder.name)) {
    res.status(400).json({ error: 'Systemordner kann nicht umbenannt werden' }); return;
  }
  // 8.0.x: the new parent must be one of the caller's folders (same mailbox)
  // and must not create a cycle; system folders stay at the top level.
  if (parsed.data.parentId !== undefined && parsed.data.parentId !== folder.parentId) {
    if (SYSTEM_FOLDER_NAMES.has(folder.name)) {
      res.status(400).json({ error: 'Systemordner kann nicht verschoben werden' }); return;
    }
    if (parsed.data.parentId) {
      const check = await checkFolderParent(prisma as unknown as FolderLookup, id, parsed.data.parentId, folder.mailboxId);
      if (!check.ok) { res.status(check.status).json({ error: check.error }); return; }
    }
  }
  if (parsed.data.name && parsed.data.name !== folder.name) {
    const collision = await prisma.folder.findFirst({
      where: { mailboxId: folder.mailboxId, name: parsed.data.name, id: { not: id } },
    });
    if (collision) { res.status(409).json({ error: 'Name bereits vergeben' }); return; }
  }

  const updates: Record<string, unknown> = {};
  if (parsed.data.name !== undefined)       updates['name'] = parsed.data.name;
  if (parsed.data.name !== undefined)       updates['displayName'] = parsed.data.name;
  if (parsed.data.isFavorite !== undefined) updates['isFavorite'] = parsed.data.isFavorite;
  if (parsed.data.sortOrder !== undefined)  updates['sortOrder'] = parsed.data.sortOrder;
  if (parsed.data.color !== undefined)      updates['color'] = parsed.data.color;
  if (parsed.data.parentId !== undefined)   updates['parentId'] = parsed.data.parentId;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updated = await prisma.folder.update({ where: { id }, data: updates as any });
  announceFolderListChange(folder.mailboxId);
  res.json(updated);
});

// DELETE /api/v1/mail/folders/:id — delete a user folder. Without ?recursive=true its
// direct subfolders move up to its parent; with it the whole subtree is deleted. Live
// mail needs ?force=true (409 with { code, subfolders, count }).
mailRouter.delete('/folders/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };

  const folder = await prisma.folder.findFirst({
    where: { id, mailbox: { userId: req.apiUser!.userId } },
  });
  if (!folder) { res.status(404).json({ error: 'Folder not found' }); return; }
  if (SYSTEM_FOLDER_NAMES.has(folder.name)) {
    res.status(400).json({ error: 'Systemordner kann nicht gelöscht werden' }); return;
  }

  const opts = folderDeleteOptions(req.query);
  const refusal = await folderDeleteRefusal(folder, opts, SYSTEM_FOLDER_NAMES, 'reparent');
  if (refusal) { res.status(409).json(refusal); return; }

  // The messages of the deleted folder(s) go to Trash through the message store
  // before the folder rows are deleted (the Message→Folder cascade would remove
  // them without tombstone/modSeq).
  const done = await deleteFolder(folder, opts);
  if (!done.ok) { const f = folderDeleteFailure(done); res.status(f.status).json({ error: f.error }); return; }
  res.json({ ok: true, folders: done.folders, movedToTrash: done.moved, reparented: done.reparented });
});

// PATCH /api/v1/mail/folders/:id/retention-tag — assign / clear PERSONAL retention tag
// Body: { tagId: string | null }
const FolderRetentionTagSchema = z.object({ tagId: z.string().nullable() });
mailRouter.patch('/folders/:id/retention-tag', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const parsed = FolderRetentionTagSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  // Verify folder belongs to authenticated user's mailbox
  const folder = await prisma.folder.findFirst({
    where: { id, mailbox: { userId: req.apiUser!.userId } },
  });
  if (!folder) { res.status(404).json({ error: 'Folder not found' }); return; }

  // If tagId given, verify it's an assignable PERSONAL tag and enabled
  if (parsed.data.tagId) {
    const tag = await prisma.retentionTag.findFirst({
      where: { id: parsed.data.tagId, type: 'PERSONAL', enabled: true },
    });
    if (!tag) { res.status(404).json({ error: 'Retention tag not found or not assignable' }); return; }
  }

  const updated = await prisma.folder.update({
    where: { id },
    data: { retentionTagId: parsed.data.tagId },
    include: { retentionTag: { select: { id: true, name: true, retentionDays: true, action: true } } },
  });
  announceFolderListChange(folder.mailboxId);
  res.json({
    id: updated.id,
    retentionTagId: updated.retentionTagId,
    retentionTag: updated.retentionTag,
  });
});

// PATCH /api/v1/mail/messages/:id/retention-tag — assign / clear PERSONAL retention tag on a single message
// Body: { tagId: string | null }
mailRouter.patch('/messages/:id/retention-tag', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const parsed = FolderRetentionTagSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  // Verify message belongs to a folder in the user's mailbox
  const msg = await prisma.message.findFirst({
    where: { id, folder: { mailbox: { userId: req.apiUser!.userId } } },
  });
  if (!msg) { res.status(404).json({ error: 'Message not found' }); return; }

  if (parsed.data.tagId) {
    const tag = await prisma.retentionTag.findFirst({
      where: { id: parsed.data.tagId, type: 'PERSONAL', enabled: true },
    });
    if (!tag) { res.status(404).json({ error: 'Retention tag not found or not assignable' }); return; }
  }

  await prisma.$transaction((tx) => touchMessages(tx, [id], { retentionTagId: parsed.data.tagId }));
  const updated = await prisma.message.findUniqueOrThrow({
    where: { id },
    include: { retentionTag: { select: { id: true, name: true, retentionDays: true, action: true } } },
  });
  res.json({
    id: updated.id,
    retentionTagId: updated.retentionTagId,
    retentionTag: updated.retentionTag,
  });
});

// POST /api/v1/mail/folders/:id/empty — Trash/Junk: delete all messages (v8.1:
// expunge tombstones, recoverable for DELETED_ITEM_RETENTION_DAYS via
// /mail/recoverable); other folders: move to Trash
mailRouter.post('/folders/:id/empty', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };

  const folder = await prisma.folder.findFirst({
    where: { id, mailbox: { userId: req.apiUser!.userId } },
  });
  if (!folder) { res.status(404).json({ error: 'Folder not found' }); return; }

  const hardDelete = folder.name === 'Trash' || folder.name === 'Junk';

  if (hardDelete) {
    const live = await prisma.message.findMany({ where: { folderId: id, deletedAt: null }, select: { id: true } });
    await prisma.$transaction(async (tx) => {
      if (live.length > 0) await expunge(tx, live.map((m) => m.id), { mailboxId: folder.mailboxId, where: { folderId: id, deletedAt: null } });
      await tx.folder.update({ where: { id }, data: { totalCount: 0, unreadCount: 0 } });
    });
    res.json({ ok: true, deleted: live.length });
    return;
  }

  // Soft: move to Trash
  const mailbox = await prisma.mailbox.findFirst({ where: { userId: req.apiUser!.userId } });
  const trash = await prisma.folder.findFirst({ where: { mailboxId: mailbox!.id, name: 'Trash' } });
  if (!trash) { res.status(500).json({ error: 'Papierkorb nicht gefunden' }); return; }

  const messages = await prisma.message.findMany({
    where: { folderId: id, deletedAt: null },
    select: { id: true },
  });
  await prisma.$transaction(async (tx) => {
    await moveMessages(tx, messages.map((m) => m.id), trash.id, {
      targetMailboxId: trash.mailboxId, sourceMailboxId: folder.mailboxId,
    });
    await tx.folder.update({ where: { id }, data: { totalCount: 0, unreadCount: 0 } });
  });
  res.json({ ok: true, moved: messages.length });
});

// POST /api/v1/mail/messages/bulk — bulk actions across multiple messages
const BulkActionSchema = z.object({
  ids: z.array(z.string()).min(1).max(500),
  action: z.enum(['read', 'unread', 'flag', 'unflag', 'pin', 'unpin', 'move', 'delete', 'archive', 'spam', 'notSpam']),
  folderId: z.string().optional(), // for move
});
mailRouter.post('/messages/bulk', async (req: Request, res: Response) => {
  const parsed = BulkActionSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const { ids, action } = parsed.data;
  const userId = req.apiUser!.userId;

  // Authorize: own messages only
  const messages = await prisma.message.findMany({
    where: { id: { in: ids }, folder: { mailbox: { userId } } },
    select: { id: true, folderId: true, flags: true },
  });
  if (!messages.length) { res.status(404).json({ error: 'Keine Nachrichten gefunden' }); return; }
  const ownedIds = messages.map((m) => m.id);

  const mailbox = await prisma.mailbox.findFirst({ where: { userId } });
  const mailboxId = mailbox!.id;
  const resolveSysFolder = async (name: string) =>
    prisma.folder.findFirst({ where: { mailboxId, name } });
  // Moves get new UIDs in the target folder + a new modSeq (message store).
  const moveTo = (targetId: string, ids: string[], data?: { spamScore?: number }) =>
    prisma.$transaction((tx) => moveMessages(tx, ids, targetId, {
      targetMailboxId: mailboxId, sourceMailboxId: mailboxId, ...(data ? { data } : {}),
    }));

  switch (action) {
    case 'read':
    case 'unread': {
      const shouldRead = action === 'read';
      const updates = messages.map((m) => ({
        id: m.id,
        flags: shouldRead
          ? [...new Set([...m.flags, '\\Seen'])]
          : m.flags.filter((f) => f !== '\\Seen'),
      }));
      await prisma.$transaction((tx) => setFlags(tx, updates, { mailboxId }));
      break;
    }
    case 'flag':
    case 'unflag': {
      const shouldFlag = action === 'flag';
      const updates = messages.map((m) => ({
        id: m.id,
        flags: shouldFlag
          ? [...new Set([...m.flags, '\\Flagged'])]
          : m.flags.filter((f) => f !== '\\Flagged'),
      }));
      await prisma.$transaction((tx) => setFlags(tx, updates, { mailboxId }));
      break;
    }
    case 'pin':
    case 'unpin': {
      await prisma.$transaction((tx) => touchMessages(
        tx, ownedIds, { pinnedAt: action === 'pin' ? new Date() : null }, { mailboxId },
      ));
      break;
    }
    case 'move': {
      if (!parsed.data.folderId) { res.status(400).json({ error: 'folderId erforderlich' }); return; }
      const target = await prisma.folder.findFirst({
        where: { id: parsed.data.folderId, mailbox: { userId } },
      });
      if (!target) { res.status(404).json({ error: 'Zielordner nicht gefunden' }); return; }
      await moveTo(target.id, ownedIds);
      break;
    }
    case 'archive': {
      const archive = await resolveSysFolder('Archive');
      if (!archive) { res.status(404).json({ error: 'Archiv-Ordner nicht gefunden' }); return; }
      await moveTo(archive.id, ownedIds);
      break;
    }
    case 'delete': {
      const trash = await resolveSysFolder('Trash');
      // Already in Trash? → delete (v8.1: expunge tombstone — recoverable via
      // /mail/recoverable for DELETED_ITEM_RETENTION_DAYS)
      const inTrash = messages.filter((m) => m.folderId === trash?.id).map((m) => m.id);
      const notInTrash = messages.filter((m) => m.folderId !== trash?.id).map((m) => m.id);
      if (inTrash.length) {
        await prisma.$transaction((tx) => expunge(tx, inTrash, { mailboxId, where: { deletedAt: null } }));
      }
      if (notInTrash.length && trash) {
        await moveTo(trash.id, notInTrash);
      }
      break;
    }
    case 'spam': {
      const junk = await resolveSysFolder('Junk');
      if (!junk) { res.status(404).json({ error: 'Junk-Ordner nicht gefunden' }); return; }
      await moveTo(junk.id, ownedIds);
      // Add sender to the USER-JUNK blocklist → storeInboundMessage routes
      // future mails from this sender to the Junk folder automatically.
      // Scope 'USER-JUNK' is NOT treated as an SMTP reject by the security-filter,
      // it is only checked when storing (no bounce for the sender).
      void (async () => {
        try {
          const msgs = await prisma.message.findMany({
            where: { id: { in: ownedIds } },
            select: { fromAddr: true },
          });
          // stored canonical (IDN domain as A-label); delivery looks the entry up in both spellings
          const senders = [...new Set(msgs.map((m) => canonicalAddress(m.fromAddr)))];
          for (const sender of senders) {
            // an entry stored before 9.4 may use the Unicode spelling — one entry per sender
            const exists = await prisma.blacklist.findFirst({
              where: { scope: 'USER-JUNK', scopeId: req.apiUser!.userId, pattern: { in: addressVariants(sender) } },
            });
            if (!exists) {
              await prisma.blacklist.create({
                data: {
                  scope: 'USER-JUNK',
                  scopeId: req.apiUser!.userId,
                  pattern: sender,
                  patternType: 'EXACT',
                  comment: `Manuell als Junk markiert am ${new Date().toISOString().slice(0, 10)}`,
                },
              });
            }
          }
        } catch (err) {
          log.warn({ err }, 'USER-JUNK blacklist entry failed — ignored');
        }
      })();
      // rspamd Bayes learning (fire and forget) — improves spam detection over time
      void rspamdLearnBatch(ownedIds, 'learnspam', req.apiUser!.userId);
      break;
    }
    case 'notSpam': {
      const inbox = await resolveSysFolder('INBOX');
      if (!inbox) { res.status(404).json({ error: 'Posteingang nicht gefunden' }); return; }
      // Back to INBOX AND set spamScore to 0 (otherwise the reader banner
      // keeps showing "Diese Nachricht wurde als Spam erkannt" although it
      // was marked as ham)
      await moveTo(inbox.id, ownedIds, { spamScore: 0 });
      // Remove sender from the USER-JUNK blocklist (false positive)
      void (async () => {
        try {
          const msgs = await prisma.message.findMany({
            where: { id: { in: ownedIds } },
            select: { fromAddr: true },
          });
          const senders = [...new Set(msgs.flatMap((m) => addressVariants(m.fromAddr)))];
          await prisma.blacklist.deleteMany({
            where: { scope: 'USER-JUNK', scopeId: req.apiUser!.userId, pattern: { in: senders } },
          });
        } catch (err) {
          log.warn({ err }, 'USER-JUNK blacklist removal failed — ignored');
        }
      })();
      // rspamd Bayes learning: mark as ham
      void rspamdLearnBatch(ownedIds, 'learnham', req.apiUser!.userId);
      break;
    }
  }

  res.json({ ok: true, affected: ownedIds.length });
});

// POST /api/v1/mail/messages/:id/snooze — hide until date
const SnoozeSchema = z.object({ until: isoDateTime() });
mailRouter.post('/messages/:id/snooze', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const parsed = SnoozeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const msg = await prisma.message.findFirst({
    where: { id, folder: { mailbox: { userId: req.apiUser!.userId } } },
  });
  if (!msg) { res.status(404).json({ error: 'Message not found' }); return; }

  await prisma.$transaction((tx) => touchMessages(tx, [id], { snoozeUntil: new Date(parsed.data.until) }));
  res.json({ ok: true });
});

// DELETE /api/v1/mail/messages/:id/snooze — clear snooze
mailRouter.delete('/messages/:id/snooze', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const msg = await prisma.message.findFirst({
    where: { id, folder: { mailbox: { userId: req.apiUser!.userId } } },
  });
  if (!msg) { res.status(404).json({ error: 'Message not found' }); return; }
  await prisma.$transaction((tx) => touchMessages(tx, [id], { snoozeUntil: null }));
  res.json({ ok: true });
});

// GET /api/v1/mail/attachments/:id — attachment download (own, shared, delegated
// mailboxes; streamed from object storage; see lib/attachment-download.ts)
mailRouter.get('/attachments/:id', createAttachmentDownloadHandler({
  findAttachment: (id, userId) => prisma.attachment.findFirst({
    where: { id, message: { deletedAt: null, folder: { mailbox: readableMailboxWhere(userId) } } },
    select: { id: true, filename: true, mimeType: true, size: true, storagePath: true },
  }),
  openStream: getObjectStream,
  warn: (msg, err) => log.warn({ err }, msg),
}));

// GET /api/v1/mail/image-proxy?url=<http(s) URL> — external images for "show images"
// (8.0.x; SSRF-safe, image types only, per-user rate limit — lib/image-proxy.ts)
const imageProxyLimiter = createUserRateLimiter({
  scope: 'image-proxy',
  limit: envInt('IMAGE_PROXY_RATE_LIMIT', 120),
  windowSec: Math.max(1, envInt('IMAGE_PROXY_RATE_WINDOW_SEC', 60)),
});
mailRouter.get('/image-proxy', createImageProxyHandler({ allow: (userId) => imageProxyLimiter.hit(userId) }));

// GET /api/v1/mail/messages/:id/raw — RFC 822 raw EML / source view
mailRouter.get('/messages/:id/raw', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const msg = await prisma.message.findFirst({
    where: { id, folder: { mailbox: { userId: req.apiUser!.userId } } },
    include: { attachments: true },
  });
  if (!msg) { res.status(404).json({ error: 'Message not found' }); return; }

  // The original RFC 5322 octets (legacy rows: deterministic, sanitized reconstruction).
  try {
    const raw = await loadRawMessage(msg);
    res.setHeader('Content-Type', 'message/rfc822');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', contentDisposition('attachment', `${msg.subject || 'message'}.eml`));
    res.send(raw);
    return;
  } catch (err) {
    log.warn({ err, id }, 'Raw message not readable');
    res.status(503).json({ error: 'Message source temporarily unavailable' });
    return;
  }
});

/** Parses `?limit=&offset=` for list endpoints: limit 1..200 (default 50), offset ≥ 0. */
export function parsePaging(query: Request['query']): { limit: number; offset: number } {
  const rawLimit = parseInt(String(query['limit'] ?? '50'), 10);
  const rawOffset = parseInt(String(query['offset'] ?? '0'), 10);
  return {
    limit: Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50,
    offset: Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0,
  };
}

// Columns returned by the message list and the search endpoint (MessageSummary)
export const MESSAGE_SUMMARY_SELECT = {
  id: true, uid: true, subject: true, fromAddr: true, fromName: true, toAddrs: true,
  date: true, flags: true, rawSize: true, pinnedAt: true, snoozeUntil: true,
  spamScore: true, scheduledAt: true, scheduledStatus: true, folderId: true,
  attachments: { select: { id: true, filename: true, mimeType: true, size: true, contentId: true, inline: true } },
  categories: { select: { category: { select: { id: true, name: true, color: true } } } },
} as const;

// GET /api/v1/mail/folders/:folderId/messages?limit=&offset=
mailRouter.get('/folders/:folderId/messages', async (req: Request, res: Response) => {
  const { folderId } = req.params as { folderId: string };
  const { limit, offset } = parsePaging(req.query);

  
  const folder = await prisma.folder.findFirst({
    where: { id: folderId, mailbox: { userId: req.apiUser!.userId } },
  });
  if (!folder) { res.status(404).json({ error: 'Folder not found' }); return; }

  const now = new Date();
  // Snooze: only in the inbox, hide mails that are still "snoozing" into the future
  const snoozeFilter = folder.name === 'INBOX'
    ? { OR: [{ snoozeUntil: null }, { snoozeUntil: { lte: now } }] }
    : {};

  const [messages, total] = await Promise.all([
    prisma.message.findMany({
      where: { folderId, deletedAt: null, ...snoozeFilter },
      // 9.4: ?sort=&dir= (webmail sort setting); default date, newest first
      orderBy: messageOrderBy(req.query),
      take: limit,
      skip: offset,
      select: MESSAGE_SUMMARY_SELECT,
    }),
    prisma.message.count({ where: { folderId, deletedAt: null, ...snoozeFilter } }),
  ]);

  // Flatten the categories relation
  const flat = messages.map((m) => ({
    ...m,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    categories: (m as any).categories?.map((c: any) => c.category) ?? [],
  }));

  res.json({ messages: flat, total, limit, offset });
});

// GET /api/v1/mail/messages/:id — full message
mailRouter.get('/messages/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  
  const msg = await prisma.message.findFirst({
    where: { id, deletedAt: null, folder: { mailbox: { userId: req.apiUser!.userId } } },
    include: { attachments: true },
  });
  if (!msg) { res.status(404).json({ error: 'Message not found' }); return; }

  // Mark as read (9.4: not with ?markRead=false — the webmail decides itself)
  if (markReadRequested(req.query) && !msg.flags.includes('\\Seen')) {
    await prisma.$transaction((tx) => setFlags(tx, [{ id, flags: [...msg.flags, '\\Seen'] }]));
    await prisma.folder.update({
      where: { id: msg.folderId },
      data: { unreadCount: { decrement: 1 } },
    });
  }

  res.json(msg);
});

// PATCH /api/v1/mail/messages/:id — update flags / move
const PatchMessageSchema = z.object({
  flags: z.array(z.string()).optional(),
  folderId: z.string().optional(),
  read: z.boolean().optional(),
  flagged: z.boolean().optional(),
});

mailRouter.patch('/messages/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const parsed = PatchMessageSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  
  const msg = await prisma.message.findFirst({
    where: { id, folder: { mailbox: { userId: req.apiUser!.userId } } },
  });
  if (!msg) { res.status(404).json({ error: 'Message not found' }); return; }

  let newFlags = [...msg.flags];

  if (parsed.data.read !== undefined) {
    newFlags = parsed.data.read
      ? [...new Set([...newFlags, '\\Seen'])]
      : newFlags.filter((f) => f !== '\\Seen');
  }
  if (parsed.data.flagged !== undefined) {
    newFlags = parsed.data.flagged
      ? [...new Set([...newFlags, '\\Flagged'])]
      : newFlags.filter((f) => f !== '\\Flagged');
  }
  if (parsed.data.flags) newFlags = parsed.data.flags;

  let targetFolder: { id: string; mailboxId: string } | null = null;
  if (parsed.data.folderId) {
    targetFolder = await prisma.folder.findFirst({
      where: { id: parsed.data.folderId, mailbox: { userId: req.apiUser!.userId } },
      select: { id: true, mailboxId: true },
    });
    if (!targetFolder) { res.status(404).json({ error: 'Target folder not found' }); return; }
  }

  // Flag change → new modSeq; move → new UID in the target folder + new modSeq.
  await prisma.$transaction(async (tx) => {
    if (targetFolder && targetFolder.id !== msg.folderId) {
      await moveMessages(tx, [id], targetFolder.id, { targetMailboxId: targetFolder.mailboxId, data: { flags: newFlags } });
    } else {
      await setFlags(tx, [{ id, flags: newFlags }]);
    }
  });
  res.json({ ok: true });
});

// DELETE /api/v1/mail/messages/:id — soft delete
mailRouter.delete('/messages/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const hard = req.query['hard'] === 'true';

  
  const msg = await prisma.message.findFirst({
    where: { id, folder: { mailbox: { userId: req.apiUser!.userId } } },
  });
  if (!msg) { res.status(404).json({ error: 'Message not found' }); return; }

  const mailbox = await prisma.mailbox.findFirst({ where: { userId: req.apiUser!.userId } });
  const mailboxId = mailbox!.id;
  if (hard) {
    // v8.1: "permanent" delete keeps a tombstone (Recover deleted items)
    await prisma.$transaction((tx) => expunge(tx, [id], { mailboxId }));
  } else {
    // Move to Trash (new UID + modSeq), or soft-delete when there is no Trash
    const trash = await prisma.folder.findFirst({ where: { mailboxId, name: 'Trash' } });
    if (trash) {
      await prisma.$transaction((tx) => moveMessages(tx, [id], trash.id, { targetMailboxId: mailboxId, sourceMailboxId: mailboxId }));
    } else {
      await prisma.$transaction((tx) => expunge(tx, [id], { mailboxId }));
    }
  }

  await prisma.folder.update({
    where: { id: msg.folderId },
    data: { totalCount: { decrement: 1 } },
  }).catch(() => undefined);

  res.json({ ok: true });
});

// POST /api/v1/mail/send — compose and send (multipart/form-data with optional attachments)
mailRouter.post(
  '/send',
  // 8.0.x: per-user send rate (MAIL_SEND_RATE_LIMIT / MAIL_SEND_RATE_WINDOW_SEC)
  sendRateLimiter.middleware,
  // Multer middleware: processes multipart/form-data; no intervention for application/json
  // (JSON bodies are capped by express.json()). 8.0.x: the whole request is capped
  // at the configured max. message size (lib/send-limits.ts).
  (req: Request, res: Response, next: NextFunction) => {
    const ct = req.headers['content-type'] ?? '';
    if (ct.startsWith('application/json')) { next(); return; }
    sendUploadMiddleware(req, res, next);
  },
  async (req: Request, res: Response) => {
    // Read fields from JSON body OR multipart form
    let to: string[];
    let cc: string[];
    let bcc: string[];
    let subject: string;
    let bodyHtml: string;
    let bodyText: string;
    let inReplyTo: string | undefined;
    let referencesRaw: unknown;
    let scheduledAt: Date | null = null;
    let sendAsAddress: string | null = null;     // shared mailbox address as sender (SEND_AS)
    let sendOnBehalfOf: string | null = null;    // shared mailbox address as „on behalf of" (SEND_ON_BEHALF)
    let requestReceipt = false;                  // 9.4: Disposition-Notification-To
    let importance: Importance = 'normal';       // 9.4: Importance / X-Priority
    let sensitivity: Sensitivity = 'normal';     // 9.4: Sensitivity header
    let requestDeliveryReceipt = false;          // 9.4: success DSN (NOTIFY=SUCCESS,FAILURE)

    const ct = req.headers['content-type'] ?? '';
    if (ct.startsWith('application/json')) {
      const schema = z.object({
        to: z.array(z.string()),
        cc: z.array(z.string()).optional(),
        bcc: z.array(z.string()).optional(),
        subject: z.string(),
        bodyHtml: z.string().optional(),
        bodyText: z.string().optional(),
        inReplyTo: z.string().optional(),
        references: z.union([z.array(z.string()), z.string()]).optional(),
        scheduledAt: isoDateTime().optional(),
        sendAs:        z.string().email().optional(),
        sendOnBehalfOf: z.string().email().optional(),
        requestReceipt: z.boolean().optional(),
        requestDeliveryReceipt: z.boolean().optional(),
        importance: z.enum(['high', 'normal', 'low']).optional(),
        sensitivity: z.enum(['normal', 'personal', 'private', 'confidential']).optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }
      to       = parsed.data.to;
      cc       = parsed.data.cc ?? [];
      bcc      = parsed.data.bcc ?? [];
      subject  = parsed.data.subject;
      bodyHtml = parsed.data.bodyHtml ?? '';
      bodyText = parsed.data.bodyText ?? '';
      inReplyTo = parsed.data.inReplyTo;
      referencesRaw = parsed.data.references;
      if (parsed.data.scheduledAt)    scheduledAt    = new Date(parsed.data.scheduledAt);
      if (parsed.data.sendAs)         sendAsAddress  = parsed.data.sendAs.toLowerCase();
      if (parsed.data.sendOnBehalfOf) sendOnBehalfOf = parsed.data.sendOnBehalfOf.toLowerCase();
      requestReceipt = parsed.data.requestReceipt === true;
      requestDeliveryReceipt = parsed.data.requestDeliveryReceipt === true;
      importance = normalizeImportance(parsed.data.importance);
      sensitivity = normalizeSensitivity(parsed.data.sensitivity);
    } else {
      // multipart — fields arrive as strings (arrays as comma-separated list)
      to       = parseAddrs(req.body['to'] as unknown);
      cc       = parseAddrs(req.body['cc'] as unknown);
      bcc      = parseAddrs(req.body['bcc'] as unknown);
      subject  = String(req.body['subject'] ?? '');
      bodyHtml = String(req.body['bodyHtml'] ?? '');
      bodyText = String(req.body['bodyText'] ?? '');
      inReplyTo = req.body['inReplyTo'] ? String(req.body['inReplyTo']) : undefined;
      referencesRaw = req.body['references'] as unknown;
      if (req.body['scheduledAt']) {
        const d = new Date(String(req.body['scheduledAt']));
        if (!isNaN(d.getTime())) scheduledAt = d;
      }
      if (req.body['sendAs'])         sendAsAddress  = String(req.body['sendAs']).toLowerCase();
      if (req.body['sendOnBehalfOf']) sendOnBehalfOf = String(req.body['sendOnBehalfOf']).toLowerCase();
      requestReceipt = String(req.body['requestReceipt'] ?? '') === 'true';
      requestDeliveryReceipt = String(req.body['requestDeliveryReceipt'] ?? '') === 'true';
      importance = normalizeImportance(req.body['importance']);
      sensitivity = normalizeSensitivity(req.body['sensitivity']);
    }

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const out = await performSend(req.apiUser!.userId, {
      to, cc, bcc, subject, bodyHtml, bodyText, inReplyTo, referencesRaw, scheduledAt,
      sendAs: sendAsAddress, sendOnBehalfOf, requestReceipt, requestDeliveryReceipt, importance, sensitivity,
      attachments: files.map((f) => ({ filename: f.originalname, contentType: f.mimetype, size: f.size, buffer: f.buffer })),
    });
    res.status(out.status).json(out.body);
  },
);

// ── Send core (POST /send and POST /drafts/:id/send) ─────────────────────────
// One implementation of every send check (recipients, references, schedule
// window, sender identity) and of the enqueue step, so a draft is sent exactly
// like a mail from /send. Routes add the transport concerns (rate limit, body
// size limit) as middleware.

export interface SendAttachment {
  filename: string;
  contentType: string;
  size: number;
  /** In-memory upload (POST /send) … */
  buffer?: Buffer | undefined;
  /** … or an existing object-store key (draft attachment). Copied to the outbound key, never moved. */
  storagePath?: string | undefined;
  /** 8.1: Content-ID without angle brackets (inline image referenced as cid: in the HTML). */
  cid?: string | undefined;
  /** 8.1: Content-Disposition inline. */
  inline?: boolean | undefined;
}

export interface EnqueuedSend {
  userId: string;
  jobId: string;
  queueJobId: string;
  /** Message-ID header of the sent mail. */
  messageId: string;
  /** Time the worker sends (scheduledAt or the end of the undo hold), null = now. */
  sendAt: Date | null;
}

export interface SendRequest {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyHtml: string;
  bodyText: string;
  inReplyTo?: string | undefined;
  referencesRaw?: unknown;
  scheduledAt?: Date | null;
  /**
   * Undo-send hold in ms (drafts, 0–MAX_SEND_HOLD_MS): enqueued with a BullMQ
   * delay without the 30 s minimum of scheduledAt, so it can still be cancelled.
   */
  holdMs?: number;
  sendAs?: string | null;
  sendOnBehalfOf?: string | null;
  /** 9.4: ask for a read receipt (Disposition-Notification-To: the From address). */
  requestReceipt?: boolean;
  /** 9.4: Importance / X-Priority of the mail (normal: no header). */
  importance?: Importance;
  /** 9.4: Sensitivity header of the mail (normal: no header). */
  sensitivity?: Sensitivity;
  /**
   * 9.4: delivery receipt — a success DSN per recipient (NOTIFY=SUCCESS,FAILURE):
   * the worker reports local deliveries itself and passes the request on to a
   * next hop that supports DSN ("relayed" when it does not).
   */
  requestDeliveryReceipt?: boolean;
  attachments: SendAttachment[];
  /** Message-ID header to use (a draft keeps its own); default: a new one. */
  messageId?: string | null;
  /**
   * Replaces the default Sent copy. Awaited, and runs only after the outbound
   * job was enqueued (drafts: the draft itself becomes the Sent copy).
   */
  afterEnqueue?: (info: EnqueuedSend) => Promise<void>;
}

export interface SendResult { status: number; body: Record<string, unknown> }

export const MAX_SEND_HOLD_MS = 30_000;

export type SenderResolution =
  | { ok: true; fromEmail: string; fromName: string; onBehalfHeader: string | null }
  | { ok: false; status: 403; error: string };

/**
 * From/Sender of an outgoing mail (v3.18.9): own address, or a shared mailbox
 * with SEND_AS/FULL_ACCESS (sendAs) or SEND_ON_BEHALF (sendOnBehalfOf).
 */
export async function resolveSender(
  user: { id: string; email: string; displayName: string | null },
  sendAsAddress: string | null,
  sendOnBehalfOf: string | null,
): Promise<SenderResolution> {
  if (sendAsAddress) {
    const sharedPerm = await prisma.sharedMailboxPerm.findFirst({
      where: {
        userId: user.id,
        permission: { in: ['SEND_AS', 'FULL_ACCESS'] },
        sharedMailbox: { email: sendAsAddress, active: true },
      },
      include: { sharedMailbox: { select: { email: true, displayName: true } } },
    });
    if (!sharedPerm) return { ok: false, status: 403, error: `Keine SEND_AS-Berechtigung für ${sendAsAddress}` };
    return { ok: true, fromEmail: sharedPerm.sharedMailbox.email, fromName: sharedPerm.sharedMailbox.displayName, onBehalfHeader: null };
  }
  if (sendOnBehalfOf) {
    const sharedPerm = await prisma.sharedMailboxPerm.findFirst({
      where: {
        userId: user.id,
        permission: 'SEND_ON_BEHALF',
        sharedMailbox: { email: sendOnBehalfOf, active: true },
      },
      include: { sharedMailbox: { select: { email: true, displayName: true } } },
    });
    if (!sharedPerm) return { ok: false, status: 403, error: `Keine SEND_ON_BEHALF-Berechtigung für ${sendOnBehalfOf}` };
    // For „on behalf of": From=Shared, Sender=User → RFC 5322 §3.6.2
    const own = (user.displayName ?? '').trim();
    return {
      ok: true,
      fromEmail: sharedPerm.sharedMailbox.email,
      fromName: sharedPerm.sharedMailbox.displayName,
      onBehalfHeader: `${own ? `"${own}" ` : ''}<${user.email}>`,
    };
  }
  return { ok: true, fromEmail: user.email, fromName: (user.displayName ?? '').trim(), onBehalfHeader: null };
}

/**
 * A webmail message as it is sent: the `message` of the outbound job (without
 * attachments; smtp-server outbound/queue.ts StructuredMessage).
 */
export interface OutgoingMessage {
  from: string;
  fromName: string;
  sender?: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  text: string;
  messageId: string;
  /** ISO date */
  date: string;
  inReplyTo?: string;
  references?: string;
  /** 9.4: Disposition-Notification-To (read receipt request) — the sender's address. */
  dispositionNotificationTo?: string;
  /** 9.4: importance chosen in compose (high / low; normal writes no header). */
  importance?: 'high' | 'low';
  /** 9.4: sensitivity chosen in compose (normal writes no header). */
  sensitivity?: Exclude<Sensitivity, 'normal'>;
}

/**
 * Pure (9.4): MIME options of the sender's own Sent copy — the From, Sender,
 * Date, Message-ID and reply fields exactly as the outbound worker builds them
 * from the job's message (smtp-server buildRawFromMessage), plus Bcc, which
 * only the sender's copy keeps. Mail sent as / on behalf of a Shared Mailbox
 * therefore shows the box (and the user as Sender) in the user's Sent folder.
 */
export function sentCopyMailOptions(msg: OutgoingMessage, attachments: SendMailOptions['attachments'] = []): SendMailOptions {
  return {
    messageId: msg.messageId,
    from:      msg.fromName ? { name: msg.fromName, address: msg.from } : msg.from,
    ...(msg.sender ? { sender: msg.sender } : {}),
    to:        msg.to,
    subject:   msg.subject,
    date:      new Date(msg.date),
    ...(msg.cc.length  ? { cc: msg.cc }   : {}),
    ...(msg.bcc.length ? { bcc: msg.bcc } : {}),
    ...(msg.html       ? { html: msg.html } : {}),
    ...(msg.text       ? { text: msg.text } : {}),
    ...(msg.inReplyTo  ? { inReplyTo: msg.inReplyTo, references: msg.references ?? msg.inReplyTo } : {}),
    ...importanceMailOption(normalizeImportance(msg.importance)),
    ...(msg.sensitivity ? { headers: sensitivityHeaders(normalizeSensitivity(msg.sensitivity)) } : {}),
    ...(attachments && attachments.length ? { attachments } : {}),
  };
}

/** Pure (9.4): size estimate of an outgoing webmail message for the per-mailbox send limit. */
export function estimatedSendSize(bodyHtml: string, bodyText: string, files: ReadonlyArray<{ size: number }>): number {
  return Buffer.byteLength(bodyHtml ?? '') + Buffer.byteLength(bodyText ?? '') + files.reduce((n, f) => n + (f.size || 0), 0);
}

/** Validates and enqueues one outgoing mail (BullMQ `smtp-outbound`) + Sent copy. */
export async function performSend(userId: string, input: SendRequest): Promise<SendResult> {
    const { to, cc, bcc, subject, bodyHtml, bodyText, inReplyTo } = input;
    const scheduledAt = input.scheduledAt ?? null;
    const holdMs = input.holdMs ?? 0;
    const fail = (status: number, body: Record<string, unknown>): SendResult => ({ status, body });

    if (!to.length) return fail(400, { error: 'Kein Empfänger angegeben' });
    // Optional client References chain (validated <msg-id> list, max 50, no CR/LF)
    const clientRefs = parseClientReferences(input.referencesRaw);
    if (!clientRefs.ok) return fail(400, { error: clientRefs.error });
    // 8.0.x: recipient count + syntax (header injection, envelope abuse)
    // 9.4: the submission limits shared with JMAP, ActiveSync and MAPI (storage
    // submissionLimitsForUser: global size / SMTP recipient limit, a per-mailbox
    // MailFlowPolicy value replaces them); MAIL_SEND_MAX_RECIPIENTS stays the request's
    // upper bound and the body guard (global size) the transport's.
    const limits = await submissionLimitsForUser(userId);
    const rcptCheck = checkRecipients([to, cc, bcc], Math.min(limits.maxRecipients, maxRecipients()));
    if (!rcptCheck.ok) {
      return fail(400, { error: rcptCheck.error, ...(rcptCheck.invalid ? { invalid: rcptCheck.invalid } : {}) });
    }
    if (!Number.isFinite(holdMs) || holdMs < 0 || holdMs > MAX_SEND_HOLD_MS) {
      return fail(400, { error: `Sendeverzögerung muss zwischen 0 und ${MAX_SEND_HOLD_MS / 1000} Sekunden liegen` });
    }
    if (holdMs > 0 && scheduledAt) return fail(400, { error: 'Sendeverzögerung und geplanter Versand schließen sich aus' });

    // Schedule-send validation: time must be in the future (>30s),
    // not more than 1 year ahead (otherwise probably an error)
    const now = Date.now();
    if (scheduledAt) {
      const delayMs = scheduledAt.getTime() - now;
      if (delayMs < 30_000) {
        return fail(400, { error: 'Geplanter Versand muss mindestens 30 Sekunden in der Zukunft liegen' });
      }
      if (delayMs > 365 * 24 * 60 * 60 * 1000) {
        return fail(400, { error: 'Geplanter Versand darf nicht mehr als 1 Jahr in der Zukunft liegen' });
      }
    }

    // Load sender (incl. the domain's DKIM key)
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { domain: true },
    });
    if (!user) return fail(404, { error: 'Benutzer nicht gefunden' });

    // v8.1: ProhibitSendQuota (same check as SMTP submission, JMAP and EAS).
    // Inside performSend: covers /mail/send, send-from-draft and the undo-send hold.
    const sendQuota = await checkSendQuota(user.id);
    if (!sendQuota.allowed) {
      return fail(403, {
        error: sendQuota.message,
        code: 'MAILBOX_QUOTA_EXCEEDED',
        usedBytes: sendQuota.status.usedBytes,
        limitBytes: sendQuota.status.limits.prohibitSendBytes,
      });
    }

    // ── Shared-mailbox permission check (v3.18.9) ──────────────────────────
    const sender = await resolveSender(user, input.sendAs ?? null, input.sendOnBehalfOf ?? null);
    if (!sender.ok) return fail(sender.status, { error: sender.error });
    const effectiveFromEmail = sender.fromEmail;
    const onBehalfHeader     = sender.onBehalfHeader;

    // 8.0.x: In-Reply-To/References from the parent's Message-ID (never an internal id)
    // The client's References list (when sent) wins over the server-resolved chain.
    const reply = await resolveReplyHeaders(inReplyTo, user.id, replyLookup, clientRefs.refs);
    const replyRefs = reply.references ?? reply.inReplyTo;
    const replyHeaders = {
      ...(reply.inReplyTo ? { inReplyTo: reply.inReplyTo } : {}),
      ...(replyRefs ? { references: replyRefs } : {}),
    };

    const files       = input.attachments;
    if (estimatedSendSize(bodyHtml, bodyText, files) > limits.maxBytes) {
      return fail(413, { error: 'Die Nachricht überschreitet die Größenbeschränkung des Postfachs', maxBytes: limits.maxBytes });
    }
    const jobId       = crypto.randomUUID();
    const msgId       = input.messageId || `<${crypto.randomUUID()}@${user.domain.name}>`;
    const sendDate    = new Date();
    const displayName = sender.fromName;

    // ── Upload attachments to MinIO (no base64 blob in the Redis job) ────────
    // This keeps the BullMQ job small; the worker downloads the attachments
    // from MinIO when building the RFC 5322 message. The worker deletes these
    // keys after delivery, so stored (draft) attachments are copied, not referenced.
    const queueAttachments = await Promise.all(
      files.map(async (f, index) => {
        // v7.1: index-based key — the user's file name (kept in `filename`) never
        // becomes a storage path (filesystem driver), and equal names do not collide.
        const minioPath = outboundAttachKey(jobId, String(index));
        if (f.buffer) {
          await uploadBuffer(minioPath, f.buffer, f.contentType);
        } else if (f.storagePath) {
          await getObjectStore().putStream(minioPath, await getObjectStream(f.storagePath), { contentType: f.contentType, size: f.size });
        }
        return {
          filename:    f.filename,
          minioPath,
          contentType: f.contentType,
          size:        f.size,
          // 8.1: inline images (worker: cid + Content-Disposition inline)
          ...(f.cid ? { cid: f.cid.replace(/^<|>$/g, '') } : {}),
          ...(f.inline ? { inline: true } : {}),
        };
      })
    );

    // ── BullMQ job: structured message (v3.17.30+) ───────────────────────────
    // No more rawMessage (base64 blob) — the worker builds the RFC 5322 buffer
    // itself. DKIM signing happens via the nodemailer transport option.
    // 9.4: the envelope carries bare addresses (a picked contact is "Name <a@b>";
    // as RCPT TO it was neither recognised as local nor a valid path)
    const smtpRecipients = envelopeRecipients([to, cc, bcc]);

    // BullMQ job: with scheduledAt enqueue with `delay` — the worker starts
    // sending only at the scheduled time. delay is measured internally in ms.
    // An undo-send hold uses the same mechanism (cancellable while delayed).
    const queueJobId = `api-${jobId}`;
    const jobOptions: Awaited<ReturnType<typeof getOutboundJobOptions>> & { jobId: string; delay?: number } = { ...(await getOutboundJobOptions()), jobId: queueJobId };
    if (scheduledAt) {
      jobOptions.delay = scheduledAt.getTime() - now;
    } else if (holdMs > 0) {
      jobOptions.delay = holdMs;
    }
    const sendAt = scheduledAt ?? (holdMs > 0 ? new Date(now + holdMs) : null);
    // The message as sent: the worker builds the MIME from it, and the sender's
    // own Sent copy below is built from the same fields (sentCopyMailOptions).
    const outgoing: OutgoingMessage = {
      from:      effectiveFromEmail,
      fromName:  displayName,          // empty → nodemailer omits the quoted string
      ...(onBehalfHeader ? { sender: onBehalfHeader } : {}),  // RFC 5322 §3.6.2 „Sender:" header
      to,
      cc,
      bcc,                             // only in the SMTP envelope, not in the header
      subject,
      html:      bodyHtml,
      text:      bodyText,
      messageId: msgId,
      // For schedule-send: set the Date header to scheduledAt so that the
      // recipient sees the scheduled send time (not the creation time)
      date:      (scheduledAt ?? sendDate).toISOString(),
      ...replyHeaders,
      ...(input.requestReceipt ? { dispositionNotificationTo: effectiveFromEmail } : {}),
      ...(input.importance && input.importance !== 'normal' ? { importance: input.importance } : {}),
      ...(input.sensitivity && input.sensitivity !== 'normal' ? { sensitivity: input.sensitivity } : {}),
    };
    try {
      await getOutboundQueue().add('send', {
        messageId:    jobId,
        from:         effectiveFromEmail,
        to:           smtpRecipients,
        senderUserId: user.id,
        // 9.4: send as / on behalf of a Shared Mailbox → audit + its Sent copy in the worker
        ...(input.sendAs || input.sendOnBehalfOf ? { foreignSendSource: 'webmail' } : {}),
        ...(input.requestDeliveryReceipt ? { dsn: deliveryReceiptDsn(smtpRecipients) } : {}),
        ...(user.domain.dkimPrivateKey ? {
          dkimDomain:     user.domain.name,
          dkimSelector:   user.domain.dkimSelector ?? 'mail',
          dkimPrivateKey: user.domain.dkimPrivateKey,
        } : {}),
        message: { ...outgoing, attachments: queueAttachments },
      }, jobOptions);
    } catch (queueErr) {
      log.error({ err: queueErr }, 'Outbound queue add failed');
      return fail(500, { error: 'Nachricht konnte nicht in die Warteschlange eingereiht werden' });
    }

    // ── MAIL_FLOW — ACCEPTED log ──────────────────────────────────────────────
    void prisma.systemLog.create({
      data: {
        level:    'INFO',
        service:  'api-gateway',
        category: 'MAIL_FLOW',
        message:  `Sent: ${user.email} → ${smtpRecipients.join(', ')}`,
        userId:   user.id,
        metadata: {
          sender:    user.email,
          recipient: smtpRecipients.join(', '),
          subject,
          status:    'ACCEPTED',
          messageId: jobId,
          direction: 'OUTBOUND',
        },
      },
    }).catch((e: unknown) => log.error({ err: e }, 'MAIL_FLOW log write failed'));

    if (input.afterEnqueue) {
      try {
        await input.afterEnqueue({ userId: user.id, jobId, queueJobId, messageId: msgId, sendAt });
      } catch (e) {
        // 8.1: the mail IS queued, but its state could not be recorded. Not a
        // 200 (the client must know), and `queued: true` tells it not to resend.
        log.error({ err: e, jobId }, 'Post-enqueue step failed — mail queued, state not saved');
        return fail(500, {
          error: 'Die Nachricht wurde gesendet, ihr Status konnte aber nicht gespeichert werden',
          code: 'SEND_STATE_UNSAVED', queued: true, jobId,
        });
      }
    } else {
    // ── Save copy to Sent Items ──────────────────────────────────────────────
    // The RFC 5322 buffer is built separately here (with in-memory attachments, not MinIO)
    // so the Sent copy is available immediately without waiting for the worker.
    void (async () => {
      try {
        const mailbox = await prisma.mailbox.findFirst({
          where: { userId: user.id },
          include: { folders: true },
        });
        const sentFolder = mailbox?.folders.find((f: { name: string }) => f.name === 'Sent');
        if (!sentFolder || !mailbox) return;

        // Raw buffer for the Sent copy with in-memory attachments
        const sentAttachments: SendMailOptions['attachments'] = await Promise.all(files.map(async (f) => ({
          filename:    f.filename,
          content:     f.buffer ?? await downloadBuffer(f.storagePath ?? ''),
          contentType: f.contentType,
          ...(f.cid ? { cid: f.cid.replace(/^<|>$/g, '') } : {}),
          ...(f.inline ? { contentDisposition: 'inline' as const } : {}),
        })));
        // 9.4: From / Sender / Date as sent (send as / on behalf of a Shared
        // Mailbox shows the box, not the user's own address), plus Bcc.
        const rawBuffer = await buildRawMime(sentCopyMailOptions(outgoing, sentAttachments));

        const parsed = await parseRawMessage(rawBuffer);

        // Raw-always storage (IMAP/POP3/JMAP serve these octets).
        const { storagePath } = await storeRawMessage(rawBuffer);

        // UID + modSeq are allocated atomically by the message store.
        const sentCopy = await prisma.$transaction((tx) => createMessage(tx, mailbox.id, sentFolder.id, {
            flags:     ['\\Seen'],
            subject:   parsed.subject,
            fromAddr:  parsed.fromAddr,
            fromName:  parsed.fromName,
            toAddrs:   parsed.toAddrs,
            ccAddrs:   parsed.ccAddrs,
            bccAddrs:  parsed.bccAddrs,
            replyTo:   parsed.replyTo,
            messageId: parsed.messageId,
            inReplyTo: parsed.inReplyTo,
            ...(parsed.importance ? { importance: parsed.importance } : {}),
            ...(parsed.sensitivity ? { sensitivity: parsed.sensitivity } : {}),
            date:      parsed.date,
            bodyText:  truncateBodyColumn(parsed.bodyText),
            bodyHtml:  truncateBodyColumn(parsed.bodyHtml),
            rawSize:   rawBuffer.length,
            storagePath,
            // Schedule-send metadata: enables banner + cancel button in the reader
            ...(scheduledAt ? {
              scheduledAt,
              scheduledStatus: 'PENDING',
              scheduledJobId:  queueJobId,
            } : {}),
        }));
        await prisma.folder.update({
          where: { id: sentFolder.id },
          data: { totalCount: { increment: 1 }, changeKey: sentCopy.modSeq.toString() },
        });
      } catch (e) {
        log.warn({ err: e }, 'Could not store Sent copy');
      }
    })();
    }

    log.info(
      { userId: user.id, to, attachments: files.length, scheduled: !!scheduledAt, holdMs },
      scheduledAt ? 'Scheduled message enqueued' : 'Message enqueued',
    );
    return {
      status: 200,
      body: {
        ok: true,
        jobId,
        ...(scheduledAt ? { scheduledAt: scheduledAt.toISOString(), scheduled: true } : { scheduled: false }),
        ...(holdMs > 0 && sendAt ? { sendAt: sendAt.toISOString() } : {}),
      },
    };
}

// POST /api/v1/mail/messages/:id/cancel-scheduled — cancel scheduled send
mailRouter.post('/messages/:id/cancel-scheduled', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const msg = await prisma.message.findFirst({
    where: { id, folder: { mailbox: { userId: req.apiUser!.userId } } },
    select: { id: true, scheduledStatus: true, scheduledJobId: true, folderId: true },
  });
  if (!msg) { res.status(404).json({ error: 'Nachricht nicht gefunden' }); return; }
  if (msg.scheduledStatus !== 'PENDING') {
    res.status(409).json({ error: `Nicht abbrechbar — Status: ${msg.scheduledStatus ?? '(nicht geplant)'}` });
    return;
  }

  // Remove the BullMQ job (a delayed job can be stopped via remove())
  let jobRemoved = false;
  if (msg.scheduledJobId) {
    try {
      const job = await getOutboundQueue().getJob(msg.scheduledJobId);
      if (job) {
        await job.remove();
        jobRemoved = true;
      }
    } catch (err) {
      log.warn({ err, jobId: msg.scheduledJobId }, 'BullMQ job remove failed — message is marked CANCELLED anyway');
    }
  }

  // Keep scheduledAt/scheduledJobId for the audit trail
  await prisma.$transaction((tx) => touchMessages(tx, [id], { scheduledStatus: 'CANCELLED' }));

  res.json({ ok: true, jobRemoved });
});

// GET /api/v1/mail/search?q=foo&categoryId=...&folderId=...&limit=&offset=
// folderId (optional) restricts the search to one of the user's own folders.
mailRouter.get('/search', async (req: Request, res: Response) => {
  const q = String(req.query['q'] ?? '').trim().slice(0, MAX_QUERY_LENGTH);
  const categoryId = req.query['categoryId'] ? String(req.query['categoryId']) : null;
  const folderId = req.query['folderId'] ? String(req.query['folderId']) : null;
  const { limit, offset } = parsePaging(req.query);
  // Operators (from:, is:unread, before:, in:, "phrase", -word …) — lib/search-query.ts
  const parsed = parseSearchQuery(q);
  const chips = searchChips(parsed);
  const empty = { messages: [], total: 0, limit, offset, chips };
  if (!hasCriteria(parsed) && !categoryId) { res.json(empty); return; }

  const mailbox = await prisma.mailbox.findFirst({ where: { userId: req.apiUser!.userId } });
  if (!mailbox) { res.json(empty); return; }

  const allFolders = await prisma.folder.findMany({
    where: { mailboxId: mailbox.id },
    select: { id: true, name: true, displayName: true },
  }) as FolderRef[];
  if (folderId && !allFolders.some((f) => f.id === folderId)) { res.status(404).json({ error: 'Folder not found' }); return; }
  // An explicit in:<folder> replaces the list's folder scope
  const folderIds = resolveFolderScope(parsed, folderId ? [folderId] : allFolders.map((f) => f.id), allFolders);
  if (folderIds.length === 0) { res.json(empty); return; }

  const where: Record<string, unknown> = {
    folderId: { in: folderIds },
    deletedAt: null,
  };
  const conditions = buildSearchConditions(parsed);
  if (conditions.length === 1) Object.assign(where, conditions[0]);
  else if (conditions.length > 1) where['AND'] = conditions;
  if (categoryId) {
    where['categories'] = { some: { categoryId, category: { userId: req.apiUser!.userId } } };
  }

  const [messages, total] = await Promise.all([
    prisma.message.findMany({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      where: where as any,
      orderBy: { date: 'desc' },
      take: limit,
      skip: offset,
      select: MESSAGE_SUMMARY_SELECT,
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma.message.count({ where: where as any }),
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const flat = messages.map((m: any) => ({
    ...m,
    categories: m.categories?.map((c: any) => c.category) ?? [],
  }));

  res.json({ messages: flat, total, limit, offset, chips });
});

// GET /api/v1/mail/delegated-mailboxes
// Returns all mailboxes the current user has access to
mailRouter.get('/delegated-mailboxes', async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;
  const delegates = await prisma.mailboxDelegate.findMany({
    where: { granteeId: userId },
    include: {
      mailbox: {
        include: {
          user: { select: { id: true, email: true, displayName: true } },
          folders: { select: { id: true, name: true, displayName: true, totalCount: true, unreadCount: true } },
        },
      },
    },
    orderBy: { grantedAt: 'asc' },
  });
  res.json(delegates.map((d) => ({
    id: d.id,
    permission: d.permission,
    grantedAt: d.grantedAt,
    mailboxOwner: d.mailbox.user,
    mailboxId: d.mailbox.id,
    folders: d.mailbox.folders,
  })));
});
