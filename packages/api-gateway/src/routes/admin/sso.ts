/**
 * Admin-API: SSO / OIDC-Provider-Verwaltung
 *
 * GET    /api/v1/admin/sso/providers            — Alle OIDC-Provider
 * POST   /api/v1/admin/sso/providers            — Neuen Provider anlegen
 * PUT    /api/v1/admin/sso/providers/:id        — Aktualisieren
 * DELETE /api/v1/admin/sso/providers/:id        — Löschen
 * POST   /api/v1/admin/sso/providers/:id/test   — Discovery-URL testen
 * GET    /api/v1/admin/sso/domains              — Domains ohne SSO-Konfiguration
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { requireAdmin } from '../../middleware/auth.js';

const log = createLogger('admin:sso');
export const adminSsoRouter: RouterType = Router();
adminSsoRouter.use(requireAdmin);

// ── GET /providers ────────────────────────────────────────────────────────────
adminSsoRouter.get('/providers', async (_req: Request, res: Response) => {
  const providers = await prisma.oidcProvider.findMany({
    include: { domain: { select: { id: true, name: true } } },
    orderBy: { domain: { name: 'asc' } },
  });
  res.json(providers.map(p => ({
    id:            p.id,
    domainId:      p.domainId,
    domainName:    p.domain.name,
    name:          p.name,
    discoveryUrl:  p.discoveryUrl,
    clientId:      p.clientId,
    // clientSecret wird nie zurückgegeben
    claimMap:      p.claimMap,
    autoProvision: p.autoProvision,
    forcedDomains: p.forcedDomains,
    active:        p.active,
    createdAt:     p.createdAt,
  })));
});

// ── POST /providers ───────────────────────────────────────────────────────────
adminSsoRouter.post('/providers', async (req: Request, res: Response) => {
  const schema = z.object({
    domainId:      z.string().cuid(),
    name:          z.string().min(1).max(64),
    discoveryUrl:  z.string().url(),
    clientId:      z.string().min(1),
    clientSecret:  z.string().min(1),
    claimMap:      z.record(z.string()).default({}),
    autoProvision: z.boolean().default(true),
    forcedDomains: z.array(z.string()).default([]),
    active:        z.boolean().default(true),
  });
  const p = schema.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Ungültige Eingabe', issues: p.error.issues }); return; }

  const domain = await prisma.domain.findUnique({ where: { id: p.data.domainId } });
  if (!domain) { res.status(404).json({ error: 'Domain nicht gefunden' }); return; }

  const provider = await prisma.oidcProvider.create({ data: p.data as any });
  log.info({ id: provider.id, name: p.data.name, domainId: p.data.domainId }, 'OIDC provider created');
  res.status(201).json({ id: provider.id });
});

// ── PUT /providers/:id ────────────────────────────────────────────────────────
adminSsoRouter.put('/providers/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const schema = z.object({
    name:          z.string().min(1).max(64).optional(),
    discoveryUrl:  z.string().url().optional(),
    clientId:      z.string().min(1).optional(),
    clientSecret:  z.string().min(1).optional(),
    claimMap:      z.record(z.string()).optional(),
    autoProvision: z.boolean().optional(),
    forcedDomains: z.array(z.string()).optional(),
    active:        z.boolean().optional(),
  });
  const p = schema.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Ungültige Eingabe' }); return; }

  try {
    await prisma.oidcProvider.update({ where: { id }, data: p.data as Record<string, unknown> });
    log.info({ id }, 'OIDC provider updated');
    res.json({ ok: true });
  } catch { res.status(404).json({ error: 'Provider nicht gefunden' }); }
});

// ── DELETE /providers/:id ─────────────────────────────────────────────────────
adminSsoRouter.delete('/providers/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  try {
    await prisma.oidcProvider.delete({ where: { id } });
    log.info({ id }, 'OIDC provider deleted');
    res.status(204).end();
  } catch { res.status(404).json({ error: 'Provider nicht gefunden' }); }
});

// ── POST /providers/:id/test ──────────────────────────────────────────────────
adminSsoRouter.post('/providers/:id/test', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const provider = await prisma.oidcProvider.findUnique({ where: { id } });
  if (!provider) { res.status(404).json({ error: 'Provider nicht gefunden' }); return; }

  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(provider.discoveryUrl, { signal: ctrl.signal });
    clearTimeout(timeout);

    if (!resp.ok) {
      res.json({ success: false, message: `Discovery-URL antwortet mit HTTP ${resp.status}` });
      return;
    }
    const doc = await resp.json() as { issuer?: string; authorization_endpoint?: string; token_endpoint?: string };
    log.info({ id, issuer: doc.issuer }, 'OIDC discovery test successful');
    res.json({
      success: true,
      message: 'Discovery-Dokument erfolgreich abgerufen',
      issuer: doc.issuer,
      authorizationEndpoint: doc.authorization_endpoint,
      tokenEndpoint:         doc.token_endpoint,
    });
  } catch (err) {
    res.json({ success: false, message: `Verbindungsfehler: ${(err as Error).message}` });
  }
});

// ── GET /domains ──────────────────────────────────────────────────────────────
adminSsoRouter.get('/domains', async (_req: Request, res: Response) => {
  const domains = await prisma.domain.findMany({
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  res.json(domains);
});
