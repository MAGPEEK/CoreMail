import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { verifyAccessToken } from '@coremail/core';
import { prisma } from '@coremail/storage';
import { isAccessTokenRevokedShared, revokeAllSessions } from '@coremail/storage/auth';

export const sessionRouter: RouterType = Router();

async function getAuthenticatedUserId(req: Request): Promise<string | null> {
  const header = req.get('Authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const payload = verifyAccessToken(header.slice(7));
  if (!payload || await isAccessTokenRevokedShared(payload.sub, payload.iat, payload.sessionId)) return null;
  return payload.sub;
}

sessionRouter.get('/', async (req: Request, res: Response) => {
  const userId = await getAuthenticatedUserId(req);
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const sessions = await prisma.session.findMany({
    where: { userId, expiresAt: { gt: new Date() } },
    select: { id: true, ipAddress: true, userAgent: true, createdAt: true, expiresAt: true, lastUsedAt: true, mfaVerified: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(sessions);
});

sessionRouter.delete('/:id', async (req: Request, res: Response) => {
  const userId = await getAuthenticatedUserId(req);
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const sessionId = req.params['id'];
  if (!sessionId) { res.status(400).json({ error: 'Missing id' }); return; }
  const result = await prisma.session.deleteMany({ where: { id: sessionId, userId } });
  if (result.count === 0) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ ok: true });
});

// Admin: revoke all sessions of a user
sessionRouter.delete('/admin/:userId', async (req: Request, res: Response) => {
  const adminId = await getAuthenticatedUserId(req);
  if (!adminId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const admin = await prisma.user.findUnique({ where: { id: adminId }, select: { role: true, active: true } });
  if (!admin?.active || admin.role !== 'ORGANIZATION_MANAGEMENT') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  const targetUserId = req.params['userId'];
  if (!targetUserId) { res.status(400).json({ error: 'Missing userId' }); return; }
  await revokeAllSessions(targetUserId, { reason: `admin-revoke:${adminId}` });
  res.json({ ok: true });
});
