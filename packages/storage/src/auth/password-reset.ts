/**
 * Self-service password reset tokens (v6.0.0).
 *
 * - Tokens are stored as sha256(token); several may be active at the same time
 *   (a new request does NOT invalidate earlier links, so an attacker requesting
 *   resets for a victim cannot lock the victim out). Each link expires after
 *   RESET_TOKEN_TTL; the per-email rate limit bounds the number of live tokens.
 * - Redemption is single-use via a conditional update (usedAt IS NULL).
 * - A successful reset deletes the user's other reset tokens and revokes all
 *   sessions AND all app passwords (the account may be compromised).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createLogger, hashPassword } from '@coremail/core';
import { prisma } from '../prisma/index.js';
import { checkPasswordPolicy } from './policy.js';
import { revokeAllSessions } from './sessions.js';

const log = createLogger('auth:password-reset');

export const RESET_TOKEN_TTL = 15 * 60;

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

export async function isResetTokenValid(token: string): Promise<boolean> {
  const t = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashResetToken(token) },
    select: { usedAt: true, expiresAt: true },
  });
  return !!t && t.usedAt === null && t.expiresAt.getTime() > Date.now();
}

export type ResetResult =
  | { ok: true; userId: string }
  | { ok: false; reason: 'invalid' | 'inactive' | 'policy'; message?: string };

export async function redeemPasswordReset(token: string, newPassword: string, ip: string): Promise<ResetResult> {
  const tokenHash = hashResetToken(token);
  const row = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    include: { user: { select: { id: true, active: true } } },
  });
  if (!row || row.usedAt !== null || row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'invalid' };
  if (!row.user.active) return { ok: false, reason: 'inactive' };

  const policy = await checkPasswordPolicy(newPassword);
  if (policy) return { ok: false, reason: 'policy', message: policy };

  // Claim the token atomically — exactly one concurrent request wins.
  const claimed = await prisma.passwordResetToken.updateMany({
    where: { id: row.id, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  if (claimed.count !== 1) return { ok: false, reason: 'invalid' };

  const passwordHash = await hashPassword(newPassword);
  await prisma.user.update({ where: { id: row.user.id }, data: { passwordHash } });
  await prisma.passwordResetToken.deleteMany({ where: { userId: row.user.id, NOT: { id: row.id } } });
  await revokeAllSessions(row.user.id, { appPasswords: true, reason: 'password-reset-by-mail' });
  log.info({ userId: row.user.id, ip }, 'Password reset successful');
  return { ok: true, userId: row.user.id };
}
