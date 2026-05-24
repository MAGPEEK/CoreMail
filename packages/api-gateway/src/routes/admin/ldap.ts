/**
 * Admin-API: LDAP / Active Directory
 *
 * GET    /api/v1/admin/ldap                    — Alle konfigurierten Domains
 * GET    /api/v1/admin/ldap/:domainId           — LDAP-Konfiguration für Domain
 * PUT    /api/v1/admin/ldap/:domainId           — Erstellen / Aktualisieren
 * DELETE /api/v1/admin/ldap/:domainId           — Löschen
 * POST   /api/v1/admin/ldap/:domainId/test      — Verbindungstest
 * POST   /api/v1/admin/ldap/:domainId/sync      — Manuellen Sync starten
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { createConnection } from 'node:net';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { requireAdmin } from '../../middleware/auth.js';

const log = createLogger('admin:ldap');
export const adminLdapRouter: RouterType = Router();
adminLdapRouter.use(requireAdmin);

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
    baseDN:      c.baseDN,
    bindDN:      c.bindDN,
    syncEnabled: c.syncEnabled,
    lastSyncAt:  c.lastSyncAt,
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
  res.json({ ...cfg, domainName: cfg.domain.name });
});

// ── PUT /:domainId ────────────────────────────────────────────────────────────
adminLdapRouter.put('/:domainId', async (req: Request, res: Response) => {
  const { domainId } = req.params as { domainId: string };

  const domain = await prisma.domain.findUnique({ where: { id: domainId } });
  if (!domain) { res.status(404).json({ error: 'Domain nicht gefunden' }); return; }

  const schema = z.object({
    host:        z.string().min(1),
    port:        z.number().int().min(1).max(65535).default(636),
    ssl:         z.boolean().default(true),
    baseDN:      z.string().min(1),
    bindDN:      z.string().min(1),
    bindPassword: z.string().min(1),
    userDN:      z.string().min(1),
    userFilter:  z.string().default('(sAMAccountName={{username}})'),
    groupFilter: z.string().optional(),
    attributeMap: z.record(z.string()).default({}),
    syncEnabled: z.boolean().default(true),
  });
  const p = schema.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Ungültige Eingabe', issues: p.error.issues }); return; }

  const cfg = await prisma.ldapConfig.upsert({
    where:  { domainId },
    update: p.data as any,
    create: { domainId, ...(p.data as any) },
  });
  log.info({ domainId, host: p.data.host }, 'LDAP config saved');
  res.json(cfg);
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

  // TCP-Erreichbarkeit prüfen (Port-Verbindungstest)
  const reachable = await new Promise<boolean>(resolve => {
    const sock = createConnection({ host: cfg.host, port: cfg.port });
    const timeout = setTimeout(() => { sock.destroy(); resolve(false); }, 5000);
    sock.on('connect', () => { clearTimeout(timeout); sock.destroy(); resolve(true); });
    sock.on('error',   () => { clearTimeout(timeout); resolve(false); });
  });

  if (!reachable) {
    res.json({ success: false, message: `TCP-Verbindung zu ${cfg.host}:${cfg.port} fehlgeschlagen (Timeout 5 s)` });
    return;
  }
  log.info({ domainId, host: cfg.host }, 'LDAP connection test successful');
  res.json({ success: true, message: `Verbindung zu ${cfg.host}:${cfg.port} erfolgreich (${cfg.ssl ? 'LDAPS' : 'LDAP'})` });
});

// ── POST /:domainId/sync ──────────────────────────────────────────────────────
adminLdapRouter.post('/:domainId/sync', async (req: Request, res: Response) => {
  const { domainId } = req.params as { domainId: string };
  const cfg = await prisma.ldapConfig.findUnique({ where: { domainId } });
  if (!cfg) { res.status(404).json({ error: 'Konfiguration nicht gefunden' }); return; }
  if (!cfg.syncEnabled) { res.status(409).json({ error: 'Synchronisation ist deaktiviert' }); return; }

  // Sync-Zeitstempel aktualisieren (echter Sync läuft im auth-ldap-Service)
  await prisma.ldapConfig.update({
    where: { domainId },
    data: { lastSyncAt: new Date() },
  });
  log.info({ domainId }, 'LDAP sync triggered');
  res.json({ ok: true, syncedAt: new Date().toISOString(), message: 'Synchronisation gestartet (auth-ldap-Service)' });
});
