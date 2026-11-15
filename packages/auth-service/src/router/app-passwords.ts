import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { verifyAccessToken } from '@coremail/core';
import { isAccessTokenRevokedShared } from '@coremail/storage/auth';
import {
  createAppPassword,
  listAppPasswords,
  deleteAppPassword,
} from '../app-passwords/index.js';

export const appPasswordRouter: RouterType = Router();

// v7: like /auth/mfa and /auth/sessions — the access token of a logged-out or
// revoked session must not mint (persistent) app passwords until it expires.
async function getAuthenticatedUserId(req: Request): Promise<string | null> {
  const header = req.get('Authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const payload = verifyAccessToken(header.slice(7));
  if (!payload || await isAccessTokenRevokedShared(payload.sub, payload.iat, payload.sessionId)) return null;
  return payload.sub;
}

appPasswordRouter.get('/', async (req: Request, res: Response) => {
  const userId = await getAuthenticatedUserId(req);
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const list = await listAppPasswords(userId);
  res.json(list);
});

appPasswordRouter.post('/', async (req: Request, res: Response) => {
  const userId = await getAuthenticatedUserId(req);
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const schema = z.object({ name: z.string().min(1).max(100) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Name required' }); return; }

  const result = await createAppPassword(userId, parsed.data.name);
  res.status(201).json(result);
});

appPasswordRouter.delete('/:id', async (req: Request, res: Response) => {
  const userId = await getAuthenticatedUserId(req);
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const ok = await deleteAppPassword(userId, req.params['id'] ?? '');
  if (!ok) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ ok: true });
});
