/**
 * Admin API: global server settings
 *
 * GET  /api/v1/admin/settings          — read all settings
 * PUT  /api/v1/admin/settings          — save all settings
 * PUT  /api/v1/admin/settings/org      — organisation section only
 * PUT  /api/v1/admin/settings/mail     — mail limits only
 * PUT  /api/v1/admin/settings/security — security policies only
 * PUT  /api/v1/admin/settings/maintenance — maintenance mode on/off
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
// Public endpoint (no auth required) — returns only non-sensitive settings
// that the frontend apps (MWA + BCP) need before login.
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

// ── Load / create singleton ───────────────────────────────────────────────────
async function getOrCreate() {
  return prisma.serverSettings.upsert({
    where:  { id: 'singleton' },
    create: { id: 'singleton' },
    update: {},
  });
}

// ── Zod schemas per section ────────────────────────────────────────────────────

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
  // 0 = disabled; 1–1440 = minutes until automatic logout on browser inactivity
  inactivityTimeoutMinutes:   z.number().int().min(0).max(1440).default(30),
  requireMfaForAdmins:        z.boolean().default(false),
  allowSelfRegistration:      z.boolean().default(false),
  selfServicePasswordReset:   z.boolean().default(true),
  // v3.18.30: audit log globally on/off. The toggle is always logged as a
  // critical event regardless of its own value (see ALWAYS_AUDIT in audit.ts).
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

  // v3.18.30: log audit-toggle changes SPECIFICALLY, BEFORE the cache is invalidated.
  // Even if the admin is about to turn auditing off — this action is guaranteed to be
  // logged via ALWAYS_AUDIT („audit.*" + „settings.*").
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

  // Invalidate the audit middleware cache so the toggle takes effect immediately.
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
