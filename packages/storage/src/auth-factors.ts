/**
 * 10.6: the enrolled authentication factors of an account — the ONE rule every
 * "does this account have MFA?" decision uses (web login MFA challenge, admin
 * MFA rule, "MFA für alle Benutzer erzwingen", mail protocols → app passwords,
 * client-config / Apple profile, /auth/mfa/status).
 *
 * Pure (no database access): callers select AUTH_FACTOR_SELECT on the user
 * (or pass rows of the same shape) and call authFactorsOf(). The database
 * reader is getAuthFactors() in src/auth/factors.ts; the mail-protocol check
 * (mail-auth-core.ts, injected Prisma) selects the same relation itself.
 *
 * A factor is: TOTP enabled, or any WebAuthn credential — a passkey (kind
 * "passkey") or a second-factor security key (kind "security_key", also the
 * credentials migrated from the deprecated UserMfa.webAuthnCredentials JSON).
 * Backup codes alone are no factor (they only stand in for one).
 *
 * 10.6 review: pre-10.6 security keys whose copy from the deprecated JSON has
 * not run yet (legacy-security-keys.ts) count as security keys too — fail
 * closed until the backfill copied them (or an admin reset the account's MFA).
 */
import { LEGACY_SECURITY_KEY_SELECT, pendingLegacySecurityKeyIds, type LegacySecurityKeyRow } from './legacy-security-keys.js';

/** Prisma `select` on User that authFactorsOf() needs. */
export const AUTH_FACTOR_SELECT = {
  mfa: { select: { totpEnabled: true, backupCodes: true, ...LEGACY_SECURITY_KEY_SELECT } },
  webauthnCredentials: { select: { kind: true, backupState: true, credentialId: true } },
} as const;

/** The selected shape (also accepted from hand-written fakes). */
export interface AuthFactorRow {
  mfa?: ({ totpEnabled?: boolean | null; backupCodes?: readonly unknown[] | null } & LegacySecurityKeyRow) | null;
  webauthnCredentials?: ReadonlyArray<{ kind?: string | null; backupState?: boolean | null; credentialId?: string | null }> | null;
}

export interface AuthFactors {
  totp: boolean;
  /** Remaining backup codes. */
  backupCodes: number;
  /** Credentials of kind "passkey". */
  passkeys: number;
  /** Passkeys whose backup state (BS) says they are synced. */
  syncedPasskeys: number;
  /** Second-factor-only security keys (incl. migrated legacy keys and legacySecurityKeys). */
  securityKeys: number;
  /** 10.6 review: pre-10.6 keys still only in the deprecated JSON (not copied yet) — counted, fail closed. */
  legacySecurityKeys: number;
  /** All WebAuthn credentials. */
  webauthn: number;
  /** At least one second factor (TOTP or any WebAuthn credential). */
  enrolled: boolean;
}

export const NO_AUTH_FACTORS: AuthFactors = Object.freeze({
  totp: false, backupCodes: 0, passkeys: 0, syncedPasskeys: 0, securityKeys: 0, legacySecurityKeys: 0, webauthn: 0, enrolled: false,
});

/** Counts the factors of a selected user row (pure). */
export function authFactorsOf(row: AuthFactorRow | null | undefined): AuthFactors {
  if (!row) return NO_AUTH_FACTORS;
  const creds = Array.isArray(row.webauthnCredentials) ? row.webauthnCredentials : [];
  let passkeys = 0;
  let syncedPasskeys = 0;
  for (const c of creds) {
    if (c?.kind === 'passkey') {
      passkeys++;
      if (c.backupState === true) syncedPasskeys++;
    }
  }
  // entries already copied (same credential id) are not counted twice
  const copied = new Set(creds.map((c) => c?.credentialId).filter((id): id is string => typeof id === 'string'));
  const legacy = pendingLegacySecurityKeyIds(row.mfa).filter((id) => !copied.has(id)).length;
  const totp = row.mfa?.totpEnabled === true;
  const backupCodes = Array.isArray(row.mfa?.backupCodes) ? row.mfa!.backupCodes!.length : 0;
  return {
    totp,
    backupCodes,
    passkeys,
    syncedPasskeys,
    securityKeys: creds.length - passkeys + legacy,
    legacySecurityKeys: legacy,
    webauthn: creds.length + legacy,
    enrolled: totp || creds.length > 0 || legacy > 0,
  };
}
