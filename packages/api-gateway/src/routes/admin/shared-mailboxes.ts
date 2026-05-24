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
import { ensureSharedMailboxProvisioned } from '../../lib/provision-mailbox.js';

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
    // Mailbox + Default-Ordner sofort provisionieren (analog zu regulären User-Mailboxen)
    const prov = await ensureSharedMailboxProvisioned(item.id).catch((e: unknown) => {
      log.error({ err: e, sharedMailboxId: item.id }, 'Shared mailbox folder provisioning failed');
      return null;
    });
    log.info({ id: item.id, email: item.email, foldersCreated: prov?.foldersCreated ?? 0 }, 'Shared mailbox created');
    res.status(201).json(item);
  } catch (err) {
    const msg = String(err);
    if (msg.includes('Unique constraint')) { res.status(409).json({ error: 'E-Mail-Adresse bereits vergeben' }); return; }
    throw err;
  }
});

// ── POST /:id/provision — repair/backfill (idempotent) ────────────────────────
adminSharedMailboxesRouter.post('/:id/provision', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const existing = await prisma.sharedMailbox.findUnique({ where: { id }, select: { id: true } });
  if (!existing) { res.status(404).json({ error: 'Not found' }); return; }
  try {
    const result = await ensureSharedMailboxProvisioned(id);
    res.json(result);
  } catch (err) {
    log.error({ err, id }, 'Shared mailbox provisioning failed');
    res.status(500).json({ error: 'Provisioning fehlgeschlagen' });
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
// Body: { userId, permissions: ['FULL_ACCESS','SEND_AS'] }  oder Legacy { userId, permission: '…' }
// Setzt für den User alle in `permissions` aufgeführten Berechtigungen (Set-Semantik).
adminSharedMailboxesRouter.post('/:id/permissions', async (req: Request, res: Response) => {
  const sharedMailboxId = req.params['id'] ?? '';
  const PERM_VALUES = ['FULL_ACCESS', 'SEND_AS', 'SEND_ON_BEHALF', 'READ_ONLY'] as const;
  const schema = z.object({
    userId:      z.string().min(1),
    permissions: z.array(z.enum(PERM_VALUES)).min(1).optional(),
    permission:  z.enum(PERM_VALUES).optional(), // Legacy
  });
  const p = schema.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Invalid input' }); return; }
  const perms = p.data.permissions ?? (p.data.permission ? [p.data.permission] : []);
  if (perms.length === 0) { res.status(400).json({ error: 'Keine Berechtigung angegeben' }); return; }

  const actorId = (req as Request & { userId?: string }).userId ?? 'system';
  try {
    // Replace-Strategie: alle bestehenden für (mailbox, user) löschen, dann neu setzen
    await prisma.$transaction([
      prisma.sharedMailboxPerm.deleteMany({ where: { sharedMailboxId, userId: p.data.userId } }),
      prisma.sharedMailboxPerm.createMany({
        data: perms.map((permission) => ({ sharedMailboxId, userId: p.data.userId, permission, grantedBy: actorId })),
        skipDuplicates: true,
      }),
    ]);
    const updated = await prisma.sharedMailboxPerm.findMany({
      where: { sharedMailboxId, userId: p.data.userId },
      include: { user: { select: { email: true, displayName: true } } },
    });
    res.status(201).json(updated);
  } catch (err) {
    log.error({ err }, 'Failed to set permissions');
    res.status(400).json({ error: 'Berechtigung konnte nicht gesetzt werden' });
  }
});

// ── DELETE /:id/permissions/:userId — entfernt ALLE Berechtigungen des Users ──
adminSharedMailboxesRouter.delete('/:id/permissions/:userId', async (req: Request, res: Response) => {
  const sharedMailboxId = req.params['id'] ?? '';
  const userId = req.params['userId'] ?? '';
  try {
    const result = await prisma.sharedMailboxPerm.deleteMany({ where: { sharedMailboxId, userId } });
    if (result.count === 0) { res.status(404).json({ error: 'Not found' }); return; }
    res.status(204).end();
  } catch { res.status(404).json({ error: 'Not found' }); }
});

// ── DELETE /:id/permissions/:userId/:permission — entfernt EINE Berechtigung ──
adminSharedMailboxesRouter.delete('/:id/permissions/:userId/:permission', async (req: Request, res: Response) => {
  const sharedMailboxId = req.params['id'] ?? '';
  const userId = req.params['userId'] ?? '';
  const permission = req.params['permission'] ?? '';
  const valid = ['FULL_ACCESS', 'SEND_AS', 'SEND_ON_BEHALF', 'READ_ONLY'].includes(permission);
  if (!valid) { res.status(400).json({ error: 'Invalid permission' }); return; }
  try {
    await prisma.sharedMailboxPerm.delete({
      where: {
        sharedMailboxId_userId_permission: {
          sharedMailboxId,
          userId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          permission: permission as any,
        },
      },
    });
    res.status(204).end();
  } catch { res.status(404).json({ error: 'Not found' }); }
});
