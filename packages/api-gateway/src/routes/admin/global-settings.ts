/**
 * Admin-API: Globale Servereinstellungen
 *
 * GET  /api/v1/admin/settings          — alle Einstellungen lesen
 * PUT  /api/v1/admin/settings          — alle Einstellungen speichern
 * PUT  /api/v1/admin/settings/org      — nur Organisations-Sektion
 * PUT  /api/v1/admin/settings/mail     — nur Mail-Grenzen
 * PUT  /api/v1/admin/settings/security — nur Sicherheitsrichtlinien
 * PUT  /api/v1/admin/settings/maintenance — Wartungsmodus an/aus
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { requireAdmin } from '../../middleware/auth.js';
import { createLogger } from '@coremail/core';
import { audit, auditContext, invalidateAuditCache } from '../../lib/audit.js';

const log = createLogger('admin:global-settings');
export const adminGlobalSettingsRouter: RouterType = Router();

// ── GET /api/v1/admin/settings/public ─────────────────────────────────────────
// Öffentlicher Endpunkt (kein Auth-Erfordernis) — gibt nur nicht-sensible
// Einstellungen zurück, die Frontend-Apps (MWA + BCP) vor dem Login brauchen.
adminGlobalSettingsRouter.get('/public', async (_req: Request, res: Response) => {
  try {
    const cfg = await prisma.serverSettings.findUnique({ where: { id: 'singleton' } });
    res.json({
      orgName:                  cfg?.orgName                 ?? 'CoreMail',
      logoUrl:                  cfg?.logoUrl                 ?? '',
      language:                 cfg?.language                ?? 'de',
      inactivityTimeoutMinutes: cfg?.inactivityTimeoutMinutes ?? 30,
      maintenanceMode:          cfg?.maintenanceMode         ?? false,
      maintenanceMessage:       cfg?.maintenanceMessage      ?? '',
      selfServicePasswordReset: cfg?.selfServicePasswordReset ?? true,
    });
  } catch {
    res.json({ orgName: 'CoreMail', logoUrl: '', language: 'de', inactivityTimeoutMinutes: 30, maintenanceMode: false, maintenanceMessage: '', selfServicePasswordReset: true });
  }
});

adminGlobalSettingsRouter.use(requireAdmin);

// ── Singleton laden / erstellen ───────────────────────────────────────────────
async function getOrCreate() {
  return prisma.serverSettings.upsert({
    where:  { id: 'singleton' },
    create: { id: 'singleton' },
    update: {},
  });
}

// ── Zod-Schemas pro Sektion ────────────────────────────────────────────────────

const OrgSchema = z.object({
  orgName:        z.string().min(1).max(100),
  orgDescription: z.string().max(500).default(''),
  adminEmail:     z.string().email().or(z.literal('')).default(''),
  language:       z.enum(['de', 'en']).default('de'),
  timezone:       z.string().min(1).max(60).default('Europe/Berlin'),
  welcomeMessage: z.string().max(1000).default(''),
  logoUrl:        z.string().url().or(z.literal('')).default(''),
});

const MailSchema = z.object({
  maxMessageSizeMb:    z.number().int().min(1).max(500).default(25),
  maxAttachmentSizeMb: z.number().int().min(1).max(500).default(25),
  trashRetentionDays:  z.number().int().min(1).max(3650).default(30),
});

const SecuritySchema = z.object({
  minPasswordLength:          z.number().int().min(4).max(64).default(8),
  maxLoginAttempts:           z.number().int().min(1).max(100).default(5),
  sessionTimeoutMinutes:      z.number().int().min(5).max(10080).default(480),
  // 0 = deaktiviert; 1–1440 = Minuten bis automatischer Logout bei Browser-Inaktivität
  inactivityTimeoutMinutes:   z.number().int().min(0).max(1440).default(30),
  requireMfaForAdmins:        z.boolean().default(false),
  allowSelfRegistration:      z.boolean().default(false),
  selfServicePasswordReset:   z.boolean().default(true),
  // v3.18.30: Audit-Log global ein/aus. Toggle wird ungeachtet seines eigenen
  // Werts immer als kritisches Event geloggt (siehe ALWAYS_AUDIT in audit.ts).
  auditLogEnabled:            z.boolean().default(true),
});

const MaintenanceSchema = z.object({
  maintenanceMode:    z.boolean(),
  maintenanceMessage: z.string().max(500).default(
    'Der Server befindet sich derzeit in Wartung. Bitte versuchen Sie es später erneut.',
  ),
});

// ── GET /api/v1/admin/settings ─────────────────────────────────────────────────
adminGlobalSettingsRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const cfg = await getOrCreate();
    res.json(cfg);
  } catch (err) {
    log.error({ err }, 'Fehler beim Lesen der globalen Einstellungen');
    res.status(500).json({ error: 'Einstellungen nicht verfügbar' });
  }
});

// ── PUT /api/v1/admin/settings/org ────────────────────────────────────────────
adminGlobalSettingsRouter.put('/org', async (req: Request, res: Response) => {
  const parsed = OrgSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Ungültige Eingabe', details: parsed.error.issues });
    return;
  }
  const cfg = await prisma.serverSettings.upsert({
    where:  { id: 'singleton' },
    create: { id: 'singleton', ...parsed.data },
    update: parsed.data,
  });
  log.info({ orgName: parsed.data.orgName }, 'Organisations-Einstellungen aktualisiert');
  res.json(cfg);
});

// ── PUT /api/v1/admin/settings/mail ───────────────────────────────────────────
adminGlobalSettingsRouter.put('/mail', async (req: Request, res: Response) => {
  const parsed = MailSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Ungültige Eingabe', details: parsed.error.issues });
    return;
  }
  const cfg = await prisma.serverSettings.upsert({
    where:  { id: 'singleton' },
    create: { id: 'singleton', ...parsed.data },
    update: parsed.data,
  });
  log.info(parsed.data, 'Mail-Einstellungen aktualisiert');
  res.json(cfg);
});

// ── PUT /api/v1/admin/settings/security ───────────────────────────────────────
adminGlobalSettingsRouter.put('/security', async (req: Request, res: Response) => {
  const parsed = SecuritySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Ungültige Eingabe', details: parsed.error.issues });
    return;
  }

  // v3.18.30: Audit-Toggle-Wechsel SPEZIELL loggen, BEVOR der Cache invalidiert wird.
  // Auch wenn der Admin Audit gleich ausschaltet — diese Aktion bleibt durch ALWAYS_AUDIT
  // („audit.*" + „settings.*") garantiert protokolliert.
  const before = await prisma.serverSettings.findUnique({
    where: { id: 'singleton' },
    select: { auditLogEnabled: true },
  });
  const auditFlagChanged = (before?.auditLogEnabled ?? true) !== parsed.data.auditLogEnabled;

  const cfg = await prisma.serverSettings.upsert({
    where:  { id: 'singleton' },
    create: { id: 'singleton', ...parsed.data },
    update: parsed.data,
  });

  if (auditFlagChanged) {
    const user = (req as Request & { apiUser?: { userId: string; email: string } }).apiUser;
    audit({
      ...(user?.userId !== undefined ? { actorId: user.userId } : {}),
      ...(user?.email !== undefined ? { actorEmail: user.email } : {}),
      action: parsed.data.auditLogEnabled ? 'audit.enabled' : 'audit.disabled',
      targetType: 'settings',
      targetId: 'audit_log',
      changes: {
        auditLogEnabled: {
          from: String(before?.auditLogEnabled ?? true),
          to: String(parsed.data.auditLogEnabled),
        },
      },
      ...auditContext(req),
    });
  }

  // Cache der audit-Middleware invalidieren, damit Toggle sofort greift.
  invalidateAuditCache();

  log.info(parsed.data, 'Sicherheitsrichtlinien aktualisiert');
  res.json(cfg);
});

// ── PUT /api/v1/admin/settings/maintenance ────────────────────────────────────
adminGlobalSettingsRouter.put('/maintenance', async (req: Request, res: Response) => {
  const parsed = MaintenanceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Ungültige Eingabe', details: parsed.error.issues });
    return;
  }
  const cfg = await prisma.serverSettings.upsert({
    where:  { id: 'singleton' },
    create: { id: 'singleton', ...parsed.data },
    update: parsed.data,
  });
  log.info({ maintenanceMode: parsed.data.maintenanceMode }, 'Wartungsmodus geändert');
  res.json(cfg);
});
