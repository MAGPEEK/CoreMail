/**
 * 10.6 review: pre-10.6 security keys that are not in WebAuthnCredential yet
 * still count as a second factor (fail closed).
 *
 * Before 10.6 the security keys of an account lived in the JSON column
 * UserMfa.webAuthnCredentials (deprecated). The api-gateway copies them into
 * WebAuthnCredential at start (auth/webauthn/migration.ts, Redis lock, retried
 * with backoff). Until that copy ran for an account — or for an entry that
 * cannot be copied (unreadable, or the same credential id at several users) —
 * the account must not look like an account WITHOUT MFA: the mail protocols
 * would accept its primary password again, the web login would skip the second
 * factor and MFA enforcement would start a grace period. So every factor
 * decision (auth-factors.ts authFactorsOf) adds the entries reported here.
 *
 * Pure (no database access). Together with the migration this is the only code
 * that names the deprecated column (repo-hygiene guard).
 */

/** Prisma `select` fragment on UserMfa that pendingLegacySecurityKeyIds() needs. */
export const LEGACY_SECURITY_KEY_SELECT = { webAuthnMigratedAt: true, webAuthnCredentials: true } as const;

/** The selected shape (hand-written fakes may omit fields). */
export interface LegacySecurityKeyRow {
  webAuthnMigratedAt?: Date | string | null;
  webAuthnCredentials?: unknown;
}

/**
 * Ids of the legacy entries of an account whose copy has not run
 * (`webAuthnMigratedAt` null / absent and a non-empty JSON list). An entry
 * without a readable id is reported as `legacy#<index>`. Empty once migrated.
 */
export function pendingLegacySecurityKeyIds(mfa: LegacySecurityKeyRow | null | undefined): string[] {
  if (!mfa || mfa.webAuthnMigratedAt) return [];
  const list = mfa.webAuthnCredentials;
  if (!Array.isArray(list) || list.length === 0) return [];
  return list.map((c, i) => {
    const id = (c as { id?: unknown } | null)?.id;
    return typeof id === 'string' && id ? id : `legacy#${i}`;
  });
}
