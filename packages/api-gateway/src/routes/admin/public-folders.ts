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
  // Return root folders (no parent) with children included recursively
  const roots = await prisma.publicFolder.findMany({
    where: { parentId: null },
    include: {
      children: {
        include: {
          children: { include: { children: true } },
        },
      },
      _count: { select: { messages: true } },
    },
    orderBy: { displayName: 'asc' },
  });
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
// ──────────────────────────────────────────────────────────

type AclEntry = { userId: string; permission: 'READ' | 'POST' | 'OWNER' };

// GET /api/v1/admin/public-folders/:id/acl
adminPublicFoldersRouter.get('/:id/acl', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const folder = await prisma.publicFolder.findUnique({ where: { id }, select: { acl: true } });
  if (!folder) { res.status(404).json({ error: 'Folder not found' }); return; }
  res.json(folder.acl);
});

const AclPatchSchema = z.object({
  userId: z.string(),
  permission: z.enum(['READ', 'POST', 'OWNER']),
});

// POST /api/v1/admin/public-folders/:id/acl — add or update an ACL entry
adminPublicFoldersRouter.post('/:id/acl', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const parsed = AclPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  const folder = await prisma.publicFolder.findUnique({ where: { id } });
  if (!folder) { res.status(404).json({ error: 'Folder not found' }); return; }

  const currentAcl = (folder.acl as AclEntry[]);
  const updated = currentAcl.filter((e) => e.userId !== parsed.data.userId);
  updated.push(parsed.data);

  await prisma.publicFolder.update({ where: { id }, data: { acl: updated } });
  res.json(updated);
});

// DELETE /api/v1/admin/public-folders/:id/acl/:userId
adminPublicFoldersRouter.delete('/:id/acl/:userId', async (req: Request, res: Response) => {
  const { id, userId } = req.params as { id: string; userId: string };
  const folder = await prisma.publicFolder.findUnique({ where: { id } });
  if (!folder) { res.status(404).json({ error: 'Folder not found' }); return; }

  const updated = (folder.acl as AclEntry[]).filter((e) => e.userId !== userId);
  await prisma.publicFolder.update({ where: { id }, data: { acl: updated } });
  res.json(updated);
});
