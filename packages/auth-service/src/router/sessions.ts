import { Router, type Request, type Response } from 'express';
import { verifyAccessToken } from '@coremail/core';
import { getPrisma } from '@coremail/storage';

export const sessionRouter = Router();

function getAuthenticatedUserId(req: Request): string | null {
  const header = req.get('Authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const payload = verifyAccessToken(header.slice(7));
  return payload?.userId ?? null;
}

sessionRouter.get('/', async (req: Request, res: Response) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const prisma = getPrisma();
  const sessions = await prisma.session.findMany({
    where: { userId, expiresAt: { gt: new Date() } },
    select: { id: true, ipAddress: true, userAgent: true, createdAt: true, expiresAt: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(sessions);
});

sessionRouter.delete('/:id', async (req: Request, res: Response) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const prisma = getPrisma();
  const session = await prisma.session.findFirst({
    where: { id: req.params['id'], userId },
  });
  if (!session) { res.status(404).json({ error: 'Not found' }); return; }

  await prisma.session.delete({ where: { id: session.id } });
  res.json({ ok: true });
});

// Admin: revoke all sessions of a user
sessionRouter.delete('/admin/:userId', async (req: Request, res: Response) => {
  const adminId = getAuthenticatedUserId(req);
  if (!adminId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const prisma = getPrisma();
  const admin = await prisma.user.findUnique({ where: { id: adminId } });
  if (!admin || (admin.role !== 'ADMIN' && admin.role !== 'ORGANIZATION_MANAGEMENT')) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  await prisma.session.deleteMany({ where: { userId: req.params['userId'] } });
  res.json({ ok: true });
});
