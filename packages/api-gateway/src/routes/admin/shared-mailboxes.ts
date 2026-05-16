/**
 * Admin-API: Freigegebene Postfächer (Shared Mailboxes)
 *
 * GET    /api/v1/admin/shared-mailboxes                        — Liste
 * POST   /api/v1/admin/shared-mailboxes                        — Anlegen
 * GET    /api/v1/admin/shared-mailboxes/:id                    — Detail
 * PUT    /api/v1/admin/shared-mailboxes/:id                    — Bearbeiten
 * DELETE /api/v1/admin/shared-mailboxes/:id                    — Löschen
 * GET    /api/v1/admin/shared-mailboxes/:id/permissions        — Berechtigungen
 * POST   /api/v1/admin/shared-mailboxes/:id/permissions        — Berechtigung hinzufügen
 * DELETE /api/v1/admin/shared-mailboxes/:id/permissions/:userId — Berechtigung entfernen
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { requireAdmin } from '../../middleware/auth.js';

const log = createLogger('admin:shared-mailboxes');
export const adminSharedMailboxesRouter: RouterType = Router();
adminSharedMailboxesRouter.use(requireAdmin);

const SELECT = {
  id: true, email: true, displayName: true, domainId: true,
  quotaBytes: true, usedBytes: true, active: true, createdAt: true,
  permissions: {
    select: {
      id: true, userId: true, permission: true, grantedAt: true,
      user: { select: { email: true, displayName: true } },
    },
  },
};

// ── GET / ─────────────────────────────────────────────────────────────────────
adminSharedMailboxesRouter.get('/', async (req: Request, res: Response) => {
  const { search = '', page = '1', limit = '50' } = req.query as Record<string, string>;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const where = search
    ? { OR: [{ email: { contains: search, mode: 'insensitive' as const } }, { displayName: { contains: search, mode: 'insensitive' as const } }] }
    : {};

  const [items, total] = await Promise.all([
    prisma.sharedMailbox.findMany({ where, select: SELECT, orderBy: { email: 'asc' }, skip, take: parseInt(limit) }),
    prisma.sharedMailbox.count({ where }),
  ]);
  res.json({ items, total, page: parseInt(page), limit: parseInt(limit) });
});

// ── GET /:id ──────────────────────────────────────────────────────────────────
adminSharedMailboxesRouter.get('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const item = await prisma.sharedMailbox.findUnique({ where: { id }, select: SELECT });
  if (!item) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(item);
});

// ── POST / ────────────────────────────────────────────────────────────────────
adminSharedMailboxesRouter.post('/', async (req: Request, res: Response) => {
  const schema = z.object({
    email:       z.string().email(),
    displayName: z.string().min(1).max(200),
    domainId:    z.string().min(1),
    quotaBytes:  z.number().int().positive().optional(),
  });
  const p = schema.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Invalid input', details: p.error.issues }); return; }

  try {
    const item = await prisma.sharedMailbox.create({
      data: {
        email: p.data.email,
        displayName: p.data.displayName,
        domainId: p.data.domainId,
        ...(p.data.quotaBytes ? { quotaBytes: BigInt(p.data.quotaBytes) } : {}),
      },
      select: SELECT,
    });
    log.info({ id: item.id, email: item.email }, 'Shared mailbox created');
    res.status(201).json(item);
  } catch (err) {
    const msg = String(err);
    if (msg.includes('Unique constraint')) { res.status(409).json({ error: 'E-Mail-Adresse bereits vergeben' }); return; }
    throw err;
  }
});

// ── PUT /:id ──────────────────────────────────────────────────────────────────
adminSharedMailboxesRouter.put('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const schema = z.object({
    displayName: z.string().min(1).max(200).optional(),
    active:      z.boolean().optional(),
    quotaBytes:  z.number().int().positive().optional(),
  });
  const p = schema.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Invalid input' }); return; }
  try {
    const item = await prisma.sharedMailbox.update({
      where: { id },
      data: {
        ...(p.data.displayName !== undefined ? { displayName: p.data.displayName } : {}),
        ...(p.data.active      !== undefined ? { active: p.data.active }           : {}),
        ...(p.data.quotaBytes  !== undefined ? { quotaBytes: BigInt(p.data.quotaBytes) } : {}),
      },
      select: SELECT,
    });
    res.json(item);
  } catch { res.status(404).json({ error: 'Not found' }); }
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────
adminSharedMailboxesRouter.delete('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  try {
    await prisma.sharedMailbox.delete({ where: { id } });
    log.info({ id }, 'Shared mailbox deleted');
    res.status(204).end();
  } catch { res.status(404).json({ error: 'Not found' }); }
});

// ── GET /:id/permissions ──────────────────────────────────────────────────────
adminSharedMailboxesRouter.get('/:id/permissions', async (req: Request, res: Response) => {
  const sharedMailboxId = req.params['id'] ?? '';
  const perms = await prisma.sharedMailboxPerm.findMany({
    where: { sharedMailboxId },
    include: { user: { select: { email: true, displayName: true } } },
  });
  res.json(perms);
});

// ── POST /:id/permissions ─────────────────────────────────────────────────────
adminSharedMailboxesRouter.post('/:id/permissions', async (req: Request, res: Response) => {
  const sharedMailboxId = req.params['id'] ?? '';
  const schema = z.object({
    userId:     z.string().min(1),
    permission: z.enum(['FULL_ACCESS', 'SEND_AS', 'SEND_ON_BEHALF', 'READ_ONLY']),
  });
  const p = schema.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Invalid input' }); return; }

  const actorId = (req as Request & { userId?: string }).userId ?? 'system';
  try {
    const perm = await prisma.sharedMailboxPerm.upsert({
      where: { sharedMailboxId_userId: { sharedMailboxId, userId: p.data.userId } },
      create: { sharedMailboxId, userId: p.data.userId, permission: p.data.permission, grantedBy: actorId },
      update: { permission: p.data.permission, grantedBy: actorId },
      include: { user: { select: { email: true, displayName: true } } },
    });
    res.status(201).json(perm);
  } catch { res.status(400).json({ error: 'Berechtigung konnte nicht gesetzt werden' }); }
});

// ── DELETE /:id/permissions/:userId ──────────────────────────────────────────
adminSharedMailboxesRouter.delete('/:id/permissions/:userId', async (req: Request, res: Response) => {
  const sharedMailboxId = req.params['id'] ?? '';
  const userId = req.params['userId'] ?? '';
  try {
    await prisma.sharedMailboxPerm.delete({
      where: { sharedMailboxId_userId: { sharedMailboxId, userId } },
    });
    res.status(204).end();
  } catch { res.status(404).json({ error: 'Not found' }); }
});
