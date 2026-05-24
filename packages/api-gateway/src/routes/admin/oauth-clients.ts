/**
 * Admin API — OAuth2 Client Management (Phase 10)
 *
 * ECP → Organisation → OAuth2 / Modern Auth
 *
 * Routes:
 *   GET    /api/v1/admin/oauth/clients        — list clients
 *   POST   /api/v1/admin/oauth/clients        — create client
 *   GET    /api/v1/admin/oauth/clients/:id    — get client
 *   PUT    /api/v1/admin/oauth/clients/:id    — update client
 *   DELETE /api/v1/admin/oauth/clients/:id    — delete client
 *   POST   /api/v1/admin/oauth/clients/:id/rotate-secret — rotate client secret
 *   GET    /api/v1/admin/oauth/tokens         — list active tokens (admin view)
 *   DELETE /api/v1/admin/oauth/tokens/:id     — revoke a token
 */

import { Router, type Router as RouterType, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { prisma } from '@coremail/storage/prisma';
import { requireAuth, requireAdmin } from '../../middleware/auth.js';

export const adminOAuthClientsRouter: RouterType = Router();
adminOAuthClientsRouter.use(requireAuth, requireAdmin);

const VALID_SCOPES = ['openid', 'profile', 'email', 'mail', 'calendar', 'contacts', 'ews', 'admin'];

// ── Client CRUD ───────────────────────────────────────────────────────────────

adminOAuthClientsRouter.get('/clients', async (_req: Request, res: Response) => {
  const clients = await prisma.oAuthClient.findMany({
    select: {
      id: true, clientId: true, name: true, description: true,
      redirectUris: true, allowedScopes: true, trusted: true, pkceRequired: true,
      active: true, createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  res.json(clients);
});

adminOAuthClientsRouter.post('/clients', async (req: Request, res: Response) => {
  const { name, description, redirectUris, allowedScopes, trusted, pkceRequired } = req.body as {
    name?: string;
    description?: string;
    redirectUris?: string[];
    allowedScopes?: string[];
    trusted?: boolean;
    pkceRequired?: boolean;
  };

  if (!name || !redirectUris?.length) {
    res.status(400).json({ error: 'name and redirectUris are required' });
    return;
  }

  const invalidScopes = (allowedScopes ?? []).filter((s) => !VALID_SCOPES.includes(s));
  if (invalidScopes.length) {
    res.status(400).json({ error: `Invalid scopes: ${invalidScopes.join(', ')}` });
    return;
  }

  const isPublic = pkceRequired ?? false;  // Public clients haben kein Secret
  const clientId = `coremail_${crypto.randomBytes(12).toString('hex')}`;
  const rawSecret = isPublic ? null : crypto.randomBytes(32).toString('hex');
  const clientSecret = rawSecret ? await bcrypt.hash(rawSecret, 12) : '';

  const client = await prisma.oAuthClient.create({
    data: {
      clientId,
      clientSecret,
      name,
      description:   description ?? '',
      redirectUris,
      allowedScopes: allowedScopes ?? ['openid', 'email', 'mail', 'ews'],
      trusted:       trusted ?? false,
      pkceRequired:  isPublic,
      createdBy:     req.apiUser!.userId,
    },
    select: {
      id: true, clientId: true, name: true, description: true,
      redirectUris: true, allowedScopes: true, trusted: true, pkceRequired: true,
      active: true, createdAt: true,
    },
  });

  // Secret einmalig zurückgeben — danach nicht mehr abrufbar
  res.status(201).json({ ...client, ...(rawSecret ? { clientSecret: rawSecret } : {}) });
});

adminOAuthClientsRouter.get('/clients/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const client = await prisma.oAuthClient.findUnique({
    where: { id },
    select: {
      id: true, clientId: true, name: true, description: true,
      redirectUris: true, allowedScopes: true, trusted: true, pkceRequired: true,
      active: true, createdAt: true,
    },
  });
  if (!client) { res.status(404).json({ error: 'Client not found' }); return; }
  res.json(client);
});

adminOAuthClientsRouter.put('/clients/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const { name, description, redirectUris, allowedScopes, trusted, pkceRequired, active } = req.body as {
    name?: string; description?: string; redirectUris?: string[];
    allowedScopes?: string[]; trusted?: boolean; pkceRequired?: boolean; active?: boolean;
  };

  const existing = await prisma.oAuthClient.findUnique({ where: { id } });
  if (!existing) { res.status(404).json({ error: 'Client not found' }); return; }

  const client = await prisma.oAuthClient.update({
    where: { id },
    data: {
      ...(name !== undefined         ? { name }         : {}),
      ...(description !== undefined  ? { description }  : {}),
      ...(redirectUris !== undefined  ? { redirectUris }  : {}),
      ...(allowedScopes !== undefined ? { allowedScopes } : {}),
      ...(trusted !== undefined       ? { trusted }       : {}),
      ...(pkceRequired !== undefined  ? { pkceRequired }  : {}),
      ...(active !== undefined        ? { active }        : {}),
    },
    select: {
      id: true, clientId: true, name: true, description: true,
      redirectUris: true, allowedScopes: true, trusted: true, pkceRequired: true, active: true,
    },
  });
  res.json(client);
});

adminOAuthClientsRouter.delete('/clients/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const existing = await prisma.oAuthClient.findUnique({ where: { id } });
  if (!existing) { res.status(404).json({ error: 'Client not found' }); return; }
  await prisma.oAuthClient.delete({ where: { id } });
  res.json({ ok: true });
});

adminOAuthClientsRouter.post('/clients/:id/rotate-secret', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const existing = await prisma.oAuthClient.findUnique({ where: { id } });
  if (!existing) { res.status(404).json({ error: 'Client not found' }); return; }

  const rawSecret = crypto.randomBytes(32).toString('hex');
  const clientSecret = await bcrypt.hash(rawSecret, 12);
  await prisma.oAuthClient.update({ where: { id }, data: { clientSecret } });

  // Revoke all existing tokens for this client
  await prisma.oAuthToken.updateMany({ where: { clientId: id }, data: { revoked: true } });

  res.json({ ok: true, clientSecret: rawSecret, message: 'Secret rotated and all tokens revoked' });
});

// ── Token Management ──────────────────────────────────────────────────────────

adminOAuthClientsRouter.get('/tokens', async (req: Request, res: Response) => {
  const { userId, clientId } = req.query as { userId?: string; clientId?: string };
  const tokens = await prisma.oAuthToken.findMany({
    where: {
      revoked: false,
      expiresAt: { gt: new Date() },
      ...(userId ? { userId } : {}),
      ...(clientId ? { clientId } : {}),
    },
    include: {
      user: { select: { email: true, displayName: true } },
      client: { select: { name: true, clientId: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  res.json(tokens);
});

adminOAuthClientsRouter.delete('/tokens/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const token = await prisma.oAuthToken.findUnique({ where: { id } });
  if (!token) { res.status(404).json({ error: 'Token not found' }); return; }
  await prisma.oAuthToken.update({ where: { id }, data: { revoked: true } });
  res.json({ ok: true });
});

// ── Consent Management ────────────────────────────────────────────────────────

/** GET  /api/v1/admin/oauth/consents — Liste aller erteilten Consents */
adminOAuthClientsRouter.get('/consents', async (req: Request, res: Response) => {
  const { userId, clientId } = req.query as { userId?: string; clientId?: string };
  const consents = await prisma.oAuthConsent.findMany({
    where: {
      revokedAt: null,
      ...(userId   ? { userId }   : {}),
      ...(clientId ? { clientId } : {}),
    },
    include: {
      user:   { select: { email: true, displayName: true } },
      client: { select: { name: true, clientId: true } },
    },
    orderBy: { grantedAt: 'desc' },
    take: 500,
  });
  res.json(consents);
});

/** DELETE /api/v1/admin/oauth/consents/:id — Consent widerrufen */
adminOAuthClientsRouter.delete('/consents/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const consent = await prisma.oAuthConsent.findUnique({ where: { id } });
  if (!consent) { res.status(404).json({ error: 'Consent not found' }); return; }
  await prisma.oAuthConsent.update({ where: { id }, data: { revokedAt: new Date() } });
  // Auch alle aktiven Tokens für diesen User+Client widerrufen
  await prisma.oAuthToken.updateMany({
    where: { userId: consent.userId, clientId: consent.clientId, revoked: false },
    data:  { revoked: true },
  });
  res.json({ ok: true });
});
