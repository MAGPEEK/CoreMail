/**
 * Admin API: shared mailboxes
 *
 * GET    /api/v1/admin/shared-mailboxes                        — list
 * POST   /api/v1/admin/shared-mailboxes                        — create
 * GET    /api/v1/admin/shared-mailboxes/:id                    — Detail
 * PUT    /api/v1/admin/shared-mailboxes/:id                    — edit
 * DELETE /api/v1/admin/shared-mailboxes/:id                    — delete
 * GET    /api/v1/admin/shared-mailboxes/:id/permissions        — permissions
 * POST   /api/v1/admin/shared-mailboxes/:id/permissions        — add permission
 * DELETE /api/v1/admin/shared-mailboxes/:id/permissions/:userId — remove permission
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma, announceUserEvent } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { requireArea } from '../../middleware/auth.js';
import { ensureSharedMailboxProvisioned } from '../../lib/provision-mailbox.js';
import { quotaLevelPatchError } from '../../lib/quota-levels.js';
import { publishPermissionChange, sharedMailboxGrantees } from '../../lib/permission-events.js';
import { addressCollision } from '../../lib/address-collision.js';

const log = createLogger('admin:shared-mailboxes');
export const adminSharedMailboxesRouter: RouterType = Router();
adminSharedMailboxesRouter.use(requireArea('recipients'));

const SELECT = {
  id: true, email: true, displayName: true, domainId: true,
  quotaBytes: true, usedBytes: true, active: true, createdAt: true,
  quotaWarningBytes: true, quotaProhibitSendBytes: true,
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
  // NaN / negative values used to reach Prisma (500)
  const pageN = Math.max(1, parseInt(page, 10) || 1);
  const limitN = Math.min(500, Math.max(1, parseInt(limit, 10) || 50));
  const skip = (pageN - 1) * limitN;

  const where = search
    ? { OR: [{ email: { contains: search, mode: 'insensitive' as const } }, { displayName: { contains: search, mode: 'insensitive' as const } }] }
    : {};

  const [items, total] = await Promise.all([
    prisma.sharedMailbox.findMany({ where, select: SELECT, orderBy: { email: 'asc' }, skip, take: limitN }),
    prisma.sharedMailbox.count({ where }),
  ]);
  res.json({ items, total, page: pageN, limit: limitN });
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
    displayName: z.string().trim().min(1).max(200),
    domainId:    z.string().min(1),
    quotaBytes:  z.number().int().min(0).optional(), // 0 = unlimited
  });
  const p = schema.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Invalid input', details: p.error.issues }); return; }
  const email = p.data.email.trim().toLowerCase();

  const domain = await prisma.domain.findUnique({ where: { id: p.data.domainId }, select: { name: true } });
  if (!domain) { res.status(404).json({ error: 'Domain not found' }); return; }
  if (email.split('@')[1] !== domain.name.toLowerCase()) {
    res.status(400).json({ error: `The address must end in @${domain.name}` }); return;
  }
  // users, shared mailboxes and aliases share one address namespace
  const collision = await addressCollision(email);
  if (collision) { res.status(409).json({ error: collision }); return; }

  try {
    const item = await prisma.sharedMailbox.create({
      data: {
        email,
        displayName: p.data.displayName,
        domainId: p.data.domainId,
        ...(p.data.quotaBytes !== undefined ? { quotaBytes: BigInt(p.data.quotaBytes) } : {}),
      },
      select: SELECT,
    });
    // Provision mailbox + default folders immediately (analogous to regular user mailboxes)
    const prov = await ensureSharedMailboxProvisioned(item.id).catch((e: unknown) => {
      log.error({ err: e, sharedMailboxId: item.id }, 'Shared mailbox folder provisioning failed');
      return null;
    });
    log.info({ id: item.id, email: item.email, foldersCreated: prov?.foldersCreated ?? 0 }, 'Shared mailbox created');
    res.status(201).json(item);
  } catch (err) {
    const msg = String(err);
    if (msg.includes('Unique constraint')) { res.status(409).json({ error: 'The address is already in use' }); return; }
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
    res.status(500).json({ error: 'Provisioning failed' });
  }
});

// ── PUT /:id ──────────────────────────────────────────────────────────────────
adminSharedMailboxesRouter.put('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const schema = z.object({
    displayName: z.string().min(1).max(200).optional(),
    active:      z.boolean().optional(),
    quotaBytes:  z.number().int().min(0).optional(), // 0 = unlimited
    // v8.1: Exchange quota levels (null = server default percent of quotaBytes)
    quotaWarningBytes:      z.number().int().min(0).nullable().optional(),
    quotaProhibitSendBytes: z.number().int().min(0).nullable().optional(),
  });
  const p = schema.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Invalid input' }); return; }
  // 8.1: partial updates are validated against the stored levels
  const stored = await prisma.sharedMailbox.findUnique({
    where: { id }, select: { quotaBytes: true, quotaWarningBytes: true, quotaProhibitSendBytes: true },
  });
  if (!stored) { res.status(404).json({ error: 'Not found' }); return; }
  const levelError = quotaLevelPatchError(p.data, stored);
  if (levelError) { res.status(400).json({ error: levelError }); return; }
  const big = (v: number | null): bigint | null => (v === null ? null : BigInt(v));
  try {
    const item = await prisma.sharedMailbox.update({
      where: { id },
      data: {
        ...(p.data.displayName !== undefined ? { displayName: p.data.displayName } : {}),
        ...(p.data.active      !== undefined ? { active: p.data.active }           : {}),
        ...(p.data.quotaBytes  !== undefined ? { quotaBytes: BigInt(p.data.quotaBytes) } : {}),
        ...(p.data.quotaWarningBytes !== undefined ? { quotaWarningBytes: big(p.data.quotaWarningBytes) } : {}),
        ...(p.data.quotaProhibitSendBytes !== undefined ? { quotaProhibitSendBytes: big(p.data.quotaProhibitSendBytes) } : {}),
      },
      select: SELECT,
    });
    // 9.1: (de)activation changes the access of every grantee.
    if (p.data.active !== undefined) await publishPermissionChange(await sharedMailboxGrantees(id));
    // 9.4: a quota change reaches the open webmail of every member
    if (p.data.quotaBytes !== undefined || p.data.quotaWarningBytes !== undefined || p.data.quotaProhibitSendBytes !== undefined) {
      announceUserEvent(await sharedMailboxGrantees(id), { type: 'quota' });
    }
    res.json(item);
  } catch { res.status(404).json({ error: 'Not found' }); }
});

// ── DELETE /:id ───────────────────────────────────────────────────────────────
adminSharedMailboxesRouter.delete('/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  try {
    const grantees = await sharedMailboxGrantees(id);
    await prisma.sharedMailbox.delete({ where: { id } });
    log.info({ id }, 'Shared mailbox deleted');
    await publishPermissionChange(grantees);
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
// Body: { userId, permissions: ['FULL_ACCESS','SEND_AS'] }  or legacy { userId, permission: '…' }
// Sets all permissions listed in `permissions` for the user (set semantics).
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
  if (perms.length === 0) { res.status(400).json({ error: 'No permission given' }); return; }

  const [sm, grantee] = await Promise.all([
    prisma.sharedMailbox.findUnique({ where: { id: sharedMailboxId }, select: { id: true } }),
    prisma.user.findUnique({ where: { id: p.data.userId }, select: { id: true } }),
  ]);
  if (!sm) { res.status(404).json({ error: 'Shared mailbox not found' }); return; }
  if (!grantee) { res.status(404).json({ error: 'User not found' }); return; }

  const actorId = req.apiUser?.userId ?? 'system';
  try {
    // Replace strategy: delete all existing for (mailbox, user), then set anew
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
    await publishPermissionChange([p.data.userId]);
    res.status(201).json(updated);
  } catch (err) {
    log.error({ err }, 'Failed to set permissions');
    res.status(400).json({ error: 'The permission could not be set' });
  }
});

// ── DELETE /:id/permissions/:userId — removes ALL permissions of the user ─────
adminSharedMailboxesRouter.delete('/:id/permissions/:userId', async (req: Request, res: Response) => {
  const sharedMailboxId = req.params['id'] ?? '';
  const userId = req.params['userId'] ?? '';
  try {
    const result = await prisma.sharedMailboxPerm.deleteMany({ where: { sharedMailboxId, userId } });
    if (result.count === 0) { res.status(404).json({ error: 'Not found' }); return; }
    await publishPermissionChange([userId]);
    res.status(204).end();
  } catch { res.status(404).json({ error: 'Not found' }); }
});

// ── DELETE /:id/permissions/:userId/:permission — removes ONE permission ──────
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
    await publishPermissionChange([userId]);
    res.status(204).end();
  } catch { res.status(404).json({ error: 'Not found' }); }
});
