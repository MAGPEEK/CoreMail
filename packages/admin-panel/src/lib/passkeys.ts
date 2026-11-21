/**
 * 10.6: pure helpers of the BCP passkey UI (login page, Authentifizierung →
 * Passkeys, mailbox dialog) — no imports, unit-tested with node.
 */

const CODE_KEYS: Record<string, string> = {
  PASSKEY_UNKNOWN: 'pk_err_unknown',
  PASSKEY_NOT_ELIGIBLE: 'pk_err_not_eligible',
  PASSKEYS_DISABLED: 'pk_err_disabled',
  PASSKEY_CHALLENGE_EXPIRED: 'pk_err_expired',
  PASSKEY_INVALID: 'pk_err_invalid',
  PASSKEY_COUNTER: 'pk_err_invalid',
  IP_LOCKED: 'pk_err_locked',
  IP_BLOCKED: 'pk_err_blocked',
  RATE_LIMITED: 'pk_err_locked',
  maintenance: 'pk_err_maintenance',
  NEEDS_PASSKEYS: 'pk_err_needs_passkeys',
  LAST_ORG_ADMIN: 'pk_err_last_org_admin',
  LAST_PASSKEY: 'pk_err_last_passkey',
  MFA_NOT_VERIFIED: 'pk_err_mfa_not_verified',
  FORBIDDEN_ROLE: 'pk_err_forbidden_role',
};

export function passkeyErrorKey(code: string | undefined): string {
  return (code && CODE_KEYS[code]) || 'pk_err_failed';
}

export function passkeyBrowserErrorKey(failure: string): string {
  switch (failure) {
    case 'cancelled': return 'pk_browser_cancelled';
    case 'not_allowed_here': return 'pk_browser_not_allowed';
    default: return 'pk_err_failed';
  }
}

/** Conditional options are renewed 30 s before the server's 300 s challenge expires. */
export function conditionalRenewDelayMs(ttlMs = 300_000): number {
  return Math.max(10_000, ttlMs - 30_000);
}

/** One origin per line → valid https origins (no path) + the rejected lines. */
export function parseOriginList(text: string): { origins: string[]; invalid: string[] } {
  const origins: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\n,]/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const u = new URL(line);
      if (u.protocol !== 'https:' || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash || u.username || u.password) {
        invalid.push(line);
      } else if (!origins.includes(u.origin)) {
        origins.push(u.origin);
      }
    } catch {
      invalid.push(line);
    }
  }
  return { origins, invalid };
}

export type ReadinessProblem = 'not_https' | 'ip_address' | 'rp_id_mismatch';

export function readinessProblemKey(p: ReadinessProblem): string {
  return p === 'not_https' ? 'pkp_problem_https' : p === 'ip_address' ? 'pkp_problem_ip' : 'pkp_problem_rp';
}

/** Where a passkey lives (BE / BS) → label key. */
export function passkeyStorageKey(p: { kind: string; legacy: boolean; backupEligible: boolean | null; synced: boolean }): string {
  if (p.kind !== 'passkey') return p.legacy ? 'pk_legacy' : 'pk_security_key';
  if (p.synced || p.backupEligible === true) return 'pk_synced';
  if (p.backupEligible === false) return 'pk_device';
  return 'pk_storage_unknown';
}
