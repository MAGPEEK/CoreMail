/**
 * SMTP Credential Verifier
 *
 * Checks regular user passwords and app passwords.
 * Returns an AuthUser on success, null on failure.
 *
 * Brute-force protection (OWASP A07 / MITRE T1110):
 * - After SMTP_AUTH_FAIL_THRESHOLD failed attempts per IP, the IP is
 *   banned via Redis for SMTP_AUTH_BAN_S seconds.
 * - Successful auth clears the failure counter.
 */

import { verifyPassword, createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage';
import type { AuthUser } from '../core/types.js';
import { recordAuthFailure, clearAuthFailures } from '../core/ip-limiter.js';

const log = createLogger('smtp:auth');

export async function verifySmtpCredentials(
  username: string,
  password: string,
  /** Client IP — for brute-force tracking; optional for backwards compatibility */
  clientIp?: string,
): Promise<AuthUser | null> {
  if (!username || !password) return null;

  const email = username.toLowerCase().trim();

  try {
    const user = await prisma.user.findFirst({
      where: { email, active: true },
      select: { id: true, email: true, passwordHash: true },
    });

    if (!user) {
      log.warn({ username }, 'Auth failed: user not found');
      if (clientIp) await recordAuthFailure(clientIp);
      return null;
    }

    // 1. Regular password (bcrypt + pepper)
    if (user.passwordHash) {
      const ok = await verifyPassword(password, user.passwordHash);
      if (ok) {
        log.info({ email: user.email }, 'Auth success (regular password)');
        if (clientIp) await clearAuthFailures(clientIp);
        return { id: user.id, email: user.email };
      }
    }

    // 2. App passwords
    const appPasswords = await prisma.appPassword.findMany({
      where: { userId: user.id },
      select: { id: true, hash: true },
    });

    for (const ap of appPasswords) {
      const ok = await verifyPassword(password, ap.hash);
      if (ok) {
        await prisma.appPassword.update({
          where: { id: ap.id },
          data: { lastUsedAt: new Date() },
        }).catch((err) => {
          log.warn({ apId: ap.id, err }, 'Failed to update app password lastUsedAt');
        });
        log.info({ email: user.email }, 'Auth success (app password)');
        if (clientIp) await clearAuthFailures(clientIp);
        return { id: user.id, email: user.email };
      }
    }

    log.warn({ email }, 'Auth failed: wrong password');
    if (clientIp) await recordAuthFailure(clientIp);
    return null;
  } catch (err) {
    log.error({ err, username }, 'verifySmtpCredentials error');
    return null;
  }
}
