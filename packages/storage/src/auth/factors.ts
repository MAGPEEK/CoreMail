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
import { LEGACY_SECURITY_KEY_SELECT } from '../legacy-security-keys.js';

export type { AuthFactors } from '../auth-factors.js';

// 10.6 review: pre-10.6 keys not copied yet count as a factor (fail closed, legacy-security-keys.ts)
const MFA_SELECT = { totpEnabled: true, backupCodes: true, ...LEGACY_SECURITY_KEY_SELECT } as const;

/** The factors of a user (unknown user → none). Throws on database errors. */
export async function getAuthFactors(userId: string): Promise<AuthFactors> {
  const [mfa, webauthnCredentials] = await Promise.all([
    prisma.userMfa.findUnique({ where: { userId }, select: MFA_SELECT }),
    prisma.webAuthnCredential.findMany({ where: { userId }, select: { kind: true, backupState: true, credentialId: true } }),
  ]);
  return authFactorsOf({ mfa, webauthnCredentials });
}

/** The factors of many users in two queries (admin lists: "enrolled?" per account). Unknown ids → none. */
export async function getAuthFactorsMany(userIds: readonly string[]): Promise<Map<string, AuthFactors>> {
  const ids = [...new Set(userIds)];
  const out = new Map<string, AuthFactors>();
  if (ids.length === 0) return out;
  const [mfa, creds] = await Promise.all([
    prisma.userMfa.findMany({ where: { userId: { in: ids } }, select: { userId: true, ...MFA_SELECT } }),
    prisma.webAuthnCredential.findMany({ where: { userId: { in: ids } }, select: { userId: true, kind: true, backupState: true, credentialId: true } }),
  ]);
  const mfaBy = new Map(mfa.map((m) => [m.userId, m]));
  const credsBy = new Map<string, Array<{ kind: string; backupState: boolean; credentialId: string }>>();
  for (const c of creds) {
    const list = credsBy.get(c.userId) ?? [];
    list.push(c);
    credsBy.set(c.userId, list);
  }
  for (const id of ids) out.set(id, authFactorsOf({ mfa: mfaBy.get(id) ?? null, webauthnCredentials: credsBy.get(id) ?? [] }));
  return out;
}
