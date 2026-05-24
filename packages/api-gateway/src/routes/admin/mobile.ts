/**
 * Admin-API: Mobile Geräte (ActiveSync)
 *
 * GET    /api/v1/admin/mobile/devices             — Alle Geräte (mit User-Info)
 * GET    /api/v1/admin/mobile/devices/:id         — Detail
 * PATCH  /api/v1/admin/mobile/devices/:id/status  — Status setzen (OK|PENDING|BLOCKED)
 * POST   /api/v1/admin/mobile/devices/:id/wipe    — Remote Wipe anfordern
 * DELETE /api/v1/admin/mobile/devices/:id         — Gerät deregistrieren
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { requireAdmin } from '../../middleware/auth.js';

const log = createLogger('admin:mobile');
export const adminMobileRouter: RouterType = Router();
adminMobileRouter.use(requireAdmin);

const SELECT = {
  id: true, deviceId: true, deviceType: true, deviceFriendlyName: true,
  policyKey: true, status: true, lastSyncAt: true, remoteWipeAt: true, createdAt: true,
  user: { select: { id: true, email: true, displayName: true } },
};

// ── GET /devices ──────────────────────────────────────────────────────────────
adminMobileRouter.get('/devices', async (req: Request, res: Response) => {
  const { search = '', status = '', page = '1', limit = '50' } = req.query as Record<string, string>;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const where: Record<string, unknown> = {};
  if (status) where['status'] = status;
  if (search) {
    where['OR'] = [
      { deviceFriendlyName: { contains: search, mode: 'insensitive' } },
      { deviceType:         { contains: search, mode: 'insensitive' } },
      { user: { email:      { contains: search, mode: 'insensitive' } } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.activeSyncDevice.findMany({ where, select: SELECT, orderBy: { lastSyncAt: 'desc' }, skip, take: parseInt(limit) }),
    prisma.activeSyncDevice.count({ where }),
  ]);
  res.json({ items, total, page: parseInt(page), limit: parseInt(limit) });
});

// ── GET /devices/:id ──────────────────────────────────────────────────────────
adminMobileRouter.get('/devices/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const item = await prisma.activeSyncDevice.findUnique({ where: { id }, select: SELECT });
  if (!item) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(item);
});

// ── PATCH /devices/:id/status ─────────────────────────────────────────────────
adminMobileRouter.patch('/devices/:id/status', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const schema = z.object({ status: z.enum(['OK', 'PENDING', 'BLOCKED']) });
  const p = schema.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Invalid status' }); return; }
  try {
    const item = await prisma.activeSyncDevice.update({
      where: { id }, data: { status: p.data.status }, select: SELECT,
    });
    log.info({ id, status: p.data.status }, 'Device status updated');
    res.json(item);
  } catch { res.status(404).json({ error: 'Not found' }); }
});

// ── POST /devices/:id/wipe ────────────────────────────────────────────────────
adminMobileRouter.post('/devices/:id/wipe', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  const device = await prisma.activeSyncDevice.findUnique({ where: { id } });
  if (!device) { res.status(404).json({ error: 'Not found' }); return; }

  await prisma.activeSyncDevice.update({
    where: { id }, data: { status: 'WIPED', remoteWipeAt: new Date() },
  });
  log.warn({ id, deviceId: device.deviceId, userId: device.userId }, 'Remote wipe initiated');
  res.json({ message: 'Remote Wipe angefordert — Gerät wird beim nächsten Sync gelöscht' });
});

// ── DELETE /devices/:id ───────────────────────────────────────────────────────
adminMobileRouter.delete('/devices/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] ?? '';
  try {
    await prisma.activeSyncDevice.delete({ where: { id } });
    log.info({ id }, 'Device deregistered');
    res.status(204).end();
  } catch { res.status(404).json({ error: 'Not found' }); }
});
