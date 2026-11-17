/**
 * Admin API: global server settings
 *
 * GET  /api/v1/admin/settings          — read all settings
 * PUT  /api/v1/admin/settings/org      — organisation section only
 * PUT  /api/v1/admin/settings/mail     — mail limits only
 * PUT  /api/v1/admin/settings/security — security policies only
 * PUT  /api/v1/admin/settings/maintenance — maintenance mode on/off
 *
 * Every PUT is a partial update: fields left out keep their stored value
 * (no schema defaults that would silently reset them). After a save the
 * services are told via CHANNEL_SETTINGS_RELOAD (e.g. maxMessageSizeMb is
 * cached by IMAP/JMAP).
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { requireArea } from '../../middleware/auth.js';
import { createLogger, getRedisClient, CHANNEL_SETTINGS_RELOAD } from '@coremail/core';
import { audit, auditContext, invalidateAuditCache } from '../../lib/audit.js';
import { publicServerSettings } from '../../lib/secrets.js';
import { API_RATE_LIMIT_BOUNDS, resolveApiRateLimit } from '../../lib/api-rate-limit.js';
import { reloadApiRateLimitConfig } from '../../lib/api-rate-limit-state.js';

/**
 * Settings view for the BCP: the public fields plus the API rate-limit fields an
 * API_RATE_LIMIT_* environment variable overrides (shown read-only).
 */
export function settingsView<T extends object>(cfg: T): Record<string, unknown> {
  return { ...publicServerSettings(cfg), apiRateLimitEnvOverrides: resolveApiRateLimit(cfg).envOverrides };
}

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

adminGlobalSettingsRouter.use(requireArea('organisation'));

// ── Load / create singleton ───────────────────────────────────────────────────
async function getOrCreate() {
  return prisma.serverSettings.upsert({
    where:  { id: 'singleton' },
    create: { id: 'singleton' },
    update: {},
  });
}

// ── Zod schemas per section ────────────────────────────────────────────────────

export const OrgSchema = z.object({
  orgName:        z.string().trim().min(1).max(100),
  orgDescription: z.string().max(500),
  adminEmail:     z.string().email().or(z.literal('')),
  language:       z.enum(['de', 'en']),
  timezone:       z.string().min(1).max(60),
  welcomeMessage: z.string().max(1000),
  logoUrl:        z.string().url().or(z.literal('')),
}).partial();

export const MailSchema = z.object({
  maxMessageSizeMb:    z.number().int().min(1).max(500),
  maxAttachmentSizeMb: z.number().int().min(1).max(500),
  trashRetentionDays:  z.number().int().min(1).max(3650),
}).partial();

export const SecuritySchema = z.object({
  // 8 = OWASP ASVS minimum for passwords without other factors
  minPasswordLength:          z.number().int().min(8).max(64),
  maxLoginAttempts:           z.number().int().min(1).max(100),
  sessionTimeoutMinutes:      z.number().int().min(5).max(10080),
  // 0 = disabled; 1–1440 = minutes until automatic logout on browser inactivity
  inactivityTimeoutMinutes:   z.number().int().min(0).max(1440),
  requireMfaForAdmins:        z.boolean(),
  allowSelfRegistration:      z.boolean(),
  selfServicePasswordReset:   z.boolean(),
  // v3.18.30: audit log globally on/off. The toggle is always logged as a
  // critical event regardless of its own value (see ALWAYS_AUDIT in audit.ts).
  auditLogEnabled:            z.boolean(),
  // 9.4: global API rate limit (lib/api-rate-limit.ts; API_RATE_LIMIT_* override)
  apiRateLimitEnabled:        z.boolean(),
  apiRateLimitWindowMin:      z.number().int().min(API_RATE_LIMIT_BOUNDS.windowMin[0]).max(API_RATE_LIMIT_BOUNDS.windowMin[1]),
  apiRateLimitPerIp:          z.number().int().min(API_RATE_LIMIT_BOUNDS.perIp[0]).max(API_RATE_LIMIT_BOUNDS.perIp[1]),
  apiRateLimitPerUser:        z.number().int().min(API_RATE_LIMIT_BOUNDS.perUser[0]).max(API_RATE_LIMIT_BOUNDS.perUser[1]),
}).partial();

export const MaintenanceSchema = z.object({
  maintenanceMode:    z.boolean(),
  maintenanceMessage: z.string().max(500),
}).partial();

/** 400 body: the first problems with their field names (shown by the BCP). */
function invalid(res: Response, issues: z.ZodIssue[]): void {
  const fields = issues.slice(0, 5).map((i) => `${i.path.join('.') || 'body'}: ${i.message}`);
  res.status(400).json({ error: `Ungültige Eingabe — ${fields.join('; ')}`, details: issues });
}

/** The provided fields only (partial update; exactOptionalPropertyTypes-safe for Prisma). */
export function definedOnly<T extends Record<string, unknown>>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> };
}

/** Tell the other services (fire-and-forget; a missing Redis must not fail the save). */
function publishReload(section: string): void {
  try {
    void getRedisClient().publish(CHANNEL_SETTINGS_RELOAD, JSON.stringify({ type: 'global-settings', section })).catch(() => undefined);
  } catch { /* Redis unavailable */ }
}

// ── GET /api/v1/admin/settings ─────────────────────────────────────────────────
adminGlobalSettingsRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const cfg = await getOrCreate();
    res.json(settingsView(cfg));
  } catch (err) {
    log.error({ err }, 'Failed to read global settings');
    res.status(500).json({ error: 'Einstellungen nicht verfügbar' });
  }
});

// ── PUT /api/v1/admin/settings/org ────────────────────────────────────────────
adminGlobalSettingsRouter.put('/org', async (req: Request, res: Response) => {
  const parsed = OrgSchema.safeParse(req.body);
  if (!parsed.success) { invalid(res, parsed.error.issues); return; }
  const cfg = await prisma.serverSettings.upsert({
    where:  { id: 'singleton' },
    create: { id: 'singleton', ...definedOnly(parsed.data) },
    update: definedOnly(parsed.data),
  });
  log.info({ orgName: parsed.data.orgName }, 'Organisation settings updated');
  publishReload('org');
  res.json(settingsView(cfg));
});

// ── PUT /api/v1/admin/settings/mail ───────────────────────────────────────────
adminGlobalSettingsRouter.put('/mail', async (req: Request, res: Response) => {
  const parsed = MailSchema.safeParse(req.body);
  if (!parsed.success) { invalid(res, parsed.error.issues); return; }
  const cfg = await prisma.serverSettings.upsert({
    where:  { id: 'singleton' },
    create: { id: 'singleton', ...definedOnly(parsed.data) },
    update: definedOnly(parsed.data),
  });
  log.info(parsed.data, 'Mail settings updated');
  publishReload('mail');
  res.json(settingsView(cfg));
});

// ── PUT /api/v1/admin/settings/security ───────────────────────────────────────
adminGlobalSettingsRouter.put('/security', async (req: Request, res: Response) => {
  const parsed = SecuritySchema.safeParse(req.body);
  if (!parsed.success) { invalid(res, parsed.error.issues); return; }

  // v3.18.30: log audit-toggle changes SPECIFICALLY, BEFORE the cache is invalidated.
  // Even if the admin is about to turn auditing off — this action is guaranteed to be
  // logged via ALWAYS_AUDIT („audit.*" + „settings.*").
  const before = await prisma.serverSettings.findUnique({
    where: { id: 'singleton' },
    select: { auditLogEnabled: true },
  });
  const auditFlagChanged = parsed.data.auditLogEnabled !== undefined
    && (before?.auditLogEnabled ?? true) !== parsed.data.auditLogEnabled;

  const cfg = await prisma.serverSettings.upsert({
    where:  { id: 'singleton' },
    create: { id: 'singleton', ...definedOnly(parsed.data) },
    update: definedOnly(parsed.data),
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
  // 9.4: the API rate limit applies at once (otherwise within the 60 s refresh)
  await reloadApiRateLimitConfig();

  log.info(parsed.data, 'Security policies updated');
  publishReload('security');
  res.json(settingsView(cfg));
});

// ── PUT /api/v1/admin/settings/maintenance ────────────────────────────────────
adminGlobalSettingsRouter.put('/maintenance', async (req: Request, res: Response) => {
  const parsed = MaintenanceSchema.safeParse(req.body);
  if (!parsed.success) { invalid(res, parsed.error.issues); return; }
  const cfg = await prisma.serverSettings.upsert({
    where:  { id: 'singleton' },
    create: { id: 'singleton', ...definedOnly(parsed.data) },
    update: definedOnly(parsed.data),
  });
  log.info({ maintenanceMode: parsed.data.maintenanceMode }, 'Maintenance mode changed');
  publishReload('maintenance');
  res.json(settingsView(cfg));
});
