/**
 * Admin API: global server settings
 *
 * GET  /api/v1/admin/settings          — read all settings
 * PUT  /api/v1/admin/settings/org      — organisation section only
 * PUT  /api/v1/admin/settings/mail     — mail limits only
 * PUT  /api/v1/admin/settings/security — security policies only
 * PUT  /api/v1/admin/settings/maintenance — maintenance mode on/off
 * GET/PUT /api/v1/admin/settings/password-reset — 10.6 self-service password reset
 *
 * Every PUT is a partial update: fields left out keep their stored value
 * (no schema defaults that would silently reset them). After a save the
 * services are told via CHANNEL_SETTINGS_RELOAD (e.g. maxMessageSizeMb is
 * cached by IMAP/JMAP).
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma, clearMessageSizeLimitCache, invalidateMailboxAccessAuditSettings } from '@coremail/storage';
import {
  MFA_GRACE_DAYS_BOUNDS, invalidateMfaEnforcementCache,
  SSPR_SETTINGS_FIELDS, countVerifiedRecoveryEmails, ssprAvailable, ssprPolicyOf, type SsprPolicy,
} from '@coremail/storage/auth';
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
      // 10.6: true only when a reset is possible at all (switch + at least one method)
      selfServicePasswordReset: ssprAvailable(ssprPolicyOf(cfg)),
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
  // 10.5: "MFA für alle Benutzer erzwingen" (storage auth/mfa-enforcement.ts):
  // grace period in days (0 = at once) and the sub-option that blocks the
  // primary password on mail protocols after the grace period
  requireMfaForAllUsers:               z.boolean(),
  mfaEnforcementGraceDays:             z.number().int().min(MFA_GRACE_DAYS_BOUNDS[0]).max(MFA_GRACE_DAYS_BOUNDS[1]),
  mfaEnforcementBlocksPrimaryPassword: z.boolean(),
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
  // 9.4: mailbox access audit (delegates / shared mailbox users) and the
  // retention of its entries in days (0 = keep)
  mailboxAccessAuditEnabled:       z.boolean(),
  mailboxAccessAuditRetentionDays: z.number().int().min(0).max(3650),
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

/** 10.5: the MFA policy fields of the security section (audited as `settings.mfa-policy.update`). */
export const MFA_POLICY_FIELDS = [
  'requireMfaForAdmins', 'requireMfaForAllUsers', 'mfaEnforcementGraceDays', 'mfaEnforcementBlocksPrimaryPassword',
] as const;
type MfaPolicyField = typeof MFA_POLICY_FIELDS[number];

/** Stored values when nothing was saved yet (schema defaults). */
const MFA_POLICY_DEFAULTS: Record<MfaPolicyField, boolean | number> = {
  requireMfaForAdmins: false, requireMfaForAllUsers: false, mfaEnforcementGraceDays: 7, mfaEnforcementBlocksPrimaryPassword: false,
};

/**
 * 10.5: what a security save changes in the MFA policy — the audit diff and,
 * when "MFA für alle Benutzer erzwingen" is switched ON, the new activation
 * time (mfaEnforcementSince: every account without MFA gets a new grace period).
 */
export function mfaPolicyChange(
  before: Partial<Record<MfaPolicyField, unknown>> | null,
  data: Partial<Record<MfaPolicyField, unknown>>,
  now: Date,
): { changes: Record<string, { from: string; to: string }>; since: Date | null } {
  const changes: Record<string, { from: string; to: string }> = {};
  for (const k of MFA_POLICY_FIELDS) {
    if (data[k] === undefined) continue;
    const from = before?.[k] ?? MFA_POLICY_DEFAULTS[k];
    if (from !== data[k]) changes[k] = { from: String(from), to: String(data[k]) };
  }
  const switchedOn = data.requireMfaForAllUsers === true && (before?.requireMfaForAllUsers ?? false) !== true;
  return { changes, since: switchedOn ? now : null };
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
  clearMessageSizeLimitCache(); // 9.4: REST /mail/send uses the new maximum message size at once
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
    select: {
      auditLogEnabled: true, requireMfaForAdmins: true, requireMfaForAllUsers: true,
      mfaEnforcementGraceDays: true, mfaEnforcementBlocksPrimaryPassword: true,
    },
  });
  const auditFlagChanged = parsed.data.auditLogEnabled !== undefined
    && (before?.auditLogEnabled ?? true) !== parsed.data.auditLogEnabled;
  // 10.5: MFA policy diff; switching the enforcement on starts new grace periods
  const mfa = mfaPolicyChange(before, parsed.data, new Date());
  const data = { ...definedOnly(parsed.data), ...(mfa.since ? { mfaEnforcementSince: mfa.since } : {}) };

  const cfg = await prisma.serverSettings.upsert({
    where:  { id: 'singleton' },
    create: { id: 'singleton', ...data },
    update: data,
  });

  if (Object.keys(mfa.changes).length > 0) {
    const user = req.apiUser;
    audit({
      ...(user?.userId !== undefined ? { actorId: user.userId } : {}),
      ...(user?.email !== undefined ? { actorEmail: user.email } : {}),
      action: 'settings.mfa-policy.update',
      targetType: 'settings',
      targetId: 'mfa_policy',
      changes: mfa.changes,
      ...auditContext(req),
    });
  }
  invalidateMfaEnforcementCache(); // 10.5: this process at once; other services within 15 s

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
  invalidateMailboxAccessAuditSettings(); // 9.4: this process; other services re-read within 60 s

  log.info(parsed.data, 'Security policies updated');
  publishReload('security');
  res.json(settingsView(cfg));
});

// ── GET/PUT /api/v1/admin/settings/password-reset ─────────────────────────────
// 10.6: self-service password reset (BCP → Authentifizierung → Passwort-
// Zurücksetzung, docs/password-reset.md). Area organisation (read
// SERVER_MANAGEMENT / VIEW_ONLY_ORG, write ORGANIZATION_MANAGEMENT),
// organisation-wide only. Every change is audited as
// `settings.password-reset.update` with a from/to diff (always logged).
export const PasswordResetSchema = z.object({
  enabled:       z.boolean(),
  recoveryEmail: z.boolean(),
  ownMailbox:    z.boolean(),
  allowAdmins:   z.boolean(),
}).partial().strict();

/** Pure: the ServerSettings columns of a partial policy update. */
export function passwordResetColumns(data: Partial<SsprPolicy>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const k of Object.keys(SSPR_SETTINGS_FIELDS) as (keyof SsprPolicy)[]) {
    const v = data[k];
    if (v !== undefined) out[SSPR_SETTINGS_FIELDS[k]] = v;
  }
  return out;
}

async function passwordResetView(cfg: Parameters<typeof ssprPolicyOf>[0]): Promise<Record<string, unknown>> {
  const policy = ssprPolicyOf(cfg);
  const [usersWithRecoveryEmail, localUsers, adminAccounts] = await Promise.all([
    countVerifiedRecoveryEmails().catch(() => null),
    prisma.user.count({ where: { active: true, authSource: 'LOCAL' } }).catch(() => null),
    prisma.user.count({ where: { active: true, authSource: 'LOCAL', NOT: { role: 'USER' } } }).catch(() => null),
  ]);
  return { ...policy, available: ssprAvailable(policy), stats: { usersWithRecoveryEmail, localUsers, adminAccounts } };
}

adminGlobalSettingsRouter.get('/password-reset', async (_req: Request, res: Response) => {
  try {
    const cfg = await prisma.serverSettings.findUnique({ where: { id: 'singleton' } });
    res.json(await passwordResetView(cfg));
  } catch (err) {
    log.error({ err }, 'Failed to read the password reset settings');
    res.status(500).json({ error: 'Einstellungen nicht verfügbar' });
  }
});

adminGlobalSettingsRouter.put('/password-reset', async (req: Request, res: Response) => {
  const parsed = PasswordResetSchema.safeParse(req.body);
  if (!parsed.success) { invalid(res, parsed.error.issues); return; }
  const data = definedOnly(parsed.data);
  const before = ssprPolicyOf(await prisma.serverSettings.findUnique({ where: { id: 'singleton' } }));
  const columns = passwordResetColumns(data);
  const cfg = await prisma.serverSettings.upsert({
    where:  { id: 'singleton' },
    create: { id: 'singleton', ...columns },
    update: columns,
  });
  const changes: Record<string, { from: string; to: string }> = {};
  for (const k of Object.keys(data) as (keyof SsprPolicy)[]) {
    if (data[k] !== undefined && before[k] !== data[k]) changes[k] = { from: String(before[k]), to: String(data[k]) };
  }
  if (Object.keys(changes).length > 0) {
    const user = req.apiUser;
    audit({
      ...(user?.userId !== undefined ? { actorId: user.userId } : {}),
      ...(user?.email !== undefined ? { actorEmail: user.email } : {}),
      action: 'settings.password-reset.update',
      targetType: 'settings',
      targetId: 'password_reset',
      changes,
      ...auditContext(req),
    });
  }
  log.info(data, 'Password reset settings updated');
  publishReload('password-reset');
  res.json(await passwordResetView(cfg));
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
