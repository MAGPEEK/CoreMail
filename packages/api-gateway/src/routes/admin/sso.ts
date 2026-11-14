/**
 * Admin API: SSO / OIDC provider management (OIDC/OAuth2 only — no SAML)
 *
 * GET    /api/v1/admin/sso/providers            — all OIDC providers (clientSecret never returned)
 * POST   /api/v1/admin/sso/providers            — create new provider
 * PUT    /api/v1/admin/sso/providers/:id        — update (empty clientSecret = unchanged)
 * DELETE /api/v1/admin/sso/providers/:id        — delete
 * POST   /api/v1/admin/sso/providers/:id/test   — discovery test of a saved provider
 * POST   /api/v1/admin/sso/test-discovery       — discovery test of an unsaved URL { discoveryUrl }
 * GET    /api/v1/admin/sso/domains              — domains
 *
 * Every provider carries `redirectUri` — the callback URL to register at the IdP.
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { describeDiscovery, invalidateOidcClient, ssoRedirectUri } from '@coremail/auth-sso';
import { requireArea } from '../../middleware/auth.js';
import { publicBaseUrl } from '../sso.js';

const log = createLogger('admin:sso');
export const adminSsoRouter: RouterType = Router();
adminSsoRouter.use(requireArea('identity'));

const domainList = z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).max(100);
const httpsUrl = z.string().url().refine((u) => /^https?:\/\//i.test(u), 'http(s) URL required');

// ── GET /providers ────────────────────────────────────────────────────────────
adminSsoRouter.get('/providers', async (_req: Request, res: Response) => {
  const providers = await prisma.oidcProvider.findMany({
    include: { domain: { select: { id: true, name: true } } },
    orderBy: { domain: { name: 'asc' } },
  });
  const base = await publicBaseUrl();
  res.json(providers.map(p => ({
    id:            p.id,
    domainId:      p.domainId,
    domainName:    p.domain.name,
    name:          p.name,
    discoveryUrl:  p.discoveryUrl,
    clientId:      p.clientId,
    // clientSecret is never returned
    hasClientSecret: p.clientSecret.length > 0,
    claimMap:      p.claimMap,
    autoProvision: p.autoProvision,
    forcedDomains: p.forcedDomains,
    scopes:        p.scopes,
    requireEmailVerified: p.requireEmailVerified,
    allowLinking:  p.allowLinking,
    requireMfa:    p.requireMfa,
    active:        p.active,
    createdAt:     p.createdAt,
    redirectUri:   ssoRedirectUri(base, p.id),
  })));
});

const ProviderFields = {
  name:          z.string().min(1).max(64),
  discoveryUrl:  httpsUrl,
  clientId:      z.string().min(1).max(512),
  claimMap:      z.record(z.string()),
  autoProvision: z.boolean(),
  forcedDomains: domainList,
  scopes:        z.string().max(512).regex(/(^|\s)openid(\s|$)/, 'scopes must include openid'),
  requireEmailVerified: z.boolean(),
  allowLinking:  z.boolean(),
  requireMfa:    z.boolean(),
  active:        z.boolean(),
};

// ── POST /providers ───────────────────────────────────────────────────────────
adminSsoRouter.post('/providers', async (req: Request, res: Response) => {
  const schema = z.object({
    domainId:      z.string().min(1),
    name:          ProviderFields.name,
    discoveryUrl:  ProviderFields.discoveryUrl,
    clientId:      ProviderFields.clientId,
    clientSecret:  z.string().min(1).max(2048),
    claimMap:      ProviderFields.claimMap.default({}),
    autoProvision: ProviderFields.autoProvision.default(true),
    forcedDomains: ProviderFields.forcedDomains.default([]),
    scopes:        ProviderFields.scopes.default('openid email profile'),
    requireEmailVerified: ProviderFields.requireEmailVerified.default(true),
    allowLinking:  ProviderFields.allowLinking.default(false),
    requireMfa:    ProviderFields.requireMfa.default(false),
    active:        ProviderFields.active.default(true),
  });
  const p = schema.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Ungültige Eingabe', issues: p.error.issues }); return; }

  const domain = await prisma.domain.findUnique({ where: { id: p.data.domainId } });
  if (!domain) { res.status(404).json({ error: 'Domain nicht gefunden' }); return; }

  const provider = await prisma.oidcProvider.create({ data: p.data });
  log.info({ id: provider.id, name: p.data.name, domainId: p.data.domainId }, 'OIDC provider created');
  res.status(201).json({ id: provider.id, redirectUri: ssoRedirectUri(await publicBaseUrl(), provider.id) });
});

// ── PUT /providers/:id ────────────────────────────────────────────────────────
adminSsoRouter.put('/providers/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const schema = z.object({
    name:          ProviderFields.name.optional(),
    discoveryUrl:  ProviderFields.discoveryUrl.optional(),
    clientId:      ProviderFields.clientId.optional(),
    clientSecret:  z.string().max(2048).optional(), // '' = unchanged
    claimMap:      ProviderFields.claimMap.optional(),
    autoProvision: ProviderFields.autoProvision.optional(),
    forcedDomains: ProviderFields.forcedDomains.optional(),
    scopes:        ProviderFields.scopes.optional(),
    requireEmailVerified: ProviderFields.requireEmailVerified.optional(),
    allowLinking:  ProviderFields.allowLinking.optional(),
    requireMfa:    ProviderFields.requireMfa.optional(),
    active:        ProviderFields.active.optional(),
  });
  const p = schema.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Ungültige Eingabe', issues: p.error.issues }); return; }

  const { clientSecret, ...rest } = p.data;
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) data[k] = v;
  if (clientSecret) data['clientSecret'] = clientSecret;

  try {
    await prisma.oidcProvider.update({ where: { id }, data });
    invalidateOidcClient(id);
    log.info({ id }, 'OIDC provider updated');
    res.json({ ok: true });
  } catch { res.status(404).json({ error: 'Provider nicht gefunden' }); }
});

// ── DELETE /providers/:id ─────────────────────────────────────────────────────
adminSsoRouter.delete('/providers/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  try {
    await prisma.oidcProvider.delete({ where: { id } });
    invalidateOidcClient(id);
    log.info({ id }, 'OIDC provider deleted');
    res.status(204).end();
  } catch { res.status(404).json({ error: 'Provider nicht gefunden' }); }
});

async function discoveryResult(discoveryUrl: string, providerId?: string) {
  try {
    const d = await describeDiscovery(discoveryUrl);
    const warnings: string[] = [];
    if (!d.pkceS256) warnings.push('Discovery-Dokument nennt kein PKCE S256 (code_challenge_methods_supported)');
    if (d.idTokenAlgs.length > 0 && !d.idTokenAlgs.includes('RS256')) warnings.push('IdP signiert ID-Tokens nicht mit RS256');
    return {
      success: true,
      message: 'Discovery-Dokument erfolgreich abgerufen',
      issuer: d.issuer,
      authorizationEndpoint: d.authorizationEndpoint,
      tokenEndpoint: d.tokenEndpoint,
      jwksUri: d.jwksUri,
      pkceS256: d.pkceS256,
      scopesSupported: d.scopes,
      idTokenAlgs: d.idTokenAlgs,
      warnings,
      ...(providerId ? { redirectUri: ssoRedirectUri(await publicBaseUrl(), providerId) } : {}),
    };
  } catch (err) {
    return { success: false, message: `Discovery fehlgeschlagen: ${(err as Error).message}` };
  }
}

// ── POST /providers/:id/test ──────────────────────────────────────────────────
adminSsoRouter.post('/providers/:id/test', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const provider = await prisma.oidcProvider.findUnique({ where: { id } });
  if (!provider) { res.status(404).json({ error: 'Provider nicht gefunden' }); return; }
  const r = await discoveryResult(provider.discoveryUrl, provider.id);
  log.info({ id, success: r.success }, 'OIDC discovery test');
  res.json(r);
});

// ── POST /test-discovery ──────────────────────────────────────────────────────
adminSsoRouter.post('/test-discovery', async (req: Request, res: Response) => {
  const p = z.object({ discoveryUrl: httpsUrl }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Ungültige Discovery-URL' }); return; }
  res.json(await discoveryResult(p.data.discoveryUrl));
});

// ── GET /domains ──────────────────────────────────────────────────────────────
adminSsoRouter.get('/domains', async (_req: Request, res: Response) => {
  const domains = await prisma.domain.findMany({
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  res.json(domains);
});
