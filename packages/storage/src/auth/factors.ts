/**
 * 10.6: getAuthFactors(userId) — the central database reader of the enrolled
 * factors (TOTP, backup codes, passkeys, security keys). Replaces every direct
 * reader of the deprecated UserMfa.webAuthnCredentials JSON: the login MFA
 * decision (getMfaState), the admin MFA rule, MFA enforcement, /auth/mfa/status,
 * client-config and the Apple profile. The rule itself is pure
 * (src/auth-factors.ts); the mail protocols use it through hasMfa().
 */
import { prisma } from '../prisma/index.js';
import { authFactorsOf, type AuthFactors } from '../auth-factors.js';

export type { AuthFactors } from '../auth-factors.js';

/** The factors of a user (unknown user → none). Throws on database errors. */
export async function getAuthFactors(userId: string): Promise<AuthFactors> {
  const [mfa, webauthnCredentials] = await Promise.all([
    prisma.userMfa.findUnique({ where: { userId }, select: { totpEnabled: true, backupCodes: true } }),
    prisma.webAuthnCredential.findMany({ where: { userId }, select: { kind: true, backupState: true } }),
  ]);
  return authFactorsOf({ mfa, webauthnCredentials });
}
