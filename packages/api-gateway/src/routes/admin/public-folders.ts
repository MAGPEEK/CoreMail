/**
 * Admin routes — Public Folders — Phase 7
 * GET/POST/PUT/DELETE /api/v1/admin/public-folders
 * GET/POST/DELETE     /api/v1/admin/public-folders/:id/acl
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { requireAdmin } from '../../middleware/auth.js';

export const adminPublicFoldersRouter: RouterType = Router();
adminPublicFoldersRouter.use(requireAdmin);

// GET /api/v1/admin/public-folders  — full tree
adminPublicFoldersRouter.get('/', async (_req: Request, res: Response) => {
  // Flat-Fetch + Tree-Build, damit beliebig tief geschachtelt werden kann
  // und jedes Frontend-Feld (messageCount, children) garantiert vorhanden ist.
  const all = await prisma.publicFolder.findMany({
    include: { _count: { select: { messages: true } } },
    orderBy: { displayName: 'asc' },
  });

  type Node = {
    id: string; name: string; displayName: string; description: string;
    parentId: string | null; messageCount: number; children: Node[];
  };
  const byId = new Map<string, Node>();
  for (const f of all) {
    byId.set(f.id, {
      id: f.id, name: f.name, displayName: f.displayName, description: f.description,
      parentId: f.parentId, messageCount: f._count.messages, children: [],
    });
  }
  const roots: Node[] = [];
  for (const n of byId.values()) {
    if (n.parentId && byId.has(n.parentId)) byId.get(n.parentId)!.children.push(n);
    else roots.push(n);
  }
  res.json(roots);
});

// GET /api/v1/admin/public-folders/:id
adminPublicFoldersRouter.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const folder = await prisma.publicFolder.findUnique({
    where: { id },
    include: {
      children: true,
      _count: { select: { messages: true } },
    },
  });
  if (!folder) { res.status(404).json({ error: 'Folder not found' }); return; }
  res.json(folder);
});

const CreateFolderSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().default(''),
  parentId: z.string().optional(),
});

// POST /api/v1/admin/public-folders
adminPublicFoldersRouter.post('/', async (req: Request, res: Response) => {
  const parsed = CreateFolderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  const { name, displayName, description, parentId } = parsed.data;
  const createdBy = req.apiUser?.userId;

  if (parentId) {
    const parent = await prisma.publicFolder.findUnique({ where: { id: parentId } });
    if (!parent) { res.status(404).json({ error: 'Parent folder not found' }); return; }
  }

  const folder = await prisma.publicFolder.create({
    data: {
      name, displayName, description,
      ...(parentId !== undefined ? { parentId } : {}),
      ...(createdBy !== undefined ? { createdBy } : {}),
      // Default ACL: empty — admin grants access
      acl: [],
    },
  });
  res.status(201).json(folder);
});

const UpdateFolderSchema = z.object({
  displayName: z.string().min(1).optional(),
  description: z.string().optional(),
});

// PUT /api/v1/admin/public-folders/:id
adminPublicFoldersRouter.put('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const parsed = UpdateFolderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  const existing = await prisma.publicFolder.findUnique({ where: { id } });
  if (!existing) { res.status(404).json({ error: 'Folder not found' }); return; }

  const { displayName, description } = parsed.data;
  const folder = await prisma.publicFolder.update({
    where: { id },
    data: {
      ...(displayName !== undefined ? { displayName } : {}),
      ...(description !== undefined ? { description } : {}),
    },
  });
  res.json(folder);
});

// DELETE /api/v1/admin/public-folders/:id
adminPublicFoldersRouter.delete('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const existing = await prisma.publicFolder.findUnique({ where: { id } });
  if (!existing) { res.status(404).json({ error: 'Folder not found' }); return; }
  // Prisma cascades child folders and messages via onDelete: Cascade
  await prisma.publicFolder.delete({ where: { id } });
  res.status(204).end();
});

// ──────────────────────────────────────────────────────────
// ACL management
//
// Frontend-Vertrag:
//   GET  → AclEntry[] = { id, userId, userEmail, permission: 'READ'|'WRITE'|'FULL' }
//   POST body: { userEmail, permission } → User-Lookup, dann grant
//   DELETE /:userId — entfernt den ACL-Eintrag eines Users
// ──────────────────────────────────────────────────────────

type StoredAclEntry = { userId: string; permission: 'READ' | 'WRITE' | 'FULL' };

// GET /api/v1/admin/public-folders/:id/acl
adminPublicFoldersRouter.get('/:id/acl', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const folder = await prisma.publicFolder.findUnique({ where: { id }, select: { acl: true } });
  if (!folder) { res.status(404).json({ error: 'Folder not found' }); return; }

  const entries = (folder.acl as StoredAclEntry[]) ?? [];
  const userIds = entries.map((e) => e.userId);
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } })
    : [];
  const emailById = new Map(users.map((u) => [u.id, u.email]));

  res.json(entries.map((e) => ({
    id: e.userId,
    userId: e.userId,
    userEmail: emailById.get(e.userId) ?? '(gelöschter Benutzer)',
    permission: e.permission,
  })));
});

const AclGrantSchema = z.object({
  userEmail: z.string().email(),
  permission: z.enum(['READ', 'WRITE', 'FULL']),
});

// POST /api/v1/admin/public-folders/:id/acl — add or update an ACL entry
adminPublicFoldersRouter.post('/:id/acl', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const parsed = AclGrantSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  const folder = await prisma.publicFolder.findUnique({ where: { id } });
  if (!folder) { res.status(404).json({ error: 'Folder not found' }); return; }

  const user = await prisma.user.findUnique({ where: { email: parsed.data.userEmail.toLowerCase() }, select: { id: true } });
  if (!user) { res.status(404).json({ error: 'Benutzer nicht gefunden' }); return; }

  const currentAcl = (folder.acl as StoredAclEntry[]) ?? [];
  const updated: StoredAclEntry[] = currentAcl.filter((e) => e.userId !== user.id);
  updated.push({ userId: user.id, permission: parsed.data.permission });

  await prisma.publicFolder.update({ where: { id }, data: { acl: updated } });
  res.status(201).json({ ok: true });
});

// DELETE /api/v1/admin/public-folders/:id/acl/:userId
adminPublicFoldersRouter.delete('/:id/acl/:userId', async (req: Request, res: Response) => {
  const { id, userId } = req.params as { id: string; userId: string };
  const folder = await prisma.publicFolder.findUnique({ where: { id } });
  if (!folder) { res.status(404).json({ error: 'Folder not found' }); return; }

  const updated = ((folder.acl as StoredAclEntry[]) ?? []).filter((e) => e.userId !== userId);
  await prisma.publicFolder.update({ where: { id }, data: { acl: updated } });
  res.status(204).end();
});
