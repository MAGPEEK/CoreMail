/**
 * 10.6: per-user MFA policy overrides and remembered MFA devices
 * (BCP → Authentifizierung → Mehrstufige Anmeldung → Ausnahmen pro Benutzer,
 * and the field in BCP → Postfächer → Bearbeiten).
 *
 *   GET    /api/v1/admin/user-mfa?q=&overrides=1   accounts in scope with override / enrolment / effective policy
 *   GET    /api/v1/admin/user-mfa/:id              one account + its remembered devices
 *   PUT    /api/v1/admin/user-mfa/:id              { mfaPolicy: 'inherit' | 'required' | 'optional' | 'off' }
 *   DELETE /api/v1/admin/user-mfa/:id/trusted-devices   revoke every remembered device of the account
 *
 * Area recipients (write: RECIPIENT_MANAGEMENT; read: HELP_DESK, VIEW_ONLY_ORG).
 * Scope (9.5): a domain-scoped admin sees and changes only accounts of its
 * domains (other ids answer 404 like unknown ids).
 *
 * 10.6 review — override writes (PUT):
 *   - never on the caller's own account (403 MFA_POLICY_OWN_ACCOUNT);
 *   - the acting session must be MFA-verified (403 MFA_NOT_VERIFIED, the rule of
 *     the other sensitive admin MFA routes, e.g. admin/passkeys.ts);
 *   - an admin account (role ≠ USER) only by ORGANIZATION_MANAGEMENT
 *     (canManageAccount → 403 FORBIDDEN_ROLE); devices of an admin likewise.
 *   - a grace period that already started is never restarted or extended: the
 *     grace start (User.mfaGraceStartedAt) of an admin account is never cleared;
 *     a plain USER account gets a fresh grace only when its effective policy
 *     moves from "not required" to "required".
 * A change publishes `mfa-policy-change` (caches only — no session or connection ends).
 *
 *   GET    /api/v1/admin/mfa-status   (any admin role, own account) — the admin
 *          MFA rule state of the caller: { state, deadline?, canEnrol } for the
 *          BCP prompt during the admin grace period.
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage';
import {
  adminMfaEnforcementFor, getAuthFactorsMany, levelFromDb, levelToDb, listTrustedDevices, loadMfaPolicySettings, publishUserAuthChange,
  resolveMfaPolicy, revokeTrustedDevicesOfUser, weakensMfaPolicy, type MfaPolicyLevel,
} from '@coremail/storage/auth';
import { requireAdmin, requireArea } from '../../middleware/auth.js';
import { scopeOf, scopeParam } from '../../middleware/admin-scope.js';
import { scopeDomainIds } from '../../lib/admin-scope.js';
import { canManageAccount } from '../../lib/rbac.js';
import { audit, auditContext } from '../../lib/audit.js';

const log = createLogger('admin:user-mfa');

export const adminUserMfaRouter: RouterType = Router();
adminUserMfaRouter.use(requireArea('recipients'));
adminUserMfaRouter.param('id', scopeParam('user'));

const isAdminRole = (role: string | null | undefined): boolean => !!role && role !== 'USER';

/**
 * Pure: may `actorRole` change the override of an account with `targetRole` from `before` to `after` (effective levels)?
 * 10.6 review: admin accounts only by ORGANIZATION_MANAGEMENT (canManageAccount) — also when strengthening.
 */
export function overrideChangeAllowed(
  actorRole: string, targetRole: string, before: MfaPolicyLevel, after: MfaPolicyLevel,
): boolean {
  if (!isAdminRole(targetRole)) return true;
  if (!canManageAccount(actorRole, targetRole)) return false;
  return actorRole === 'ORGANIZATION_MANAGEMENT' || !weakensMfaPolicy(before, after);
}

/**
 * Pure (10.6 review): the grace start to write with an override change — `null`
 * (clear: a fresh grace period) only for a plain USER account whose effective
 * policy moves from "not required" to "required"; otherwise `undefined` (keep
 * it: a grace that already started is never restarted or extended).
 */
export function graceResetOnOverride(targetRole: string, before: MfaPolicyLevel, after: MfaPolicyLevel): null | undefined {
  if (isAdminRole(targetRole)) return undefined;
  return before !== 'required' && after === 'required' ? null : undefined;
}

async function enrolledSet(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  // 10.6: the central factor rule (TOTP, passkeys, security keys — storage auth-factors.ts)
  const factors = await getAuthFactorsMany(ids);
  return new Set(ids.filter((id) => factors.get(id)?.enrolled === true));
}

const ListQuery = z.object({
  q: z.string().max(200).optional(),
  overrides: z.enum(['0', '1', 'true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

adminUserMfaRouter.get('/', async (req: Request, res: Response) => {
  const parsed = ListQuery.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid query' }); return; }
  const domainIds = scopeDomainIds(scopeOf(req));
  const q = parsed.data.q?.trim() ?? '';
  const overridesOnly = parsed.data.overrides === '1' || parsed.data.overrides === 'true';
  try {
    const users = await prisma.user.findMany({
      where: {
        ...(domainIds ? { domainId: { in: domainIds } } : {}),
        ...(overridesOnly ? { mfaPolicy: { not: null } } : {}),
        ...(q ? {
          OR: [
            { email: { contains: q, mode: 'insensitive' as const } },
            { displayName: { contains: q, mode: 'insensitive' as const } },
          ],
        } : {}),
      },
      select: { id: true, email: true, displayName: true, role: true, domainId: true, active: true, mfaPolicy: true },
      orderBy: { email: 'asc' },
      take: parsed.data.limit ?? 100,
    });
    const settings = await loadMfaPolicySettings();
    const enrolled = await enrolledSet(users.map((u) => u.id));
    res.json({
      items: users.map((u) => {
        const r = resolveMfaPolicy(settings, { role: String(u.role), mfaPolicy: u.mfaPolicy ?? null });
        return {
          id: u.id, email: u.email, displayName: u.displayName, role: u.role, domainId: u.domainId, active: u.active,
          mfaPolicy: levelFromDb(u.mfaPolicy), enrolled: enrolled.has(u.id),
          effective: { level: r.level, source: r.source },
        };
      }),
    });
  } catch (err) {
    log.error({ err }, 'Listing MFA overrides failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

adminUserMfaRouter.get('/:id', async (req: Request, res: Response) => {
  const id = String(req.params['id']);
  try {
    const u = await prisma.user.findUnique({
      where: { id }, select: { id: true, email: true, displayName: true, role: true, mfaPolicy: true },
    });
    if (!u) { res.status(404).json({ error: 'Not found' }); return; }
    const settings = await loadMfaPolicySettings();
    const r = resolveMfaPolicy(settings, { role: String(u.role), mfaPolicy: u.mfaPolicy ?? null });
    const inherited = resolveMfaPolicy(settings, { role: String(u.role), mfaPolicy: null });
    res.json({
      id: u.id, email: u.email, displayName: u.displayName, role: u.role,
      mfaPolicy: levelFromDb(u.mfaPolicy),
      enrolled: (await enrolledSet([u.id])).has(u.id),
      effective: { level: r.level, source: r.source },
      inherited: { level: inherited.level, source: inherited.source },
      trustedDevices: await listTrustedDevices(u.id),
      /** May the caller weaken this account's policy (admin accounts: ORGANIZATION_MANAGEMENT only)? */
      canWeaken: !isAdminRole(String(u.role)) || req.apiUser!.role === 'ORGANIZATION_MANAGEMENT',
      canRevokeDevices: canManageAccount(req.apiUser!.role, String(u.role)),
    });
  } catch (err) {
    log.error({ err, id }, 'Reading the MFA state of an account failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

const OverrideBody = z.object({ mfaPolicy: z.enum(['inherit', 'required', 'optional', 'off']) }).strict();

adminUserMfaRouter.put('/:id', async (req: Request, res: Response) => {
  const id = String(req.params['id']);
  const parsed = OverrideBody.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }
  const actor = req.apiUser!;
  // 10.6 review: never the own override (an admin could otherwise restart its own grace period)
  if (actor.userId === id) {
    res.status(403).json({ error: 'The MFA policy of your own account can only be changed by another administrator', code: 'MFA_POLICY_OWN_ACCOUNT' });
    return;
  }
  if (actor.mfaVerified !== true) {
    res.status(403).json({ error: 'This action needs a session verified with a second factor — please sign in again', code: 'MFA_NOT_VERIFIED' });
    return;
  }
  const u = await prisma.user.findUnique({ where: { id }, select: { id: true, email: true, role: true, mfaPolicy: true } });
  if (!u) { res.status(404).json({ error: 'Not found' }); return; }
  if (!canManageAccount(actor.role, String(u.role))) {
    res.status(403).json({ error: 'Only Organization Management may modify admin accounts', code: 'FORBIDDEN_ROLE' });
    return;
  }
  const settings = await loadMfaPolicySettings();
  const next = parsed.data.mfaPolicy === 'inherit' ? null : parsed.data.mfaPolicy;
  const before = resolveMfaPolicy(settings, { role: String(u.role), mfaPolicy: u.mfaPolicy ?? null });
  const after = resolveMfaPolicy(settings, { role: String(u.role), mfaPolicy: next });
  if (!overrideChangeAllowed(actor.role, String(u.role), before.level, after.level)) {
    res.status(403).json({
      error: 'Only Organization Management may weaken the MFA policy of an admin account',
      code: 'MFA_POLICY_WEAKEN_ADMIN',
    });
    return;
  }
  const from = levelFromDb(u.mfaPolicy);
  if (from !== next) {
    const grace = graceResetOnOverride(String(u.role), before.level, after.level);
    await prisma.user.update({
      where: { id },
      data: { mfaPolicy: next ? levelToDb(next) : null, ...(grace === null ? { mfaGraceStartedAt: null } : {}) },
    });
    await publishUserAuthChange(id, 'mfa-policy-change');
    audit({
      actorId: actor.userId, actorEmail: actor.email,
      action: 'mfa.policy.override', targetType: 'user', targetId: id, targetName: u.email,
      changes: {
        mfaPolicy: { from: from ?? 'inherit', to: next ?? 'inherit' },
        effective: { from: before.level, to: after.level },
      },
      ...auditContext(req),
    });
    log.info({ userId: id, from, to: next, actor: actor.userId }, 'MFA policy override changed');
  }
  res.json({
    id, mfaPolicy: next, effective: { level: after.level, source: after.source },
    // the UI warns when an admin ends up without a "required" policy
    adminWithoutMfaRequirement: isAdminRole(String(u.role)) && after.level !== 'required',
  });
});

adminUserMfaRouter.delete('/:id/trusted-devices', async (req: Request, res: Response) => {
  const id = String(req.params['id']);
  const actor = req.apiUser!;
  const u = await prisma.user.findUnique({ where: { id }, select: { id: true, email: true, role: true } });
  if (!u) { res.status(404).json({ error: 'Not found' }); return; }
  if (actor.userId !== id && !canManageAccount(actor.role, String(u.role))) {
    res.status(403).json({ error: 'Only Organization Management may modify admin accounts', code: 'FORBIDDEN_ROLE' });
    return;
  }
  const revoked = await revokeTrustedDevicesOfUser(id, 'admin-revoke');
  audit({
    actorId: actor.userId, actorEmail: actor.email,
    action: 'mfa.trusted-devices.revoke', targetType: 'user', targetId: id, targetName: u.email,
    changes: { revoked },
    ...auditContext(req),
  });
  res.json({ ok: true, revoked });
});

// ── GET /api/v1/admin/mfa-status — the caller's own admin MFA rule state ──────

export const adminMfaStatusRouter: RouterType = Router();

adminMfaStatusRouter.get('/', requireAdmin, async (req: Request, res: Response) => {
  const user = req.apiUser!;
  try {
    const { status, canEnrol } = await adminMfaEnforcementFor(user.userId);
    res.set('Cache-Control', 'no-store');
    res.json({
      state: status.state,
      ...('deadline' in status ? { deadline: status.deadline.toISOString() } : {}),
      canEnrol,
    });
  } catch (err) {
    log.error({ err, userId: user.userId }, 'Admin MFA state not readable');
    res.status(503).json({ error: 'Service temporarily unavailable' });
  }
});
