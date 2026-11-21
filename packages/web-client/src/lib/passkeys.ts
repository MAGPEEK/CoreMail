/**
 * 10.6: pure helpers of the passkey UI (login page, Settings → Sicherheit,
 * recovery page) — no imports, unit-tested with node (passkeys.test.ts).
 */

/** A passkey / security key as GET /auth/passkeys returns it. */
export interface PasskeyInfo {
  id: string;
  name: string;
  kind: 'passkey' | 'security_key';
  legacy: boolean;
  backupEligible: boolean | null;
  synced: boolean;
  provider: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface PasskeyList {
  passkeys: PasskeyInfo[];
  allowed: boolean;
  passwordless: boolean;
  passwordLoginDisabled: boolean;
  eligible: boolean;
  rpId: string;
  ready: boolean;
}

/** What the list shows about where the passkey lives (BE / BS flags). */
export type PasskeyStorage = 'synced' | 'device' | 'unknown';

export function passkeyStorage(p: Pick<PasskeyInfo, 'backupEligible' | 'synced'>): PasskeyStorage {
  if (p.synced) return 'synced';
  if (p.backupEligible === false) return 'device';
  if (p.backupEligible === true) return 'synced'; // may be synced, backup pending
  return 'unknown';
}

/** Sign-in / registration error codes of the server → translation keys. */
const CODE_KEYS: Record<string, string> = {
  PASSKEY_UNKNOWN: 'pk_err_unknown',
  PASSKEY_NOT_ELIGIBLE: 'pk_err_not_eligible',
  PASSKEYS_DISABLED: 'pk_err_disabled',
  PASSKEY_CHALLENGE_EXPIRED: 'pk_err_expired',
  PASSKEY_INVALID: 'pk_err_invalid',
  PASSKEY_COUNTER: 'pk_err_invalid',
  PASSKEY_DUPLICATE: 'pk_err_duplicate',
  PASSKEY_RECOVERY_INVALID: 'pk_err_recovery_invalid',
  IP_LOCKED: 'pk_err_locked',
  IP_BLOCKED: 'pk_err_blocked',
  RATE_LIMITED: 'pk_err_locked',
  PROTOCOL_DISABLED: 'pk_err_webmail_off',
  LAST_PASSKEY: 'pk_err_last_passkey',
  PASSWORD_LOGIN_DISABLED: 'pk_err_password_disabled',
  maintenance: 'pk_err_maintenance',
};

export function passkeyErrorKey(code: string | undefined): string {
  return (code && CODE_KEYS[code]) || 'pk_err_failed';
}

/** Browser failure (lib/webauthn.ts webauthnFailure) → translation key. */
export function passkeyBrowserErrorKey(failure: string): string {
  switch (failure) {
    case 'cancelled': return 'pk_browser_cancelled';
    case 'exists': return 'pk_browser_exists';
    case 'not_allowed_here': return 'pk_browser_not_allowed';
    case 'unsupported': return 'pk_browser_unsupported';
    default: return 'pk_err_failed';
  }
}

/** Server challenge TTL (300 s) — conditional options are renewed this long before they expire. */
export const PASSKEY_CHALLENGE_TTL_MS = 300_000;
export const PASSKEY_RENEW_MARGIN_MS = 30_000;
export function conditionalRenewDelayMs(ttlMs = PASSKEY_CHALLENGE_TTL_MS): number {
  return Math.max(10_000, ttlMs - PASSKEY_RENEW_MARGIN_MS);
}

/** The recovery token from the link's fragment (`/passkey-recovery#<token>`), or null. */
export function recoveryTokenFromHash(hash: string): string | null {
  const t = hash.replace(/^#/, '').trim();
  return /^[A-Za-z0-9_-]{20,128}$/.test(t) ? t : null;
}

/** Hint below the list: add a second passkey (one passkey only, no other factor to fall back on). */
export function needsSecondPasskeyHint(list: Pick<PasskeyInfo, 'kind'>[]): boolean {
  return list.filter((p) => p.kind === 'passkey').length === 1;
}
