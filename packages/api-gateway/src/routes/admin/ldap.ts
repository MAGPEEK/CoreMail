/**
 * Admin API: LDAP / Active Directory
 *
 * GET    /api/v1/admin/ldap                    — all configured domains
 * GET    /api/v1/admin/ldap/:domainId           — LDAP configuration for a domain (no bindPassword)
 * PUT    /api/v1/admin/ldap/:domainId           — create / update (empty bindPassword on update = unchanged)
 * DELETE /api/v1/admin/ldap/:domainId           — delete
 * POST   /api/v1/admin/ldap/:domainId/test      — connect + service bind + search ({ email? } looks up one login)
 * POST   /api/v1/admin/ldap/:domainId/sync      — run the directory sync now (Redis lock, 409 while running)
 *
 * v6.1: the sync really syncs (@coremail/auth-ldap syncLdapUsers) and the test
 * really binds; bindPassword is never returned (only `hasBindPassword`).
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { runLdapSyncLocked, testLdapConnection, LdapSyncBusyError } from '@coremail/auth-ldap';
import { requireArea } from '../../middleware/auth.js';
import { publicLdapConfig } from '../../lib/secrets.js';

const log = createLogger('admin:ldap');
export const adminLdapRouter: RouterType = Router();
adminLdapRouter.use(requireArea('identity'));

// Response shape: every path goes through publicLdapConfig (lib/secrets.ts),
// so bindPassword can never leak (write-only, `hasBindPassword` instead).

// ── GET / ─────────────────────────────────────────────────────────────────────
adminLdapRouter.get('/', async (_req: Request, res: Response) => {
  const configs = await prisma.ldapConfig.findMany({
    include: { domain: { select: { id: true, name: true } } },
    orderBy: { domain: { name: 'asc' } },
  });
  res.json(configs.map(c => ({
    domainId:    c.domainId,
    domainName:  c.domain.name,
    host:        c.host,
    port:        c.port,
    ssl:         c.ssl,
    startTls:    c.startTls,
    tlsVerify:   c.tlsVerify,
    baseDN:      c.baseDN,
    bindDN:      c.bindDN,
    enabled:     c.enabled,
    syncEnabled: c.syncEnabled,
    syncIntervalMinutes: c.syncIntervalMinutes,
    lastSyncAt:  c.lastSyncAt,
    lastSyncResult: c.lastSyncResult,
  })));
});

// ── GET /:domainId ────────────────────────────────────────────────────────────
adminLdapRouter.get('/:domainId', async (req: Request, res: Response) => {
  const { domainId } = req.params as { domainId: string };
  const cfg = await prisma.ldapConfig.findUnique({
    where: { domainId },
    include: { domain: { select: { id: true, name: true } } },
  });
  if (!cfg) { res.status(404).json({ error: 'Konfiguration nicht gefunden' }); return; }
  res.json({ ...publicLdapConfig(cfg), domainName: cfg.domain.name });
});

// ── PUT /:domainId ────────────────────────────────────────────────────────────
const LdapConfigSchema = z.object({
  host:        z.string().min(1),
  port:        z.number().int().min(1).max(65535).default(636),
  ssl:         z.boolean().default(true),
  startTls:    z.boolean().default(false),
  tlsVerify:   z.boolean().default(true),
  tlsCaCert:   z.string().max(65536).nullable().optional(),
  baseDN:      z.string().min(1),
  bindDN:      z.string().min(1),
  bindPassword: z.string().optional(),
  userDN:      z.string().min(1),
  userFilter:  z.string().min(3).default('(sAMAccountName={{username}})'),
  groupFilter: z.string().nullable().optional(),
  attributeMap: z.record(z.string()).default({}),
  enabled:     z.boolean().default(true),
  syncEnabled: z.boolean().default(true),
  syncIntervalMinutes: z.number().int().min(15).max(10080).default(1440),
  allowLocalTakeover: z.boolean().default(false),
});

adminLdapRouter.put('/:domainId', async (req: Request, res: Response) => {
  const { domainId } = req.params as { domainId: string };

  const domain = await prisma.domain.findUnique({ where: { id: domainId } });
  if (!domain) { res.status(404).json({ error: 'Domain nicht gefunden' }); return; }

  const p = LdapConfigSchema.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Ungültige Eingabe', issues: p.error.issues }); return; }
  if (!p.data.userFilter.includes('{{')) {
    res.status(400).json({ error: 'Der Benutzerfilter muss {{username}} oder {{email}} enthalten' });
    return;
  }

  const existing = await prisma.ldapConfig.findUnique({ where: { domainId }, select: { id: true } });
  const { bindPassword, tlsCaCert, groupFilter, ...rest } = p.data;
  const pw = bindPassword && bindPassword.length > 0 ? bindPassword : undefined;
  if (!existing && !pw) { res.status(400).json({ error: 'Bind-Passwort erforderlich' }); return; }

  const data = {
    ...rest,
    ...(pw ? { bindPassword: pw } : {}),
    ...(tlsCaCert !== undefined ? { tlsCaCert: tlsCaCert?.trim() ? tlsCaCert : null } : {}),
    ...(groupFilter !== undefined ? { groupFilter: groupFilter?.trim() ? groupFilter.trim() : null } : {}),
  };
  const cfg = existing
    ? await prisma.ldapConfig.update({ where: { domainId }, data })
    : await prisma.ldapConfig.create({ data: { ...data, domainId, bindPassword: pw! } });
  log.info({ domainId, host: p.data.host }, 'LDAP config saved');
  res.json(publicLdapConfig(cfg));
});

// ── DELETE /:domainId ─────────────────────────────────────────────────────────
adminLdapRouter.delete('/:domainId', async (req: Request, res: Response) => {
  const { domainId } = req.params as { domainId: string };
  try {
    await prisma.ldapConfig.delete({ where: { domainId } });
    log.info({ domainId }, 'LDAP config deleted');
    res.status(204).end();
  } catch { res.status(404).json({ error: 'Nicht gefunden' }); }
});

// ── POST /:domainId/test ──────────────────────────────────────────────────────
adminLdapRouter.post('/:domainId/test', async (req: Request, res: Response) => {
  const { domainId } = req.params as { domainId: string };
  const cfg = await prisma.ldapConfig.findUnique({ where: { domainId } });
  if (!cfg) { res.status(404).json({ error: 'Konfiguration nicht gefunden' }); return; }
  const email = (req.body as { email?: unknown } | undefined)?.email;
  const lookup = typeof email === 'string' && email.includes('@') && email.length <= 320 ? email : undefined;
  const result = await testLdapConnection(cfg, lookup);
  log.info({ domainId, success: result.success }, 'LDAP connection test');
  res.json(result);
});

// ── POST /:domainId/sync ──────────────────────────────────────────────────────
adminLdapRouter.post('/:domainId/sync', async (req: Request, res: Response) => {
  const { domainId } = req.params as { domainId: string };
  const cfg = await prisma.ldapConfig.findUnique({ where: { domainId }, select: { id: true, enabled: true } });
  if (!cfg) { res.status(404).json({ error: 'Konfiguration nicht gefunden' }); return; }
  if (!cfg.enabled) { res.status(409).json({ error: 'LDAP ist für diese Domain deaktiviert' }); return; }
  try {
    const result = await runLdapSyncLocked(domainId);
    log.info({ domainId, created: result.created, deactivated: result.deactivated }, 'LDAP sync run by admin');
    res.json({ ok: true, syncedAt: result.finishedAt, result });
  } catch (err) {
    if (err instanceof LdapSyncBusyError) { res.status(409).json({ error: 'Eine Synchronisation läuft bereits' }); return; }
    log.error({ err, domainId }, 'LDAP sync failed');
    res.status(502).json({ error: `Synchronisation fehlgeschlagen: ${(err as Error).message}` });
  }
});
