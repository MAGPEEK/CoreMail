import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { verifyAccessToken } from '@coremail/core';
import { prisma } from '@coremail/storage';
import { isAccessTokenRevokedShared, markSessionsRevoked } from '@coremail/storage/auth';

export const sessionRouter: RouterType = Router();

async function getAuthenticatedUserId(req: Request): Promise<string | null> {
  const header = req.get('Authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const payload = verifyAccessToken(header.slice(7));
  if (!payload || await isAccessTokenRevokedShared(payload.sub, payload.iat, payload.sessionId, payload.iatMs)) return null;
  return payload.sub;
}

// v8.1: the admin "revoke all sessions of a user" endpoint (DELETE
// /auth/sessions/admin/:userId) is gone from the auth-service — it did its own
// role check and skipped requireMfaForAdmins, the current-role re-check and the
// audit log of the admin API. Revoking another user's sessions belongs under
// /api/v1/admin (requireAdmin + audit). Registered BEFORE '/:id' so that the old
// path answers 410 (never reaches the own-session handler).
sessionRouter.all(['/admin', '/admin/:userId'], (_req: Request, res: Response) => {
  res.status(410).json({
    error: 'Gone — use the admin API (/api/v1/admin/...) to revoke the sessions of another user',
    code: 'ENDPOINT_REMOVED',
  });
});

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
  // v7.1.0: access tokens of the deleted session are rejected immediately
  // (memory + Redis marker + invalidation event), not only once they expire.
  await markSessionsRevoked([sessionId], userId);
  res.json({ ok: true });
});
