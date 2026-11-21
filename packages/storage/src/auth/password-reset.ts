/**
 * Self-service password reset tokens (v7.0.0; 10.6 second proof + policy —
 * docs/password-reset.md).
 *
 * - Tokens are stored as sha256(token); several may be active at the same time
 *   (a new request does NOT invalidate earlier links, so an attacker requesting
 *   resets for a victim cannot lock the victim out). Each link expires after
 *   RESET_TOKEN_TTL; the per-email rate limit bounds the number of live tokens.
 * - Redemption is single-use via a conditional update (usedAt IS NULL).
 * - 10.6: an account with any second factor must also prove one (TOTP or a
 *   backup code) — a wrong or missing code never consumes the token; after
 *   RESET_MFA_MAX_FAILURES wrong codes the token is burnt. The reset never
 *   removes a factor. The SSPR policy is checked again at redemption
 *   (switched off / admin excluded / directory account → the link is dead).
 * - A successful reset deletes the user's other reset tokens and revokes all
 *   sessions AND all app passwords (the account may be compromised).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createLogger, hashPassword } from '@coremail/core';
import { prisma } from '../prisma/index.js';
import { checkPasswordPolicy } from './policy.js';
import { revokeAllSessions } from './sessions.js';
import { verifyUserTotp } from './totp.js';
import { consumeBackupCode, isBackupCodeFormat } from './backup-codes.js';
import { isMfaIpBlocked, registerMfaIpFailure } from './mfa-challenge.js';
import { authRedis, incrWithTtl } from './redis.js';
import { loadResetFactors, loadSsprPolicy, ssprAvailable, ssprRoleAllowed } from './sspr.js';

const log = createLogger('auth:password-reset');

export const RESET_TOKEN_TTL = 15 * 60;
/** Wrong second-factor codes per reset link before the link is burnt. */
export const RESET_MFA_MAX_FAILURES = 5;
const MFA_FAIL_PREFIX = 'auth:pwreset:mfa-fail:';

export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Creates a new reset token (keeps earlier unexpired ones). Returns the raw token. */
export async function createPasswordResetToken(userId: string, ip: string): Promise<string> {
  await prisma.passwordResetToken.deleteMany({
    where: { userId, OR: [{ expiresAt: { lt: new Date() } }, { NOT: { usedAt: null } }] },
  });
  const raw = randomBytes(32).toString('hex');
  await prisma.passwordResetToken.create({
    data: { userId, tokenHash: hashResetToken(raw), expiresAt: new Date(Date.now() + RESET_TOKEN_TTL * 1000), ipAddress: ip },
  });
  return raw;
}

export type ResetMfaMethod = 'totp' | 'backup_code';

export interface ResetTokenInfo {
  valid: boolean;
  /** 10.6: the reset page must ask for a second factor. */
  mfaRequired: boolean;
  /** Second-factor kinds the page may offer (empty when none is required). */
  methods: ResetMfaMethod[];
}

const INVALID: ResetTokenInfo = { valid: false, mfaRequired: false, methods: [] };

interface TokenUser { id: string; active: boolean; role: string; authSource: string; passwordLoginDisabled: boolean }

/** A live token row with its user, or null (unknown, used, expired, or the policy forbids it now). */
async function liveToken(token: string): Promise<{ id: string; user: TokenUser } | null> {
  const row = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashResetToken(token) },
    include: { user: { select: { id: true, active: true, role: true, authSource: true, passwordLoginDisabled: true } } },
  });
  if (!row || row.usedAt !== null || row.expiresAt.getTime() <= Date.now() || !row.user) return null;
  return { id: row.id, user: row.user as TokenUser };
}

/** 10.6: the reset policy still allows this account (checked again at every redemption). */
async function policyAllows(user: TokenUser): Promise<boolean> {
  const policy = await loadSsprPolicy();
  if (!ssprAvailable(policy)) return false;
  if (user.authSource !== 'LOCAL') return false;
  // 10.6 passkeys: a passkey-only account gets no password reset by mail (admin recovery link instead)
  if (user.passwordLoginDisabled === true) return false;
  return ssprRoleAllowed(user.role, policy);
}

export async function isResetTokenValid(token: string): Promise<boolean> {
  return (await inspectResetToken(token)).valid;
}

/** 10.6: token validity plus whether (and which) second factor the reset page must ask for. */
export async function inspectResetToken(token: string): Promise<ResetTokenInfo> {
  const t = await liveToken(token);
  if (!t || !t.user.active || !(await policyAllows(t.user))) return INVALID;
  const f = await loadResetFactors(t.user.id);
  const methods: ResetMfaMethod[] = [...(f.totp ? ['totp' as const] : []), ...(f.backupCodes ? ['backup_code' as const] : [])];
  return { valid: true, mfaRequired: f.any, methods: f.any ? methods : [] };
}

export type ResetResult =
  | { ok: true; userId: string }
  | { ok: false; reason: 'invalid' | 'inactive' | 'policy'; message?: string }
  // 10.6: second proof
  // (mfa_locked = the link is burnt; mfa_rate_limited = too many MFA failures from this IP, link kept)
  | { ok: false; reason: 'mfa_required' | 'mfa_invalid' | 'mfa_locked' | 'mfa_rate_limited'; userId: string };

export interface RedeemOptions {
  /** TOTP code (6 digits) or backup code (XXXX-XXXX) — required when the account has a second factor. */
  mfaCode?: string | undefined;
}

/** Verifies the second proof without consuming anything on failure (TOTP step / backup code on success only). */
async function verifySecondFactor(userId: string, code: string): Promise<boolean> {
  if (/^\d{6}$/.test(code)) return verifyUserTotp(userId, code);
  if (isBackupCodeFormat(code)) return consumeBackupCode(userId, code);
  return false;
}

export async function redeemPasswordReset(token: string, newPassword: string, ip: string, opts: RedeemOptions = {}): Promise<ResetResult> {
  const tokenHash = hashResetToken(token);
  const row = await liveToken(token);
  if (!row) return { ok: false, reason: 'invalid' };
  if (!row.user.active) return { ok: false, reason: 'inactive' };
  if (!(await policyAllows(row.user))) return { ok: false, reason: 'invalid' };

  const policy = await checkPasswordPolicy(newPassword);
  if (policy) return { ok: false, reason: 'policy', message: policy };

  // 10.6: second proof for accounts with any factor. Checked before the token is
  // claimed: a missing / wrong code leaves the link usable (bounded per link).
  const factors = await loadResetFactors(row.user.id);
  if (factors.any) {
    const code = (opts.mfaCode ?? '').trim();
    if (!code) return { ok: false, reason: 'mfa_required', userId: row.user.id };
    if (await isMfaIpBlocked(ip)) return { ok: false, reason: 'mfa_rate_limited', userId: row.user.id };
    if (!factors.provable || !(await verifySecondFactor(row.user.id, code))) {
      await registerMfaIpFailure(ip);
      const n = await incrWithTtl(`${MFA_FAIL_PREFIX}${tokenHash}`, RESET_TOKEN_TTL);
      if (n >= RESET_MFA_MAX_FAILURES) {
        await prisma.passwordResetToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
        log.warn({ userId: row.user.id, ip }, 'Password reset link burnt after too many wrong second-factor codes');
        return { ok: false, reason: 'mfa_locked', userId: row.user.id };
      }
      return { ok: false, reason: 'mfa_invalid', userId: row.user.id };
    }
  }

  // Claim the token atomically — exactly one concurrent request wins.
  const claimed = await prisma.passwordResetToken.updateMany({
    where: { id: row.id, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  if (claimed.count !== 1) return { ok: false, reason: 'invalid' };

  const passwordHash = await hashPassword(newPassword);
  await prisma.user.update({ where: { id: row.user.id }, data: { passwordHash } });
  await prisma.passwordResetToken.deleteMany({ where: { userId: row.user.id, NOT: { id: row.id } } });
  await authRedis().del(`${MFA_FAIL_PREFIX}${tokenHash}`).catch(() => 0);
  await revokeAllSessions(row.user.id, { appPasswords: true, reason: 'password-reset-by-mail' });
  log.info({ userId: row.user.id, ip }, 'Password reset successful');
  return { ok: true, userId: row.user.id };
}
