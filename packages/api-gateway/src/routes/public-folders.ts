/**
 * User-facing Public Folder routes — Phase 7
 * GET  /api/v1/public-folders           — list accessible folders
 * GET  /api/v1/public-folders/:id       — folder detail
 * GET  /api/v1/public-folders/:id/messages
 * POST /api/v1/public-folders/:id/messages  — post a message
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { requireAuth } from '../middleware/auth.js';

export const publicFoldersRouter: RouterType = Router();
publicFoldersRouter.use(requireAuth);

type AclEntry = { userId: string; permission: 'READ' | 'WRITE' | 'FULL' };

// Hierarchie: FULL > WRITE > READ
function hasPermission(acl: AclEntry[], userId: string, required: 'READ' | 'WRITE' | 'FULL'): boolean {
  const entry = acl?.find((e) => e.userId === userId);
  if (!entry) return false;
  if (required === 'READ') return true; // alle drei erlauben Lesen
  if (required === 'WRITE') return entry.permission === 'WRITE' || entry.permission === 'FULL';
  return entry.permission === 'FULL';
}

// GET /api/v1/public-folders
publicFoldersRouter.get('/', async (req: Request, res: Response) => {
  const userId = req.apiUser?.userId ?? '';

  const allFolders = await prisma.publicFolder.findMany({
    select: { id: true, name: true, displayName: true, description: true, parentId: true, totalCount: true, acl: true },
    orderBy: { displayName: 'asc' },
  });

  // Filter to folders the user has at least READ access to
  const accessible = allFolders.filter((f) =>
    hasPermission(f.acl as AclEntry[], userId, 'READ'),
  );

  res.json(accessible);
});

// GET /api/v1/public-folders/:id
publicFoldersRouter.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const userId = req.apiUser?.userId ?? '';

  const folder = await prisma.publicFolder.findUnique({
    where: { id },
    include: { children: { select: { id: true, displayName: true, totalCount: true } } },
  });
  if (!folder) { res.status(404).json({ error: 'Folder not found' }); return; }
  if (!hasPermission(folder.acl as AclEntry[], userId, 'READ')) {
    res.status(403).json({ error: 'Access denied' }); return;
  }
  res.json(folder);
});

// GET /api/v1/public-folders/:id/messages?limit=50&offset=0
publicFoldersRouter.get('/:id/messages', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const userId = req.apiUser?.userId ?? '';
  const limit = Math.min(parseInt((req.query as Record<string, string>)['limit'] ?? '50', 10), 200);
  const offset = parseInt((req.query as Record<string, string>)['offset'] ?? '0', 10);

  const folder = await prisma.publicFolder.findUnique({ where: { id }, select: { acl: true } });
  if (!folder) { res.status(404).json({ error: 'Folder not found' }); return; }
  if (!hasPermission(folder.acl as AclEntry[], userId, 'READ')) {
    res.status(403).json({ error: 'Access denied' }); return;
  }

  const [total, messages] = await Promise.all([
    prisma.publicFolderMessage.count({ where: { folderId: id } }),
    prisma.publicFolderMessage.findMany({
      where: { folderId: id },
      orderBy: { date: 'desc' },
      skip: offset,
      take: limit,
      select: { id: true, subject: true, fromAddr: true, fromName: true, date: true, bodyText: true },
    }),
  ]);

  res.json({ total, messages });
});

const PostMessageSchema = z.object({
  subject: z.string().default(''),
  bodyText: z.string().default(''),
  bodyHtml: z.string().default(''),
});

// POST /api/v1/public-folders/:id/messages
publicFoldersRouter.post('/:id/messages', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const userId = req.apiUser?.userId ?? '';

  const folder = await prisma.publicFolder.findUnique({ where: { id } });
  if (!folder) { res.status(404).json({ error: 'Folder not found' }); return; }
  if (!hasPermission(folder.acl as AclEntry[], userId, 'WRITE')) {
    res.status(403).json({ error: 'Posting not permitted' }); return;
  }

  const parsed = PostMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, displayName: true },
  });

  const [message] = await prisma.$transaction([
    prisma.publicFolderMessage.create({
      data: {
        folderId: id,
        subject: parsed.data.subject,
        fromAddr: user?.email ?? '',
        fromName: user?.displayName ?? '',
        bodyText: parsed.data.bodyText,
        bodyHtml: parsed.data.bodyHtml,
        date: new Date(),
      },
    }),
    prisma.publicFolder.update({ where: { id }, data: { totalCount: { increment: 1 } } }),
  ]);

  res.status(201).json(message);
});
