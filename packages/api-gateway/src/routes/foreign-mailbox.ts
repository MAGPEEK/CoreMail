/**
 * 9.3: folder and message operations on a FOREIGN mailbox — a Shared Mailbox or a
 * delegated user mailbox — with the same request/response shapes as /api/v1/mail,
 * so the webmail drives every mailbox with one set of components (only the API
 * base differs):
 *
 *   /api/v1/mail/shared-mailboxes/:id/...     :id = SharedMailbox id
 *   /api/v1/mail/delegated-mailboxes/:id/...  :id = Mailbox id (GET /mail/delegated-mailboxes)
 *
 * The pre-9.3 routes /api/v1/user/shared-mailboxes/:id/{folders,messages} keep their
 * old request/response contract (routes/user.ts, "compat") — this router is not
 * mounted there.
 *
 *   GET    /folders                              list (+ isSystem)
 *   POST   /folders              {name, parentId?, color?}          write
 *   PATCH  /folders/:folderId    {name?, parentId?, color?, …}       write
 *   DELETE /folders/:folderId[?force=true]                           write
 *   POST   /folders/:folderId/empty                                   write
 *   GET    /folders/:folderId/messages?limit&offset
 *   GET    /search?q&folderId&limit&offset
 *   GET    /messages/:messageId[?markRead=false]  (marks \Seen only with write access)
 *   GET    /messages/:messageId/raw
 *   PATCH  /messages/:messageId  {read?, flagged?, flags?, folderId?} write
 *   DELETE /messages/:messageId[?hard=true]                          write
 *   POST   /messages/bulk        {ids, action, folderId?}            write
 *
 * Access is decided by `listAccessibleMailboxes()` (@coremail/storage, via
 * lib/mailbox-access.ts) — the rule IMAP, JMAP and the attachment download use:
 * FULL_ACCESS = read + write, READ_ONLY = read; SEND_AS / SEND_ON_BEHALF alone,
 * an inactive shared mailbox or a deactivated delegating owner grant nothing.
 * No access / unknown mailbox → 403 (no existence oracle); a write with read-only
 * access → 403 `READ_ONLY`. Every folder/message lookup is scoped to the resolved
 * mailbox id, and moves never leave it. Message writes go through the storage
 * message store (moveMessages / setFlags / touchMessages / expunge); deleting a
 * folder (subfolders only with ?recursive=true) moves the messages of the whole
 * subtree to Trash first (lib/folder-delete.ts). Expunged
 * messages (tombstones) are only reachable through the FULL_ACCESS /recoverable
 * routes. Folder create/rename/delete/empty and message move/delete are audited
 * (lib/foreign-audit.ts, mailbox.foreign.*).
 * Categories are per-user and never returned for foreign mailboxes.
 */
import { Router, type Router as RouterType, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import {
  prisma, moveMessages, setFlags, touchMessages, expunge, loadRawMessage,
  reservedFolderPrefix, reservedFolderNameError, type AccessibleMailbox,
} from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { requireAuth } from '../middleware/auth.js';
import { announceFolderListChange } from '@coremail/storage';
import { getForeignMailbox } from '../lib/mailbox-access.js';
import { checkFolderParent, type FolderLookup } from '../lib/folder-tree.js';
import { contentDisposition } from '../lib/attachment-download.js';
import { deleteFolder, folderDeleteFailure, folderDeleteOptions, folderDeleteRefusal } from '../lib/folder-delete.js';
import { auditForeignOpen, auditForeignWrite, type ForeignAuditAction, type ForeignAuditTarget } from '../lib/foreign-audit.js';
import { markReadRequested } from '../lib/mark-read.js';
import { messageOrderBy } from '../lib/message-sort.js';
import {
  parseSearchQuery, buildSearchConditions, resolveFolderScope, searchChips, hasCriteria,
  MAX_QUERY_LENGTH, type FolderRef,
} from '../lib/search-query.js';
import { MESSAGE_SUMMARY_SELECT, SYSTEM_FOLDER_NAMES, parsePaging } from './mail.js';

const log = createLogger('api:foreign-mailbox');

type Kind = 'shared' | 'delegated';

// Categories are personal (Category.userId) — never part of a foreign mailbox view.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { categories: _personalCategories, ...FOREIGN_SUMMARY_SELECT } = MESSAGE_SUMMARY_SELECT;

const FOLDER_SELECT = {
  id: true, name: true, displayName: true, parentId: true,
  totalCount: true, unreadCount: true, isFavorite: true, sortOrder: true, color: true,
} as const;

const NO_ACCESS = { error: 'Kein Zugriff auf dieses Postfach', code: 'NO_ACCESS' };
const READ_ONLY = { error: 'Nur Lesezugriff auf dieses Postfach', code: 'READ_ONLY' };

const FolderName = z.string().trim().min(1).max(100).regex(/^[^/\\]+$/, 'Ungültiger Ordnername');
const CreateFolderSchema = z.object({
  name: FolderName.optional(),
  displayName: FolderName.optional(), // pre-9.3 body of the shared-mailbox page
  parentId: z.string().nullable().optional(),
  color: z.string().max(32).nullable().optional(),
});
const PatchFolderSchema = z.object({
  name: FolderName.optional(),
  displayName: FolderName.optional(),
  parentId: z.string().nullable().optional(),
  color: z.string().max(32).nullable().optional(),
  isFavorite: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});
const PatchMessageSchema = z.object({
  flags: z.array(z.string().max(64)).max(50).optional(),
  folderId: z.string().optional(),
  read: z.boolean().optional(),
  flagged: z.boolean().optional(),
});
const BulkActionSchema = z.object({
  ids: z.array(z.string()).min(1).max(500),
  action: z.enum(['read', 'unread', 'flag', 'unflag', 'pin', 'unpin', 'move', 'delete', 'archive', 'spam', 'notSpam']),
  folderId: z.string().optional(),
});

/**
 * Resolves the mailbox of the request (`:id` of the mount path) for the caller.
 * Answers 403 itself and returns null when access is missing (or read-only for a write).
 */
async function resolve(kind: Kind, req: Request, res: Response, mode: 'read' | 'write'): Promise<AccessibleMailbox | null> {
  const id = String((req.params as { id?: string }).id ?? '');
  const access = await getForeignMailbox(req.apiUser!.userId, kind, id);
  if (!access) { res.status(403).json(NO_ACCESS); return null; }
  if (mode === 'write' && access.readOnly) { res.status(403).json(READ_ONLY); return null; }
  // 9.4: mailbox access audit — one "opened" entry per user, mailbox and hour
  auditForeignOpen(req, auditTarget(kind, req, access));
  return access;
}

function auditTarget(kind: Kind, req: Request, access: AccessibleMailbox): ForeignAuditTarget {
  return {
    kind,
    id: kind === 'shared' ? (access.sharedMailboxId ?? String((req.params as { id?: string }).id ?? '')) : access.mailboxId,
    mailboxId: access.mailboxId,
    email: access.email,
  };
}

/** A folder of the mailbox (null + 404 when it belongs elsewhere). */
async function folderIn(mailboxId: string, folderId: string, res: Response) {
  const folder = await prisma.folder.findFirst({ where: { id: folderId, mailboxId } });
  if (!folder) { res.status(404).json({ error: 'Ordner nicht gefunden' }); return null; }
  return folder;
}

function rejectFolderName(name: string | undefined, res: Response): boolean {
  if (name === undefined) return false;
  const prefix = reservedFolderPrefix(name);
  if (prefix) { res.status(400).json({ error: reservedFolderNameError(prefix), code: 'RESERVED_FOLDER_NAME' }); return true; }
  if (SYSTEM_FOLDER_NAMES.has(name)) { res.status(400).json({ error: 'Reservierter Systemordner-Name' }); return true; }
  return false;
}

/** Audit a write in the foreign mailbox (A3). */
function auditWrite(kind: Kind, req: Request, access: AccessibleMailbox, action: ForeignAuditAction, changes: Record<string, unknown>): void {
  auditForeignWrite(req, auditTarget(kind, req, access), action, changes);
}

/** Route-level auth (the router is mounted next to other routers on the same prefix). */
const auth = (req: Request, res: Response, next: NextFunction): void => requireAuth(req, res, next);

export function createForeignMailboxRouter(kind: Kind): RouterType {
  const r: RouterType = Router({ mergeParams: true });

  // ── Folders ───────────────────────────────────────────────────────────────
  r.get('/folders', auth, async (req: Request, res: Response) => {
    const access = await resolve(kind, req, res, 'read');
    if (!access) return;
    const folders = await prisma.folder.findMany({
      where: { mailboxId: access.mailboxId },
      select: FOLDER_SELECT,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    res.json(folders.map((f) => ({ ...f, isSystem: SYSTEM_FOLDER_NAMES.has(f.name) })));
  });

  r.post('/folders', auth, async (req: Request, res: Response) => {
    const access = await resolve(kind, req, res, 'write');
    if (!access) return;
    const rawName = (req.body as { name?: unknown; displayName?: unknown } | undefined)?.name
      ?? (req.body as { displayName?: unknown } | undefined)?.displayName;
    if (typeof rawName === 'string' && rejectFolderName(rawName.trim(), res)) return;
    const parsed = CreateFolderSchema.safeParse(req.body ?? {});
    const name = parsed.success ? (parsed.data.name ?? parsed.data.displayName) : undefined;
    if (!parsed.success || !name) { res.status(400).json({ error: 'Ungültiger Ordnername' }); return; }

    const exists = await prisma.folder.findFirst({ where: { mailboxId: access.mailboxId, name } });
    if (exists) { res.status(409).json({ error: 'Ordner existiert bereits' }); return; }
    if (parsed.data.parentId) {
      const parent = await prisma.folder.findFirst({ where: { id: parsed.data.parentId, mailboxId: access.mailboxId } });
      if (!parent) { res.status(404).json({ error: 'Übergeordneter Ordner nicht gefunden' }); return; }
    }
    const folder = await prisma.folder.create({
      data: {
        mailboxId: access.mailboxId,
        name,
        displayName: name,
        ...(parsed.data.parentId ? { parentId: parsed.data.parentId } : {}),
        ...(parsed.data.color ? { color: parsed.data.color } : {}),
      },
      select: FOLDER_SELECT,
    });
    auditWrite(kind, req, access, 'mailbox.foreign.folder.create', { folderId: folder.id, name, parentId: parsed.data.parentId ?? null });
    announceFolderListChange(access.mailboxId);
    res.status(201).json({ ...folder, isSystem: false });
  });

  r.patch('/folders/:folderId', auth, async (req: Request, res: Response) => {
    const access = await resolve(kind, req, res, 'write');
    if (!access) return;
    const { folderId } = req.params as { folderId: string };
    const rawName = (req.body as { name?: unknown } | undefined)?.name ?? (req.body as { displayName?: unknown } | undefined)?.displayName;
    if (typeof rawName === 'string' && reservedFolderPrefix(rawName)) { rejectFolderName(rawName.trim(), res); return; }
    const parsed = PatchFolderSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }
    const folder = await folderIn(access.mailboxId, folderId, res);
    if (!folder) return;

    const name = parsed.data.name ?? parsed.data.displayName;
    const isSystem = SYSTEM_FOLDER_NAMES.has(folder.name);
    if (name !== undefined && name !== folder.name) {
      if (isSystem) { res.status(400).json({ error: 'Systemordner kann nicht umbenannt werden' }); return; }
      if (rejectFolderName(name, res)) return;
      const collision = await prisma.folder.findFirst({
        where: { mailboxId: access.mailboxId, name, id: { not: folderId } },
      });
      if (collision) { res.status(409).json({ error: 'Name bereits vergeben' }); return; }
    }
    if (parsed.data.parentId !== undefined && parsed.data.parentId !== folder.parentId) {
      if (isSystem) { res.status(400).json({ error: 'Systemordner kann nicht verschoben werden' }); return; }
      if (parsed.data.parentId) {
        const check = await checkFolderParent(prisma as unknown as FolderLookup, folderId, parsed.data.parentId, access.mailboxId);
        if (!check.ok) { res.status(check.status).json({ error: check.error }); return; }
      }
    }

    const before = { name: folder.name, parentId: folder.parentId };
    const renamedOrMoved = (name !== undefined && name !== before.name)
      || (parsed.data.parentId !== undefined && parsed.data.parentId !== before.parentId);
    const updated = await prisma.folder.update({
      where: { id: folderId },
      data: {
        ...(name !== undefined && !isSystem ? { name, displayName: name } : {}),
        ...(parsed.data.parentId !== undefined ? { parentId: parsed.data.parentId } : {}),
        ...(parsed.data.color !== undefined ? { color: parsed.data.color } : {}),
        ...(parsed.data.isFavorite !== undefined ? { isFavorite: parsed.data.isFavorite } : {}),
        ...(parsed.data.sortOrder !== undefined ? { sortOrder: parsed.data.sortOrder } : {}),
      },
      select: FOLDER_SELECT,
    });
    if (renamedOrMoved) {
      auditWrite(kind, req, access, 'mailbox.foreign.folder.update', {
        folderId, from: before, to: { name: updated.name, parentId: updated.parentId },
      });
    }
    announceFolderListChange(access.mailboxId);
    res.json({ ...updated, isSystem });
  });

  r.delete('/folders/:folderId', auth, async (req: Request, res: Response) => {
    const access = await resolve(kind, req, res, 'write');
    if (!access) return;
    const { folderId } = req.params as { folderId: string };
    const folder = await folderIn(access.mailboxId, folderId, res);
    if (!folder) return;
    if (SYSTEM_FOLDER_NAMES.has(folder.name)) {
      res.status(400).json({ error: 'Systemordner kann nicht gelöscht werden' }); return;
    }
    // Subfolders: 409 FOLDER_HAS_SUBFOLDERS unless ?recursive=true (9.3 contract).
    const opts = folderDeleteOptions(req.query);
    const refusal = await folderDeleteRefusal(folder, opts, SYSTEM_FOLDER_NAMES, 'refuse');
    if (refusal) { res.status(409).json(refusal); return; }
    // A1: messages of the whole subtree go to Trash through the message store first —
    // the cascade would otherwise remove them without tombstone / modSeq.
    const done = await deleteFolder(folder, opts);
    if (!done.ok) { const f = folderDeleteFailure(done); res.status(f.status).json({ error: f.error }); return; }
    auditWrite(kind, req, access, 'mailbox.foreign.folder.delete', {
      folderId, name: folder.name, movedToTrash: done.moved, live: done.live, folders: done.folders,
    });
    res.json({ ok: true, folders: done.folders, movedToTrash: done.moved });
  });

  r.post('/folders/:folderId/empty', auth, async (req: Request, res: Response) => {
    const access = await resolve(kind, req, res, 'write');
    if (!access) return;
    const { folderId } = req.params as { folderId: string };
    const folder = await folderIn(access.mailboxId, folderId, res);
    if (!folder) return;
    const live = await prisma.message.findMany({ where: { folderId, deletedAt: null }, select: { id: true } });
    const ids = live.map((m) => m.id);

    if (folder.name === 'Trash' || folder.name === 'Junk') {
      // tombstones: recoverable for DELETED_ITEM_RETENTION_DAYS (FULL_ACCESS, /recoverable)
      await prisma.$transaction(async (tx) => {
        if (ids.length > 0) await expunge(tx, ids, { mailboxId: access.mailboxId, where: { folderId, deletedAt: null } });
        await tx.folder.update({ where: { id: folderId }, data: { totalCount: 0, unreadCount: 0 } });
      });
      auditWrite(kind, req, access, 'mailbox.foreign.folder.empty', { folderId, name: folder.name, expunged: ids.length });
      res.json({ ok: true, deleted: ids.length });
      return;
    }
    const trash = await prisma.folder.findFirst({ where: { mailboxId: access.mailboxId, name: 'Trash' } });
    if (!trash) { res.status(409).json({ error: 'Papierkorb nicht gefunden' }); return; }
    await prisma.$transaction(async (tx) => {
      if (ids.length > 0) {
        await moveMessages(tx, ids, trash.id, { targetMailboxId: access.mailboxId, sourceMailboxId: access.mailboxId });
      }
      await tx.folder.update({ where: { id: folderId }, data: { totalCount: 0, unreadCount: 0 } });
    });
    auditWrite(kind, req, access, 'mailbox.foreign.folder.empty', { folderId, name: folder.name, movedToTrash: ids.length });
    res.json({ ok: true, moved: ids.length });
  });

  // ── Message list + search ─────────────────────────────────────────────────
  r.get('/folders/:folderId/messages', auth, async (req: Request, res: Response) => {
    const access = await resolve(kind, req, res, 'read');
    if (!access) return;
    const { folderId } = req.params as { folderId: string };
    const { limit, offset } = parsePaging(req.query);
    const folder = await folderIn(access.mailboxId, folderId, res);
    if (!folder) return;
    // Same snooze rule as the own mailbox: hidden in INBOX until the snooze time
    const snoozeFilter = folder.name === 'INBOX'
      ? { OR: [{ snoozeUntil: null }, { snoozeUntil: { lte: new Date() } }] }
      : {};
    const where = { folderId, deletedAt: null, ...snoozeFilter };
    const [messages, total] = await Promise.all([
      prisma.message.findMany({
        where,
        orderBy: messageOrderBy(req.query), // 9.4: ?sort=&dir=
        take: limit,
        skip: offset,
        select: FOREIGN_SUMMARY_SELECT,
      }),
      prisma.message.count({ where }),
    ]);
    res.json({ messages: messages.map((m) => ({ ...m, categories: [] })), total, limit, offset });
  });

  r.get('/search', auth, async (req: Request, res: Response) => {
    const access = await resolve(kind, req, res, 'read');
    if (!access) return;
    const q = String(req.query['q'] ?? '').trim().slice(0, MAX_QUERY_LENGTH);
    const folderId = req.query['folderId'] ? String(req.query['folderId']) : null;
    const { limit, offset } = parsePaging(req.query);
    const parsed = parseSearchQuery(q);
    const chips = searchChips(parsed);
    const empty = { messages: [], total: 0, limit, offset, chips };
    if (!hasCriteria(parsed)) { res.json(empty); return; }

    const allFolders = await prisma.folder.findMany({
      where: { mailboxId: access.mailboxId },
      select: { id: true, name: true, displayName: true },
    }) as FolderRef[];
    if (folderId && !allFolders.some((f) => f.id === folderId)) { res.status(404).json({ error: 'Folder not found' }); return; }
    const folderIds = resolveFolderScope(parsed, folderId ? [folderId] : allFolders.map((f) => f.id), allFolders);
    if (folderIds.length === 0) { res.json(empty); return; }

    const where: Record<string, unknown> = { folderId: { in: folderIds }, deletedAt: null };
    const conditions = buildSearchConditions(parsed);
    if (conditions.length === 1) Object.assign(where, conditions[0]);
    else if (conditions.length > 1) where['AND'] = conditions;

    const [messages, total] = await Promise.all([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma.message.findMany({ where: where as any, orderBy: { date: 'desc' }, take: limit, skip: offset, select: FOREIGN_SUMMARY_SELECT }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma.message.count({ where: where as any }),
    ]);
    res.json({ messages: messages.map((m) => ({ ...m, categories: [] })), total, limit, offset, chips });
  });

  // ── Single messages ───────────────────────────────────────────────────────
  r.get('/messages/:messageId', auth, async (req: Request, res: Response) => {
    const access = await resolve(kind, req, res, 'read');
    if (!access) return;
    const { messageId } = req.params as { messageId: string };
    const msg = await prisma.message.findFirst({
      where: { id: messageId, deletedAt: null, folder: { mailboxId: access.mailboxId } },
      // contentId + inline: the reader resolves cid: images; no internal storage keys
      include: { attachments: { select: { id: true, filename: true, mimeType: true, size: true, contentId: true, inline: true } } },
    });
    if (!msg) { res.status(404).json({ error: 'Nachricht nicht gefunden' }); return; }
    // Opening marks the mail read for everyone with access — only with write access
    // (READ_ONLY must not change the mailbox).
    if (!access.readOnly && markReadRequested(req.query) && !msg.flags.includes('\\Seen')) {
      await prisma.$transaction((tx) => setFlags(tx, [{ id: msg.id, flags: [...msg.flags, '\\Seen'] }], { mailboxId: access.mailboxId }));
      await prisma.folder.update({ where: { id: msg.folderId }, data: { unreadCount: { decrement: 1 } } }).catch(() => undefined);
    }
    res.json(msg);
  });

  r.get('/messages/:messageId/raw', auth, async (req: Request, res: Response) => {
    const access = await resolve(kind, req, res, 'read');
    if (!access) return;
    const { messageId } = req.params as { messageId: string };
    // A2: expunged messages (tombstones) only via the FULL_ACCESS /recoverable routes
    const msg = await prisma.message.findFirst({
      where: { id: messageId, deletedAt: null, folder: { mailboxId: access.mailboxId } },
      include: { attachments: true },
    });
    if (!msg) { res.status(404).json({ error: 'Nachricht nicht gefunden' }); return; }
    try {
      const raw = await loadRawMessage(msg, { persist: false });
      res.setHeader('Content-Type', 'message/rfc822');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', contentDisposition('attachment', `${msg.subject || 'message'}.eml`));
      res.send(raw);
    } catch (err) {
      log.warn({ err, messageId }, 'Raw message not readable');
      res.status(503).json({ error: 'Message source temporarily unavailable' });
    }
  });

  r.patch('/messages/:messageId', auth, async (req: Request, res: Response) => {
    const access = await resolve(kind, req, res, 'write');
    if (!access) return;
    const { messageId } = req.params as { messageId: string };
    const parsed = PatchMessageSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }
    const msg = await prisma.message.findFirst({
      where: { id: messageId, deletedAt: null, folder: { mailboxId: access.mailboxId } },
    });
    if (!msg) { res.status(404).json({ error: 'Nachricht nicht gefunden' }); return; }

    let flags = [...msg.flags];
    if (parsed.data.read !== undefined) {
      flags = parsed.data.read ? [...new Set([...flags, '\\Seen'])] : flags.filter((f) => f !== '\\Seen');
    }
    if (parsed.data.flagged !== undefined) {
      flags = parsed.data.flagged ? [...new Set([...flags, '\\Flagged'])] : flags.filter((f) => f !== '\\Flagged');
    }
    if (parsed.data.flags) flags = parsed.data.flags;

    let target: { id: string } | null = null;
    if (parsed.data.folderId) {
      target = await prisma.folder.findFirst({ where: { id: parsed.data.folderId, mailboxId: access.mailboxId }, select: { id: true } });
      if (!target) { res.status(404).json({ error: 'Zielordner nicht gefunden' }); return; }
    }
    await prisma.$transaction(async (tx) => {
      if (target && target.id !== msg.folderId) {
        await moveMessages(tx, [msg.id], target.id, { targetMailboxId: access.mailboxId, sourceMailboxId: access.mailboxId, data: { flags } });
      } else {
        await setFlags(tx, [{ id: msg.id, flags }], { mailboxId: access.mailboxId });
      }
    });
    if (target && target.id !== msg.folderId) {
      auditWrite(kind, req, access, 'mailbox.foreign.message.move', { ids: [msg.id], count: 1, fromFolderId: msg.folderId, toFolderId: target.id });
    }
    res.json({ ok: true });
  });

  r.delete('/messages/:messageId', auth, async (req: Request, res: Response) => {
    const access = await resolve(kind, req, res, 'write');
    if (!access) return;
    const { messageId } = req.params as { messageId: string };
    const msg = await prisma.message.findFirst({
      where: { id: messageId, deletedAt: null, folder: { mailboxId: access.mailboxId } },
    });
    if (!msg) { res.status(404).json({ error: 'Nachricht nicht gefunden' }); return; }
    const trash = await prisma.folder.findFirst({ where: { mailboxId: access.mailboxId, name: 'Trash' } });
    const expunged = req.query['hard'] === 'true' || !trash || msg.folderId === trash.id;
    if (expunged) {
      // tombstone — recoverable (Recover deleted items, FULL_ACCESS)
      await prisma.$transaction((tx) => expunge(tx, [msg.id], { mailboxId: access.mailboxId }));
    } else {
      await prisma.$transaction((tx) => moveMessages(tx, [msg.id], trash!.id, {
        targetMailboxId: access.mailboxId, sourceMailboxId: access.mailboxId,
      }));
    }
    auditWrite(kind, req, access, 'mailbox.foreign.message.delete', {
      ids: [msg.id], count: 1, fromFolderId: msg.folderId, ...(expunged ? { expunged: 1 } : { movedToTrash: 1 }),
    });
    res.json({ ok: true });
  });

  r.post('/messages/bulk', auth, async (req: Request, res: Response) => {
    const access = await resolve(kind, req, res, 'write');
    if (!access) return;
    const parsed = BulkActionSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }
    const { ids, action } = parsed.data;
    const mailboxId = access.mailboxId;

    // Only messages of THIS mailbox — ids of other mailboxes are silently ignored
    const messages = await prisma.message.findMany({
      where: { id: { in: ids }, deletedAt: null, folder: { mailboxId } },
      select: { id: true, folderId: true, flags: true },
    });
    if (!messages.length) { res.status(404).json({ error: 'Keine Nachrichten gefunden' }); return; }
    const found = messages.map((m) => m.id);
    const sysFolder = (name: string) => prisma.folder.findFirst({ where: { mailboxId, name } });
    const moveTo = (targetId: string, list: string[], data?: { spamScore?: number }) =>
      prisma.$transaction((tx) => moveMessages(tx, list, targetId, {
        targetMailboxId: mailboxId, sourceMailboxId: mailboxId, ...(data ? { data } : {}),
      }));
    const toggle = (flag: string, on: boolean) => prisma.$transaction((tx) => setFlags(tx, messages.map((m) => ({
      id: m.id,
      flags: on ? [...new Set([...m.flags, flag])] : m.flags.filter((f) => f !== flag),
    })), { mailboxId }));

    switch (action) {
      case 'read': case 'unread': await toggle('\\Seen', action === 'read'); break;
      case 'flag': case 'unflag': await toggle('\\Flagged', action === 'flag'); break;
      case 'pin': case 'unpin':
        await prisma.$transaction((tx) => touchMessages(tx, found, { pinnedAt: action === 'pin' ? new Date() : null }, { mailboxId }));
        break;
      case 'move': {
        if (!parsed.data.folderId) { res.status(400).json({ error: 'folderId erforderlich' }); return; }
        const target = await prisma.folder.findFirst({ where: { id: parsed.data.folderId, mailboxId } });
        if (!target) { res.status(404).json({ error: 'Zielordner nicht gefunden' }); return; }
        await moveTo(target.id, found);
        auditWrite(kind, req, access, 'mailbox.foreign.message.move', { ids: found, count: found.length, toFolderId: target.id, bulk: true });
        break;
      }
      case 'archive': case 'spam': case 'notSpam': {
        const name = action === 'archive' ? 'Archive' : action === 'spam' ? 'Junk' : 'INBOX';
        const target = await sysFolder(name);
        if (!target) { res.status(404).json({ error: `Ordner ${name} nicht gefunden` }); return; }
        // Junk handling of a foreign mailbox is a plain move — the personal
        // sender block list and Bayes learning belong to the caller's own mailbox.
        await moveTo(target.id, found, action === 'notSpam' ? { spamScore: 0 } : undefined);
        auditWrite(kind, req, access, 'mailbox.foreign.message.move', { ids: found, count: found.length, toFolderId: target.id, bulk: true, action });
        break;
      }
      case 'delete': {
        const trash = await sysFolder('Trash');
        const inTrash = messages.filter((m) => m.folderId === trash?.id).map((m) => m.id);
        const rest = messages.filter((m) => m.folderId !== trash?.id).map((m) => m.id);
        if (inTrash.length || !trash) {
          const gone = trash ? inTrash : found;
          await prisma.$transaction((tx) => expunge(tx, gone, { mailboxId, where: { deletedAt: null } }));
        }
        if (rest.length && trash) await moveTo(trash.id, rest);
        auditWrite(kind, req, access, 'mailbox.foreign.message.delete', {
          ids: found, count: found.length, bulk: true,
          expunged: trash ? inTrash.length : found.length, movedToTrash: trash ? rest.length : 0,
        });
        break;
      }
    }
    res.json({ ok: true, affected: found.length });
  });

  return r;
}

/** /api/v1/mail/shared-mailboxes/:id/… (SharedMailbox id). */
export const sharedMailboxContentRouter: RouterType = createForeignMailboxRouter('shared');
/** /api/v1/mail/delegated-mailboxes/:id/… (Mailbox id). */
export const delegatedMailboxContentRouter: RouterType = createForeignMailboxRouter('delegated');
