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
 *   GET    /folders                              list (+ isSystem, noSelect, myRights)
 *   POST   /folders              {name, parentId?, color?}          create subfolders
 *   PATCH  /folders/:folderId    {name?, parentId?, color?, …}       folder owner
 *   DELETE /folders/:folderId[?force=true]                           folder owner
 *   POST   /folders/:folderId/empty                                   delete all items
 *   GET    /folders/:folderId/messages?limit&offset                   read
 *   GET|PUT /folders/:folderId/permissions                            w3: folder owner right
 *   GET    /search?q&folderId&limit&offset                            readable folders
 *   GET    /messages/:messageId[?markRead=false]  (marks \Seen only with the edit right)
 *   GET    /messages/:messageId/raw
 *   PATCH  /messages/:messageId  {read?, flagged?, flags?, folderId?} edit / move
 *   DELETE /messages/:messageId[?hard=true]                          delete
 *   POST   /messages/bulk        {ids, action, folderId?}            edit / move / delete
 *
 * The mailbox is resolved through lib/mailbox-access.ts (mailbox-level grants of
 * `listAccessibleMailboxes()` plus — w3 — mailboxes reached through folder
 * permissions); what the caller may do is decided PER FOLDER by the central
 * check of @coremail/storage (folder-access.ts / folder-permissions.ts):
 * FULL_ACCESS = everything, READ_ONLY = read every folder plus what folder
 * permissions add, folder permissions alone = only those folders. SEND_AS /
 * SEND_ON_BEHALF alone, an inactive shared mailbox or a deactivated delegating
 * owner grant nothing. No access / unknown mailbox → 403 NO_ACCESS (no existence
 * oracle); a write without any write right → 403 READ_ONLY, with some write
 * right but not this one → 403 NO_PERMISSION; a folder (or message in a folder)
 * the caller can neither see nor read → 404. A folder list shows the visible
 * folders and their ancestors (non-selectable, without counts). Every
 * folder/message lookup is scoped to the resolved mailbox id, and moves never
 * leave it. Message writes go through the storage message store (moveMessages /
 * setFlags / touchMessages / expunge); deleting a folder (subfolders only with
 * ?recursive=true) moves the messages of the whole subtree to Trash first
 * (lib/folder-delete.ts). Expunged messages (tombstones) are only reachable
 * through the FULL_ACCESS /recoverable routes. Opening (aggregated), folder
 * create/rename/delete/empty and message move/delete are audited
 * (lib/foreign-audit.ts, mailbox.foreign.*).
 * Categories are per-user and never returned for foreign mailboxes.
 */
import { Router, type Router as RouterType, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import {
  prisma, moveMessages, setFlags, touchMessages, expunge, loadRawMessage, folderSubtree,
  reservedFolderPrefix, reservedFolderNameError, loadMailboxFolderAccess, accessToFolder, listableFolders,
  canSeeFolder, canReadFolder, canCreateItems, canEditItem, canDeleteItem, canCreateSubfolder, canManageFolder,
  canAdministerFolder, hasWriteRightSomewhere, folderRightsView,
  type AccessibleMailbox, type FolderAccess, type FolderAccessDb, type MailboxFolderAccess,
} from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { protocolSubject, requireAuth } from '../middleware/auth.js';
import { announceFolderListChange } from '@coremail/storage';
import { imageDecisionFor } from '../lib/webmail-features.js';
import { getForeignMailbox } from '../lib/mailbox-access.js';
import { checkFolderParent, type FolderLookup } from '../lib/folder-tree.js';
import { contentDisposition } from '../lib/attachment-download.js';
import { deleteFolder, folderDeleteFailure, folderDeleteOptions, folderDeleteRefusal } from '../lib/folder-delete.js';
import { auditForeignOpen, auditForeignWrite, type ForeignAuditAction, type ForeignAuditTarget } from '../lib/foreign-audit.js';
import { replaceFolderPermissions, sendFolderPermissions } from '../lib/folder-permissions-api.js';
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
const NO_PERMISSION = { error: 'Keine Berechtigung für diese Aktion in diesem Ordner', code: 'NO_PERMISSION' };

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

/** The resolved mailbox of a request with the caller's rights on its folders. */
interface Foreign {
  entry: AccessibleMailbox;
  rights: MailboxFolderAccess;
  userId: string;
}

const accessOf = (f: Foreign, folderId: string): FolderAccess => accessToFolder(f.rights, folderId);
const ownItem = (f: Foreign, m: { createdBy?: string | null }): boolean => m.createdBy === f.userId;

/** 403 for a refused write: READ_ONLY without any write right in the mailbox, else NO_PERMISSION. */
function refuse(f: Foreign, res: Response): void {
  res.status(403).json(hasWriteRightSomewhere(f.rights) ? NO_PERMISSION : READ_ONLY);
}

/**
 * Resolves the mailbox of the request (`:id` of the mount path) for the caller.
 * Answers 403 itself and returns null when access is missing; for a write
 * (`mode`) without any write right in the mailbox, 403 READ_ONLY.
 */
async function resolve(kind: Kind, req: Request, res: Response, mode: 'read' | 'write'): Promise<Foreign | null> {
  const id = String((req.params as { id?: string }).id ?? '');
  const userId = req.apiUser!.userId;
  const entry = await getForeignMailbox(userId, kind, id);
  if (!entry) { res.status(403).json(NO_ACCESS); return null; }
  const rights = await loadMailboxFolderAccess(prisma as unknown as FolderAccessDb, userId, entry);
  const f: Foreign = { entry, rights, userId };
  if (mode === 'write' && !hasWriteRightSomewhere(rights)) { res.status(403).json(READ_ONLY); return null; }
  // 9.4: mailbox access audit — one "opened" entry per user, mailbox and hour
  auditForeignOpen(req, auditTarget(kind, req, entry));
  return f;
}

function auditTarget(kind: Kind, req: Request, access: AccessibleMailbox): ForeignAuditTarget {
  return {
    kind,
    id: kind === 'shared' ? (access.sharedMailboxId ?? String((req.params as { id?: string }).id ?? '')) : access.mailboxId,
    mailboxId: access.mailboxId,
    email: access.email,
  };
}

/** A folder of the mailbox the caller can see or read (null + 404 otherwise). */
async function folderIn(f: Foreign, folderId: string, res: Response) {
  const folder = await prisma.folder.findFirst({ where: { id: folderId, mailboxId: f.entry.mailboxId } });
  const access = folder ? accessOf(f, folder.id) : null;
  if (!folder || !access || (!canSeeFolder(access) && !canReadFolder(access))) {
    res.status(404).json({ error: 'Ordner nicht gefunden' });
    return null;
  }
  return { folder, access };
}

/** A live message of the mailbox in a folder the caller may read (null + 404 otherwise). */
async function messageIn<T extends { folderId: string }>(f: Foreign, found: T | null, res: Response): Promise<T | null> {
  if (!found || !canReadFolder(accessOf(f, found.folderId))) { res.status(404).json({ error: 'Nachricht nicht gefunden' }); return null; }
  return found;
}

function rejectFolderName(name: string | undefined, res: Response): boolean {
  if (name === undefined) return false;
  const prefix = reservedFolderPrefix(name);
  if (prefix) { res.status(400).json({ error: reservedFolderNameError(prefix), code: 'RESERVED_FOLDER_NAME' }); return true; }
  if (SYSTEM_FOLDER_NAMES.has(name)) { res.status(400).json({ error: 'Reservierter Systemordner-Name' }); return true; }
  return false;
}

/** Audit a write in the foreign mailbox (A3). */
function auditWrite(kind: Kind, req: Request, f: Foreign, action: ForeignAuditAction, changes: Record<string, unknown>): void {
  auditForeignWrite(req, auditTarget(kind, req, f.entry), action, changes);
}

/** May a folder get a new parent (null = top level)? Top-level folders need mailbox-level write access. */
function mayPlaceUnder(f: Foreign, parentId: string | null): boolean {
  return parentId ? canCreateSubfolder(accessOf(f, parentId)) : f.rights.level !== 'grants';
}

/** Route-level auth (the router is mounted next to other routers on the same prefix). */
const auth = (req: Request, res: Response, next: NextFunction): void => requireAuth(req, res, next);

export function createForeignMailboxRouter(kind: Kind): RouterType {
  const r: RouterType = Router({ mergeParams: true });

  // ── Folders ───────────────────────────────────────────────────────────────
  r.get('/folders', auth, async (req: Request, res: Response) => {
    const f = await resolve(kind, req, res, 'read');
    if (!f) return;
    const folders = await prisma.folder.findMany({
      where: { mailboxId: f.entry.mailboxId },
      select: FOLDER_SELECT,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    // w3: folder permissions — visible folders plus their path; a path entry shows no counts
    const shown = new Map(listableFolders(folders, f.rights).map((l) => [l.id, l.noSelect]));
    res.json(folders.filter((x) => shown.has(x.id)).map((x) => {
      const noSelect = shown.get(x.id) === true;
      return {
        ...x,
        ...(noSelect ? { totalCount: 0, unreadCount: 0 } : {}),
        isSystem: SYSTEM_FOLDER_NAMES.has(x.name),
        noSelect,
        myRights: folderRightsView(accessOf(f, x.id)),
      };
    }));
  });

  r.post('/folders', auth, async (req: Request, res: Response) => {
    const f = await resolve(kind, req, res, 'write');
    if (!f) return;
    const rawName = (req.body as { name?: unknown; displayName?: unknown } | undefined)?.name
      ?? (req.body as { displayName?: unknown } | undefined)?.displayName;
    if (typeof rawName === 'string' && rejectFolderName(rawName.trim(), res)) return;
    const parsed = CreateFolderSchema.safeParse(req.body ?? {});
    const name = parsed.success ? (parsed.data.name ?? parsed.data.displayName) : undefined;
    if (!parsed.success || !name) { res.status(400).json({ error: 'Ungültiger Ordnername' }); return; }

    const parentId = parsed.data.parentId ?? null;
    if (parentId) {
      const parent = await prisma.folder.findFirst({ where: { id: parentId, mailboxId: f.entry.mailboxId } });
      if (!parent) { res.status(404).json({ error: 'Übergeordneter Ordner nicht gefunden' }); return; }
    }
    if (!mayPlaceUnder(f, parentId)) { refuse(f, res); return; }
    const exists = await prisma.folder.findFirst({ where: { mailboxId: f.entry.mailboxId, name } });
    if (exists) { res.status(409).json({ error: 'Ordner existiert bereits' }); return; }
    const folder = await prisma.folder.create({
      data: {
        mailboxId: f.entry.mailboxId,
        name,
        displayName: name,
        ...(parentId ? { parentId } : {}),
        ...(parsed.data.color ? { color: parsed.data.color } : {}),
      },
      select: FOLDER_SELECT,
    });
    auditWrite(kind, req, f, 'mailbox.foreign.folder.create', { folderId: folder.id, name, parentId });
    announceFolderListChange(f.entry.mailboxId);
    res.status(201).json({ ...folder, isSystem: false });
  });

  r.patch('/folders/:folderId', auth, async (req: Request, res: Response) => {
    const f = await resolve(kind, req, res, 'write');
    if (!f) return;
    const { folderId } = req.params as { folderId: string };
    const rawName = (req.body as { name?: unknown } | undefined)?.name ?? (req.body as { displayName?: unknown } | undefined)?.displayName;
    if (typeof rawName === 'string' && reservedFolderPrefix(rawName)) { rejectFolderName(rawName.trim(), res); return; }
    const parsed = PatchFolderSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }
    const found = await folderIn(f, folderId, res);
    if (!found) return;
    const { folder } = found;
    if (!canManageFolder(found.access)) { refuse(f, res); return; }

    const name = parsed.data.name ?? parsed.data.displayName;
    const isSystem = SYSTEM_FOLDER_NAMES.has(folder.name);
    if (name !== undefined && name !== folder.name) {
      if (isSystem) { res.status(400).json({ error: 'Systemordner kann nicht umbenannt werden' }); return; }
      if (rejectFolderName(name, res)) return;
      const collision = await prisma.folder.findFirst({
        where: { mailboxId: f.entry.mailboxId, name, id: { not: folderId } },
      });
      if (collision) { res.status(409).json({ error: 'Name bereits vergeben' }); return; }
    }
    if (parsed.data.parentId !== undefined && parsed.data.parentId !== folder.parentId) {
      if (isSystem) { res.status(400).json({ error: 'Systemordner kann nicht verschoben werden' }); return; }
      if (parsed.data.parentId) {
        const check = await checkFolderParent(prisma as unknown as FolderLookup, folderId, parsed.data.parentId, f.entry.mailboxId);
        if (!check.ok) { res.status(check.status).json({ error: check.error }); return; }
      }
      if (!mayPlaceUnder(f, parsed.data.parentId)) { refuse(f, res); return; }
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
      auditWrite(kind, req, f, 'mailbox.foreign.folder.update', {
        folderId, from: before, to: { name: updated.name, parentId: updated.parentId },
      });
    }
    announceFolderListChange(f.entry.mailboxId);
    res.json({ ...updated, isSystem });
  });

  r.delete('/folders/:folderId', auth, async (req: Request, res: Response) => {
    const f = await resolve(kind, req, res, 'write');
    if (!f) return;
    const { folderId } = req.params as { folderId: string };
    const found = await folderIn(f, folderId, res);
    if (!found) return;
    const { folder } = found;
    if (SYSTEM_FOLDER_NAMES.has(folder.name)) {
      res.status(400).json({ error: 'Systemordner kann nicht gelöscht werden' }); return;
    }
    // Subfolders: 409 FOLDER_HAS_SUBFOLDERS unless ?recursive=true (9.3 contract).
    const opts = folderDeleteOptions(req.query);
    // w3: the folder owner right on the folder — and on every folder a recursive delete removes
    const doomed = opts.recursive ? await folderSubtree(prisma, folder) : [folder];
    if (!doomed.every((d) => canManageFolder(accessOf(f, d.id)))) { refuse(f, res); return; }
    const refusal = await folderDeleteRefusal(folder, opts, SYSTEM_FOLDER_NAMES, 'refuse');
    if (refusal) { res.status(409).json(refusal); return; }
    // A1: messages of the whole subtree go to Trash through the message store first —
    // the cascade would otherwise remove them without tombstone / modSeq.
    const done = await deleteFolder(folder, opts);
    if (!done.ok) { const fail = folderDeleteFailure(done); res.status(fail.status).json({ error: fail.error }); return; }
    auditWrite(kind, req, f, 'mailbox.foreign.folder.delete', {
      folderId, name: folder.name, movedToTrash: done.moved, live: done.live, folders: done.folders,
    });
    res.json({ ok: true, folders: done.folders, movedToTrash: done.moved });
  });

  r.post('/folders/:folderId/empty', auth, async (req: Request, res: Response) => {
    const f = await resolve(kind, req, res, 'write');
    if (!f) return;
    const { folderId } = req.params as { folderId: string };
    const found = await folderIn(f, folderId, res);
    if (!found) return;
    const { folder } = found;
    if (!canDeleteItem(found.access, false)) { refuse(f, res); return; }
    const mailboxId = f.entry.mailboxId;
    const live = await prisma.message.findMany({ where: { folderId, deletedAt: null }, select: { id: true } });
    const ids = live.map((m) => m.id);

    if (folder.name === 'Trash' || folder.name === 'Junk') {
      // tombstones: recoverable for DELETED_ITEM_RETENTION_DAYS (FULL_ACCESS, /recoverable)
      await prisma.$transaction(async (tx) => {
        if (ids.length > 0) await expunge(tx, ids, { mailboxId, where: { folderId, deletedAt: null } });
        await tx.folder.update({ where: { id: folderId }, data: { totalCount: 0, unreadCount: 0 } });
      });
      auditWrite(kind, req, f, 'mailbox.foreign.folder.empty', { folderId, name: folder.name, expunged: ids.length });
      res.json({ ok: true, deleted: ids.length });
      return;
    }
    const trash = await prisma.folder.findFirst({ where: { mailboxId, name: 'Trash' } });
    if (!trash) { res.status(409).json({ error: 'Papierkorb nicht gefunden' }); return; }
    await prisma.$transaction(async (tx) => {
      if (ids.length > 0) {
        await moveMessages(tx, ids, trash.id, { targetMailboxId: mailboxId, sourceMailboxId: mailboxId });
      }
      await tx.folder.update({ where: { id: folderId }, data: { totalCount: 0, unreadCount: 0 } });
    });
    auditWrite(kind, req, f, 'mailbox.foreign.folder.empty', { folderId, name: folder.name, movedToTrash: ids.length });
    res.json({ ok: true, moved: ids.length });
  });

  // ── w3: folder permissions (the "folder owner" right) ─────────────────────
  const permissionFolder = async (req: Request, res: Response) => {
    const f = await resolve(kind, req, res, 'read');
    if (!f) return null;
    const found = await folderIn(f, String((req.params as { folderId?: string }).folderId ?? ''), res);
    if (!found) return null;
    if (!canAdministerFolder(found.access)) { res.status(403).json(NO_PERMISSION); return null; }
    return { f, folder: found.folder };
  };
  r.get('/folders/:folderId/permissions', auth, async (req: Request, res: Response) => {
    const hit = await permissionFolder(req, res);
    if (hit) await sendFolderPermissions(res, hit.folder);
  });
  r.put('/folders/:folderId/permissions', auth, async (req: Request, res: Response) => {
    const hit = await permissionFolder(req, res);
    if (hit) await replaceFolderPermissions(req, res, hit.folder, hit.f.entry.ownerUserId, 'webmail');
  });

  // ── Message list + search ─────────────────────────────────────────────────
  r.get('/folders/:folderId/messages', auth, async (req: Request, res: Response) => {
    const f = await resolve(kind, req, res, 'read');
    if (!f) return;
    const { folderId } = req.params as { folderId: string };
    const { limit, offset } = parsePaging(req.query);
    const found = await folderIn(f, folderId, res);
    if (!found) return;
    if (!canReadFolder(found.access)) { res.status(403).json(NO_ACCESS); return; }
    // Same snooze rule as the own mailbox: hidden in INBOX until the snooze time
    const snoozeFilter = found.folder.name === 'INBOX'
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
    const f = await resolve(kind, req, res, 'read');
    if (!f) return;
    const q = String(req.query['q'] ?? '').trim().slice(0, MAX_QUERY_LENGTH);
    const folderId = req.query['folderId'] ? String(req.query['folderId']) : null;
    const { limit, offset } = parsePaging(req.query);
    const parsed = parseSearchQuery(q);
    const chips = searchChips(parsed);
    const empty = { messages: [], total: 0, limit, offset, chips };
    if (!hasCriteria(parsed)) { res.json(empty); return; }

    // w3: only the folders the caller may read
    const allFolders = (await prisma.folder.findMany({
      where: { mailboxId: f.entry.mailboxId },
      select: { id: true, name: true, displayName: true },
    }) as FolderRef[]).filter((x) => canReadFolder(accessOf(f, x.id)));
    if (folderId && !allFolders.some((x) => x.id === folderId)) { res.status(404).json({ error: 'Folder not found' }); return; }
    const folderIds = resolveFolderScope(parsed, folderId ? [folderId] : allFolders.map((x) => x.id), allFolders);
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
    const f = await resolve(kind, req, res, 'read');
    if (!f) return;
    const { messageId } = req.params as { messageId: string };
    const msg = await messageIn(f, await prisma.message.findFirst({
      where: { id: messageId, deletedAt: null, folder: { mailboxId: f.entry.mailboxId } },
      // contentId + inline: the reader resolves cid: images; no internal storage keys
      include: { attachments: { select: { id: true, filename: true, mimeType: true, size: true, contentId: true, inline: true } } },
    }), res);
    if (!msg) return;
    // Opening marks the mail read for everyone with access — only with the edit
    // right on it (READ_ONLY / Reviewer must not change the mailbox).
    if (canEditItem(accessOf(f, msg.folderId), ownItem(f, msg)) && markReadRequested(req.query) && !msg.flags.includes('\\Seen')) {
      await prisma.$transaction((tx) => setFlags(tx, [{ id: msg.id, flags: [...msg.flags, '\\Seen'] }], { mailboxId: f.entry.mailboxId }));
      await prisma.folder.update({ where: { id: msg.folderId }, data: { unreadCount: { decrement: 1 } } }).catch(() => undefined);
    }
    // 9.4: external images follow the reader's webmail policy and trusted senders
    res.json({ ...msg, externalImages: await imageDecisionFor(protocolSubject(req.apiUser!), msg.fromAddr, (err) => log.warn({ err }, 'Webmail policy not readable — external images on request')) });
  });

  r.get('/messages/:messageId/raw', auth, async (req: Request, res: Response) => {
    const f = await resolve(kind, req, res, 'read');
    if (!f) return;
    const { messageId } = req.params as { messageId: string };
    // A2: expunged messages (tombstones) only via the FULL_ACCESS /recoverable routes
    const msg = await messageIn(f, await prisma.message.findFirst({
      where: { id: messageId, deletedAt: null, folder: { mailboxId: f.entry.mailboxId } },
      include: { attachments: true },
    }), res);
    if (!msg) return;
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
    const f = await resolve(kind, req, res, 'write');
    if (!f) return;
    const { messageId } = req.params as { messageId: string };
    const parsed = PatchMessageSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }
    const msg = await messageIn(f, await prisma.message.findFirst({
      where: { id: messageId, deletedAt: null, folder: { mailboxId: f.entry.mailboxId } },
    }), res);
    if (!msg) return;

    let flags = [...msg.flags];
    if (parsed.data.read !== undefined) {
      flags = parsed.data.read ? [...new Set([...flags, '\\Seen'])] : flags.filter((fl) => fl !== '\\Seen');
    }
    if (parsed.data.flagged !== undefined) {
      flags = parsed.data.flagged ? [...new Set([...flags, '\\Flagged'])] : flags.filter((fl) => fl !== '\\Flagged');
    }
    if (parsed.data.flags) flags = parsed.data.flags;

    let target: { id: string } | null = null;
    if (parsed.data.folderId) {
      target = await prisma.folder.findFirst({ where: { id: parsed.data.folderId, mailboxId: f.entry.mailboxId }, select: { id: true } });
      if (!target) { res.status(404).json({ error: 'Zielordner nicht gefunden' }); return; }
    }
    const moving = target !== null && target.id !== msg.folderId;
    const source = accessOf(f, msg.folderId);
    const own = ownItem(f, msg);
    const flagsChanged = flags.length !== msg.flags.length || flags.some((fl) => !msg.flags.includes(fl));
    if ((flagsChanged && !canEditItem(source, own))
      || (moving && !(canDeleteItem(source, own) && canCreateItems(accessOf(f, target!.id))))) {
      refuse(f, res);
      return;
    }
    await prisma.$transaction(async (tx) => {
      if (moving) {
        await moveMessages(tx, [msg.id], target!.id, { targetMailboxId: f.entry.mailboxId, sourceMailboxId: f.entry.mailboxId, data: { flags } });
      } else {
        await setFlags(tx, [{ id: msg.id, flags }], { mailboxId: f.entry.mailboxId });
      }
    });
    if (moving) {
      auditWrite(kind, req, f, 'mailbox.foreign.message.move', { ids: [msg.id], count: 1, fromFolderId: msg.folderId, toFolderId: target!.id });
    }
    res.json({ ok: true });
  });

  r.delete('/messages/:messageId', auth, async (req: Request, res: Response) => {
    const f = await resolve(kind, req, res, 'write');
    if (!f) return;
    const { messageId } = req.params as { messageId: string };
    const msg = await messageIn(f, await prisma.message.findFirst({
      where: { id: messageId, deletedAt: null, folder: { mailboxId: f.entry.mailboxId } },
    }), res);
    if (!msg) return;
    if (!canDeleteItem(accessOf(f, msg.folderId), ownItem(f, msg))) { refuse(f, res); return; }
    const mailboxId = f.entry.mailboxId;
    const trash = await prisma.folder.findFirst({ where: { mailboxId, name: 'Trash' } });
    const expunged = req.query['hard'] === 'true' || !trash || msg.folderId === trash.id;
    if (expunged) {
      // tombstone — recoverable (Recover deleted items, FULL_ACCESS)
      await prisma.$transaction((tx) => expunge(tx, [msg.id], { mailboxId }));
    } else {
      await prisma.$transaction((tx) => moveMessages(tx, [msg.id], trash!.id, {
        targetMailboxId: mailboxId, sourceMailboxId: mailboxId,
      }));
    }
    auditWrite(kind, req, f, 'mailbox.foreign.message.delete', {
      ids: [msg.id], count: 1, fromFolderId: msg.folderId, ...(expunged ? { expunged: 1 } : { movedToTrash: 1 }),
    });
    res.json({ ok: true });
  });

  r.post('/messages/bulk', auth, async (req: Request, res: Response) => {
    const f = await resolve(kind, req, res, 'write');
    if (!f) return;
    const parsed = BulkActionSchema.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }
    const { ids, action } = parsed.data;
    const mailboxId = f.entry.mailboxId;

    // Only messages of THIS mailbox in folders the caller may read — other ids are silently ignored
    const messages = (await prisma.message.findMany({
      where: { id: { in: ids }, deletedAt: null, folder: { mailboxId } },
      select: { id: true, folderId: true, flags: true, createdBy: true },
    })).filter((m) => canReadFolder(accessOf(f, m.folderId)));
    if (!messages.length) { res.status(404).json({ error: 'Keine Nachrichten gefunden' }); return; }
    const found = messages.map((m) => m.id);
    const every = (allowed: (m: (typeof messages)[number]) => boolean): boolean => messages.every(allowed);
    const editable = () => every((m) => canEditItem(accessOf(f, m.folderId), ownItem(f, m)));
    const deletable = () => every((m) => canDeleteItem(accessOf(f, m.folderId), ownItem(f, m)));
    const sysFolder = (name: string) => prisma.folder.findFirst({ where: { mailboxId, name } });
    const moveTo = (targetId: string, list: string[], data?: { spamScore?: number }) =>
      prisma.$transaction((tx) => moveMessages(tx, list, targetId, {
        targetMailboxId: mailboxId, sourceMailboxId: mailboxId, ...(data ? { data } : {}),
      }));
    const toggle = (flag: string, on: boolean) => prisma.$transaction((tx) => setFlags(tx, messages.map((m) => ({
      id: m.id,
      flags: on ? [...new Set([...m.flags, flag])] : m.flags.filter((x) => x !== flag),
    })), { mailboxId }));

    switch (action) {
      case 'read': case 'unread': case 'flag': case 'unflag': case 'pin': case 'unpin': {
        if (!editable()) { refuse(f, res); return; }
        if (action === 'read' || action === 'unread') await toggle('\\Seen', action === 'read');
        else if (action === 'flag' || action === 'unflag') await toggle('\\Flagged', action === 'flag');
        else await prisma.$transaction((tx) => touchMessages(tx, found, { pinnedAt: action === 'pin' ? new Date() : null }, { mailboxId }));
        break;
      }
      case 'move': {
        if (!parsed.data.folderId) { res.status(400).json({ error: 'folderId erforderlich' }); return; }
        const target = await prisma.folder.findFirst({ where: { id: parsed.data.folderId, mailboxId } });
        if (!target) { res.status(404).json({ error: 'Zielordner nicht gefunden' }); return; }
        if (!deletable() || !canCreateItems(accessOf(f, target.id))) { refuse(f, res); return; }
        await moveTo(target.id, found);
        auditWrite(kind, req, f, 'mailbox.foreign.message.move', { ids: found, count: found.length, toFolderId: target.id, bulk: true });
        break;
      }
      case 'archive': case 'spam': case 'notSpam': {
        const name = action === 'archive' ? 'Archive' : action === 'spam' ? 'Junk' : 'INBOX';
        const target = await sysFolder(name);
        if (!target) { res.status(404).json({ error: `Ordner ${name} nicht gefunden` }); return; }
        if (!deletable() || !canCreateItems(accessOf(f, target.id))) { refuse(f, res); return; }
        // Junk handling of a foreign mailbox is a plain move — the personal
        // sender block list and Bayes learning belong to the caller's own mailbox.
        await moveTo(target.id, found, action === 'notSpam' ? { spamScore: 0 } : undefined);
        auditWrite(kind, req, f, 'mailbox.foreign.message.move', { ids: found, count: found.length, toFolderId: target.id, bulk: true, action });
        break;
      }
      case 'delete': {
        if (!deletable()) { refuse(f, res); return; }
        const trash = await sysFolder('Trash');
        const inTrash = messages.filter((m) => m.folderId === trash?.id).map((m) => m.id);
        const rest = messages.filter((m) => m.folderId !== trash?.id).map((m) => m.id);
        if (inTrash.length || !trash) {
          const gone = trash ? inTrash : found;
          await prisma.$transaction((tx) => expunge(tx, gone, { mailboxId, where: { deletedAt: null } }));
        }
        if (rest.length && trash) await moveTo(trash.id, rest);
        auditWrite(kind, req, f, 'mailbox.foreign.message.delete', {
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
