/**
 * 10.6: BCP self-registration page — types of the admin API
 * (/api/v1/admin/self-registration) and pure helpers (unit-tested).
 */

export type SelfRegistrationMode = 'approval' | 'immediate';
export type InviteStatus = 'active' | 'expired' | 'used' | 'revoked';

export interface SelfRegistrationView {
  enabled: boolean;
  domainIds: string[];
  mode: SelfRegistrationMode;
  inviteOnly: boolean;
  domains: Array<{ id: string; name: string; active: boolean }>;
}

export interface InviteView {
  id: string;
  label: string;
  codeHint: string;
  expiresAt: string | null;
  maxUses: number;
  uses: number;
  revokedAt: string | null;
  createdBy: string;
  createdAt: string;
  status: InviteStatus;
}

export interface PendingView {
  id: string;
  email: string;
  displayName: string;
  domain: string;
  createdAt: string;
  ipAddress: string;
  viaInvite: boolean;
}

/** Defaults and bounds of the invite form (same as the server). */
export const INVITE_DEFAULTS = Object.freeze({ days: 14, uses: 1, maxDays: 365, maxUses: 1000 });

/** null when the invite form values are valid, else the offending field. */
export function inviteFormError(days: number, uses: number): 'days' | 'uses' | null {
  if (!Number.isInteger(days) || days < 1 || days > INVITE_DEFAULTS.maxDays) return 'days';
  if (!Number.isInteger(uses) || uses < 1 || uses > INVITE_DEFAULTS.maxUses) return 'uses';
  return null;
}

/** Same set of ids, order ignored. */
export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}
