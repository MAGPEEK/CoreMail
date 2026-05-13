import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { verifyAccessToken } from '@coremail/core';
import { prisma } from '@coremail/storage';

export const sessionRouter: RouterType = Router();

function getAuthenticatedUserId(req: Request): string | null {
  const header = req.get('Authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const payload = verifyAccessToken(header.slice(7));
  return payload?.sub ?? null;
}

sessionRouter.get('/', async (req: Request, res: Response) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  
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

  
  const sessionId = req.params['id'];
  if (!sessionId) { res.status(400).json({ error: 'Missing id' }); return; }
  const session = await prisma.session.findFirst({
    where: { id: sessionId, userId },
  });
  if (!session) { res.status(404).json({ error: 'Not found' }); return; }

  await prisma.session.delete({ where: { id: session.id } });
  res.json({ ok: true });
});

// Admin: revoke all sessions of a user
sessionRouter.delete('/admin/:userId', async (req: Request, res: Response) => {
  const adminId = getAuthenticatedUserId(req);
  if (!adminId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  
  const admin = await prisma.user.findUnique({ where: { id: adminId } });
  if (!admin || admin.role !== 'ORGANIZATION_MANAGEMENT') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  const targetUserId = req.params['userId'];
  if (!targetUserId) { res.status(400).json({ error: 'Missing userId' }); return; }
  await prisma.session.deleteMany({ where: { userId: targetUserId } });
  res.json({ ok: true });
});
