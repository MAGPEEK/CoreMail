/**
 * Admin API: passkeys (10.6, docs/passkeys.md, decisions in docs/rbac.md).
 *
 * Policy (mounted at /api/v1/admin/authentication/passkeys; area organisation,
 * organisation-wide admins only — requireUnscoped; write = ORGANIZATION_MANAGEMENT):
 *   GET  /                    switch, passwordless, related origins, RP ID / origins
 *                             (read-only), HTTPS readiness, host-name warning, adoption
 *   PUT  /                    { enabled?, passwordless?, relatedOrigins? }
 *   GET  /domains/:id         domain level { setting, inherited, effective }
 *   PUT  /domains/:id         { setting: 'inherit' | 'on' | 'off' }
 *   Audit `settings.passkey-policy.update` (always logged).
 *
 * Per mailbox (mounted at /api/v1/admin/mailboxes; area recipients, scope = the
 * user's domain — out of scope answers 404):
 *   GET    /:id/passkeys            credentials + per-user switch + passkey-only state
 *   DELETE /:id/passkeys/:pid       remove one credential
 *   DELETE /:id/passkeys            remove every passkey / security key
 *   POST   /:id/mfa-reset           remove every factor (passkeys, security keys, TOTP, backup codes)
 *   POST   /:id/passkey-recovery    one-time recovery link (24 h, shown once)
 *   PUT    /:id/passkey-policy      { passkeys?: 'inherit'|'on'|'off', passwordLoginDisabled?: boolean }
 * Writes: area recipients write; an admin account (role ≠ USER) only by
 * ORGANIZATION_MANAGEMENT (canManageAccount); the acting admin's session must be
 * MFA-verified (403 MFA_NOT_VERIFIED); audited (`passkey.admin_*`,
 * `mailbox.passkey-policy.update`), and the user gets a security notice.
 */
import { Router, type Router as RouterType, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage';
import {
  PASSKEY_SETTINGS, getAuthFactors, issuePasskeyRecoveryToken, listCredentials, loadPasskeyServerPolicy, notifySecurityEvent,
  passkeyOnlyRefusal, passkeysAllowedFor, publishUserAuthChange, readPasskeyLevel, removeAllCredentials, deleteCredential,
  writePasskeyLevel, writePasskeyServerPolicy, type PasskeySetting,
} from '@coremail/storage/auth';
import { getRpConfig, invalidateRpConfigCache, passkeyReadiness } from '@coremail/storage/auth/webauthn';
import { requireArea } from '../../middleware/auth.js';
import { canManageAccount } from '../../lib/rbac.js';
import { requireUnscoped, scopeParam } from '../../middleware/admin-scope.js';
import { audit, auditContext } from '../../lib/audit.js';
import { publicBaseUrl } from '../sso.js';

const log = createLogger('admin:passkeys');

// ── Policy ────────────────────────────────────────────────────────────────────

/** Async handler → errors go to the error middleware (never an unhandled rejection). */
const guard = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

export const adminPasskeyPolicyRouter: RouterType = Router();
const orgArea = [requireArea('organisation'), requireUnscoped];

const httpsOrigin = z.string().trim().max(255).refine((v) => {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && (u.pathname === '/' || u.pathname === '') && !u.search && !u.hash && !u.username && !u.password;
  } catch { return false; }
}, 'https origin without path required').transform((v) => new URL(v).origin);

const PolicySchema = z.object({
  enabled: z.boolean().optional(),
  passwordless: z.boolean().optional(),
  relatedOrigins: z.array(httpsOrigin).max(20).optional(),
}).strict().refine((o) => Object.values(o).some((v) => v !== undefined), { message: 'Nothing to change' });

async function policyView() {
  invalidateRpConfigCache();
  const [policy, rp] = await Promise.all([loadPasskeyServerPolicy(), getRpConfig()]);
  const [passkeyOwners, passkeys, syncedPasskeys, securityKeys, legacyKeys, overrides] = await Promise.all([
    prisma.webAuthnCredential.findMany({ where: { kind: 'passkey' }, select: { userId: true }, distinct: ['userId'] }),
    prisma.webAuthnCredential.count({ where: { kind: 'passkey' } }),
    prisma.webAuthnCredential.count({ where: { kind: 'passkey', backupState: true } }),
    prisma.webAuthnCredential.count({ where: { kind: 'security_key' } }),
    prisma.webAuthnCredential.count({ where: { kind: 'security_key', userHandle: null } }),
    prisma.passkeyPolicy.findMany({ select: { domainId: true, userId: true, passkeys: true } }),
  ]);
  const readiness = passkeyReadiness(rp);
  return {
    enabled: policy.enabled,
    passwordless: policy.passwordless,
    relatedOrigins: policy.relatedOrigins,
    rp: {
      rpId: rp.rpID,
      frozen: rp.frozen,
      source: rp.source,
      hostRpId: rp.hostRpId,
      primaryOrigin: rp.primaryOrigin,
      origins: rp.origins,
      envOverride: { rpId: !!process.env['WEBAUTHN_RP_ID']?.trim(), origin: !!process.env['WEBAUTHN_ORIGIN']?.trim() },
    },
    readiness,
    // the RP ID was frozen for another host name: existing passkeys keep working only
    // while the old name still covers the origin (§5.1.4)
    hostNameChanged: rp.frozen && rp.rpID !== rp.hostRpId,
    adoption: { usersWithPasskeys: new Set(passkeyOwners.map((r) => r.userId)).size, passkeys, syncedPasskeys, securityKeys, legacyKeys },
    overrides: {
      domains: overrides.filter((o) => o.domainId).length,
      users: overrides.filter((o) => o.userId).length,
    },
  };
}

adminPasskeyPolicyRouter.get('/', orgArea, guard(async (_req, res) => {
  res.json(await policyView());
}));

adminPasskeyPolicyRouter.put('/', orgArea, guard(async (req, res) => {
  const parsed = PolicySchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }
  const patch = {
    ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
    ...(parsed.data.passwordless !== undefined ? { passwordless: parsed.data.passwordless } : {}),
    ...(parsed.data.relatedOrigins !== undefined ? { relatedOrigins: [...new Set(parsed.data.relatedOrigins)] } : {}),
  };
  const { before, after } = await writePasskeyServerPolicy(patch);
  audit({
    actorId: req.apiUser!.userId, actorEmail: req.apiUser!.email,
    action: 'settings.passkey-policy.update', targetType: 'settings', targetId: 'passkeys', targetName: 'server',
    changes: {
      before: { enabled: before.enabled, passwordless: before.passwordless, relatedOrigins: before.relatedOrigins },
      after: { enabled: after.enabled, passwordless: after.passwordless, relatedOrigins: after.relatedOrigins },
    },
    ...auditContext(req),
  });
  log.info({ enabled: after.enabled, passwordless: after.passwordless }, 'Passkey policy changed');
  res.json(await policyView());
}));

const LevelSchema = z.object({ setting: z.enum(PASSKEY_SETTINGS) }).strict();

adminPasskeyPolicyRouter.get('/domains/:id', orgArea, guard(async (req, res) => {
  const view = await readPasskeyLevel({ level: 'domain', domainId: String(req.params['id'] ?? '') });
  if (!view) { res.status(404).json({ error: 'Domain not found' }); return; }
  res.json({ level: 'domain', id: req.params['id'], ...view });
}));

adminPasskeyPolicyRouter.put('/domains/:id', orgArea, guard(async (req, res) => {
  const parsed = LevelSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }
  const domain = await prisma.domain.findUnique({ where: { id: String(req.params['id'] ?? '') }, select: { id: true, name: true } });
  if (!domain) { res.status(404).json({ error: 'Domain not found' }); return; }
  const before = await writePasskeyLevel({ level: 'domain', domainId: domain.id }, parsed.data.setting);
  audit({
    actorId: req.apiUser!.userId, actorEmail: req.apiUser!.email,
    action: 'settings.passkey-policy.update', targetType: 'domain', targetId: domain.id, targetName: domain.name,
    changes: { passkeys: { before, after: parsed.data.setting } },
    ...auditContext(req),
  });
  const view = await readPasskeyLevel({ level: 'domain', domainId: domain.id });
  res.json({ level: 'domain', id: domain.id, ...view });
}));

// ── Per mailbox ───────────────────────────────────────────────────────────────

export const adminMailboxPasskeysRouter: RouterType = Router();
// the area guard resolves the admin's scope — it must run before the scope check of :id
adminMailboxPasskeysRouter.use(requireArea('recipients'));
adminMailboxPasskeysRouter.param('id', scopeParam('user'));
const recipients = requireArea('recipients');

/** Write guard: admin accounts only by ORGANIZATION_MANAGEMENT; the acting session must be MFA-verified. */
async function loadTarget(req: Request, res: Response, write: boolean) {
  const user = await prisma.user.findUnique({
    where: { id: String(req.params['id'] ?? '') },
    select: { id: true, email: true, role: true, domainId: true, authSource: true, passwordLoginDisabled: true },
  });
  if (!user) { res.status(404).json({ error: 'User not found' }); return null; }
  if (write) {
    const actor = req.apiUser!;
    if (actor.userId !== user.id && !canManageAccount(actor.role, user.role)) {
      res.status(403).json({ error: 'Only Organization Management may change the sign-in of admin accounts', code: 'FORBIDDEN_ROLE' });
      return null;
    }
    if (actor.mfaVerified !== true) {
      res.status(403).json({ error: 'This action needs a session verified with a second factor — please sign in again', code: 'MFA_NOT_VERIFIED' });
      return null;
    }
  }
  return user;
}

adminMailboxPasskeysRouter.get('/:id/passkeys', recipients, guard(async (req, res) => {
  const user = await loadTarget(req, res, false);
  if (!user) return;
  const [passkeys, level, factors, allowed] = await Promise.all([
    listCredentials(user.id),
    readPasskeyLevel({ level: 'user', userId: user.id }),
    getAuthFactors(user.id),
    passkeysAllowedFor(user),
  ]);
  res.json({
    passkeys,
    policy: level,
    allowed,
    passwordLoginDisabled: user.passwordLoginDisabled === true,
    passkeyOnlyRefusal: await passkeyOnlyRefusal(user.id),
    factors: { totp: factors.totp, backupCodes: factors.backupCodes, passkeys: factors.passkeys, securityKeys: factors.securityKeys },
    eligible: String(user.authSource) !== 'OIDC',
  });
}));

adminMailboxPasskeysRouter.delete('/:id/passkeys/:pid', recipients, guard(async (req, res) => {
  const user = await loadTarget(req, res, true);
  if (!user) return;
  const actor = req.apiUser!;
  const r = await deleteCredential(user.id, String(req.params['pid'] ?? ''), { id: actor.userId, email: actor.email, ip: req.ip, admin: true });
  if (r === 'not_found') { res.status(404).json({ error: 'Not found' }); return; }
  if (r === 'last_passkey') {
    res.status(409).json({ error: 'The last passkey of a passkey-only account — turn passkey-only off first', code: 'LAST_PASSKEY' });
    return;
  }
  res.json({ ok: true });
}));

async function removeAll(req: Request, res: Response, allMfa: boolean): Promise<void> {
  const user = await loadTarget(req, res, true);
  if (!user) return;
  const actor = req.apiUser!;
  const r = await removeAllCredentials(user.id, { allMfa, actor: { id: actor.userId, email: actor.email, ip: req.ip } });
  audit({
    actorId: actor.userId, actorEmail: actor.email,
    action: allMfa ? 'mailbox.mfa.reset' : 'mailbox.passkeys.remove-all', targetType: 'mailbox', targetId: user.id, targetName: user.email,
    changes: { credentials: r.credentials, totp: r.totp },
    ...auditContext(req),
  });
  res.json({ ok: true, removed: r.credentials, totpReset: r.totp });
}

adminMailboxPasskeysRouter.delete('/:id/passkeys', recipients, guard(async (req, res) => removeAll(req, res, false)));
adminMailboxPasskeysRouter.post('/:id/mfa-reset', recipients, guard(async (req, res) => removeAll(req, res, true)));

adminMailboxPasskeysRouter.post('/:id/passkey-recovery', recipients, guard(async (req, res) => {
  const user = await loadTarget(req, res, true);
  if (!user) return;
  if (String(user.authSource) === 'OIDC' || !(await passkeysAllowedFor(user))) {
    res.status(409).json({ error: 'Passkeys are not enabled for this account', code: 'PASSKEYS_DISABLED' });
    return;
  }
  const actor = req.apiUser!;
  const { token, expiresAt } = await issuePasskeyRecoveryToken(user.id, actor.userId);
  // the token travels in the fragment: never in a Referer, a proxy log or the server log
  const url = `${await publicBaseUrl()}/passkey-recovery#${token}`;
  audit({
    actorId: actor.userId, actorEmail: actor.email,
    action: 'passkey.admin_recovery_issue', targetType: 'mailbox', targetId: user.id, targetName: user.email,
    changes: { expiresAt: expiresAt.toISOString() },
    ...auditContext(req),
  });
  void notifySecurityEvent({
    userId: user.id,
    subject: 'Security notice: a passkey recovery link was created for your account',
    bodyText:
      `An administrator created a one-time link on ${new Date().toUTCString()} to register a new passkey for your account ` +
      `(valid until ${expiresAt.toUTCString()}). Using it signs out every other session.\n\n` +
      'If you did not ask for it, inform your administrator.',
  });
  res.set('Cache-Control', 'no-store').json({ url, expiresAt: expiresAt.toISOString() });
}));

const UserPolicySchema = z.object({
  passkeys: z.enum(PASSKEY_SETTINGS).optional(),
  passwordLoginDisabled: z.boolean().optional(),
}).strict().refine((o) => o.passkeys !== undefined || o.passwordLoginDisabled !== undefined, { message: 'Nothing to change' });

adminMailboxPasskeysRouter.put('/:id/passkey-policy', recipients, guard(async (req, res) => {
  const parsed = UserPolicySchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request', details: parsed.error.issues }); return; }
  const user = await loadTarget(req, res, true);
  if (!user) return;
  const changes: Record<string, unknown> = {};
  if (parsed.data.passkeys !== undefined) {
    const before: PasskeySetting = await writePasskeyLevel({ level: 'user', userId: user.id }, parsed.data.passkeys);
    changes['passkeys'] = { before, after: parsed.data.passkeys };
  }
  if (parsed.data.passwordLoginDisabled !== undefined && parsed.data.passwordLoginDisabled !== user.passwordLoginDisabled) {
    if (parsed.data.passwordLoginDisabled) {
      const refusal = await passkeyOnlyRefusal(user.id);
      if (refusal) {
        res.status(409).json({
          error: refusal === 'LAST_ORG_ADMIN'
            ? 'The last Organization Management account needs at least two passkeys to sign in with passkeys only'
            : 'Passkey-only needs two passkeys, or one synced passkey plus backup codes',
          code: refusal,
        });
        return;
      }
    }
    await prisma.user.update({ where: { id: user.id }, data: { passwordLoginDisabled: parsed.data.passwordLoginDisabled } });
    changes['passwordLoginDisabled'] = { before: user.passwordLoginDisabled === true, after: parsed.data.passwordLoginDisabled };
    await publishUserAuthChange(user.id, 'passkey-policy');
    void notifySecurityEvent({
      userId: user.id,
      subject: parsed.data.passwordLoginDisabled
        ? 'Security notice: your account now signs in with passkeys only'
        : 'Security notice: password sign-in was enabled again for your account',
      bodyText: parsed.data.passwordLoginDisabled
        ? `An administrator switched your account to passkey-only sign-in on ${new Date().toUTCString()}. Your password no longer works for the web sign-in, and no password reset by mail is possible; mail programs keep using app passwords.`
        : `An administrator allowed the password sign-in for your account again on ${new Date().toUTCString()}.`,
    });
  }
  const actor = req.apiUser!;
  audit({
    actorId: actor.userId, actorEmail: actor.email,
    action: 'mailbox.passkey-policy.update', targetType: 'mailbox', targetId: user.id, targetName: user.email,
    changes,
    ...auditContext(req),
  });
  const level = await readPasskeyLevel({ level: 'user', userId: user.id });
  const fresh = await prisma.user.findUnique({ where: { id: user.id }, select: { passwordLoginDisabled: true } });
  res.json({ policy: level, passwordLoginDisabled: fresh?.passwordLoginDisabled === true });
}));
