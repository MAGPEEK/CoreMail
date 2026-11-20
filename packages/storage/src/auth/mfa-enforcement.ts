/**
 * 10.5: "MFA für alle Benutzer erzwingen" (ServerSettings.requireMfaForAllUsers).
 *
 * When the switch is on, an account without a second factor (TOTP or a
 * security key) gets a grace period of `mfaEnforcementGraceDays` days, counted
 * per user from the first check after the switch was turned on
 * (User.mfaGraceStartedAt; a value from before ServerSettings.mfaEnforcementSince
 * is stale, so switching off and on again starts a new grace period). During the
 * grace period the webmail shows a banner; afterwards a web/API session of the
 * account may only be used to enrol (api-gateway requireAuth, auth-service
 * bearer: 403 MFA_ENROLMENT_REQUIRED for everything else).
 *
 * The requirement is satisfied by
 *   - an enrolled second factor (UserMfa: TOTP enabled or a WebAuthn credential), or
 *   - a session that was established with MFA (`mfaVerified`) — this includes
 *     SSO sessions whose IdP MFA (`amr`) CoreMail trusts (auth-sso oidc.ts:
 *     always for plain users unless the provider demands CoreMail MFA; for
 *     admin roles under requireMfaForAdmins only with
 *     OIDC_TRUST_IDP_MFA_FOR_ADMINS=true).
 *
 * Mail protocols: accounts with MFA need app passwords anyway (mail-auth-core).
 * Accounts without MFA keep their primary password on mail protocols, unless
 * the sub-option `mfaEnforcementBlocksPrimaryPassword` is on: then, after the
 * grace period, the primary password is refused (`mfa_app_password_required`);
 * app passwords keep working (verifyMailCredentials in mail-auth.ts).
 *
 * Caches: the policy 15 s per process (the settings route of this process calls
 * invalidateMfaEnforcementCache()), the per-user state 15 s, dropped on every
 * auth invalidation event of the user (enrolling / removing a factor publishes
 * `mfa-change`).
 */
import { createLogger, onAuthInvalidation } from '@coremail/core';
import { prisma } from '../prisma/index.js';

const log = createLogger('auth:mfa-enforcement');

/** Error code of every web/API refusal while the account must enrol a second factor. */
export const MFA_ENROLMENT_REQUIRED_CODE = 'MFA_ENROLMENT_REQUIRED';

/** Bounds of the grace period setting (days; 0 = enforced at once). */
export const MFA_GRACE_DAYS_BOUNDS: readonly [number, number] = [0, 90];

const DAY_MS = 86_400_000;
const CACHE_TTL_MS = 15_000;

export interface MfaEnforcementPolicy {
  enabled: boolean;
  graceDays: number;
  /** When the enforcement was switched on (grace starts older than this are stale). */
  since: Date | null;
  blocksPrimaryPassword: boolean;
}

export const MFA_ENFORCEMENT_OFF: MfaEnforcementPolicy = Object.freeze({
  enabled: false, graceDays: 7, since: null, blocksPrimaryPassword: false,
});

export type MfaEnforcementStatus =
  | { state: 'off' }
  | { state: 'satisfied' }
  | { state: 'grace'; deadline: Date }
  | { state: 'required'; deadline: Date };

// ── Pure rules ────────────────────────────────────────────────────────────────

/** Grace start to use: the stored one while it belongs to the current activation, else `now` (to be stored). */
export function effectiveGraceStart(
  policy: Pick<MfaEnforcementPolicy, 'since'>, stored: Date | null, now: Date,
): { start: Date; persist: boolean } {
  if (stored && (!policy.since || stored.getTime() >= policy.since.getTime())) return { start: stored, persist: false };
  return { start: now, persist: true };
}

/** End of the grace period that started at `start`. */
export function graceDeadline(policy: Pick<MfaEnforcementPolicy, 'graceDays'>, start: Date): Date {
  const days = Math.min(Math.max(0, Math.floor(policy.graceDays)), MFA_GRACE_DAYS_BOUNDS[1]);
  return new Date(start.getTime() + days * DAY_MS);
}

/** The decision for one account (pure). */
export function mfaEnforcementDecision(
  policy: MfaEnforcementPolicy,
  input: { enrolled: boolean; mfaVerified: boolean; graceStart: Date | null },
  now: Date,
): MfaEnforcementStatus {
  if (!policy.enabled) return { state: 'off' };
  if (input.enrolled || input.mfaVerified) return { state: 'satisfied' };
  const deadline = graceDeadline(policy, input.graceStart ?? now);
  return now.getTime() >= deadline.getTime() ? { state: 'required', deadline } : { state: 'grace', deadline };
}

/** JSON body of the 403 answer for a session that must enrol first. */
export function mfaEnrolmentRequiredBody(deadline?: Date): Record<string, unknown> {
  return {
    error: 'Two-factor authentication must be set up before this account can be used',
    code: MFA_ENROLMENT_REQUIRED_CODE,
    ...(deadline ? { deadline: deadline.toISOString() } : {}),
  };
}

// ── Database + caches ─────────────────────────────────────────────────────────

let policyCache: { value: MfaEnforcementPolicy; expires: number } | null = null;

interface UserState {
  enrolled: boolean;
  graceStartedAt: Date | null;
  /** The account can re-authenticate with a password (needed to enrol). */
  hasPassword: boolean;
}
const userCache = new Map<string, { state: UserState; expires: number }>();

onAuthInvalidation((e) => { userCache.delete(e.userId); });

/** Drops the cached policy and per-user states of this process (settings save, tests). */
export function invalidateMfaEnforcementCache(): void {
  policyCache = null;
  userCache.clear();
}

/** The current policy (cached 15 s). Throws on database errors. */
export async function loadMfaEnforcementPolicy(): Promise<MfaEnforcementPolicy> {
  const now = Date.now();
  if (policyCache && policyCache.expires > now) return policyCache.value;
  const s = await prisma.serverSettings.findUnique({
    where: { id: 'singleton' },
    select: {
      requireMfaForAllUsers: true, mfaEnforcementGraceDays: true,
      mfaEnforcementSince: true, mfaEnforcementBlocksPrimaryPassword: true,
    },
  });
  const value: MfaEnforcementPolicy = s?.requireMfaForAllUsers === true
    ? {
        enabled: true,
        graceDays: typeof s.mfaEnforcementGraceDays === 'number' ? s.mfaEnforcementGraceDays : MFA_ENFORCEMENT_OFF.graceDays,
        since: s.mfaEnforcementSince instanceof Date ? s.mfaEnforcementSince : null,
        blocksPrimaryPassword: s.mfaEnforcementBlocksPrimaryPassword === true,
      }
    : MFA_ENFORCEMENT_OFF;
  policyCache = { value, expires: now + CACHE_TTL_MS };
  return value;
}

async function loadUserState(userId: string): Promise<UserState | null> {
  const now = Date.now();
  const hit = userCache.get(userId);
  if (hit && hit.expires > now) return hit.state;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { mfaGraceStartedAt: true, passwordHash: true, authSource: true },
  });
  if (!user) return null;
  const mfa = await prisma.userMfa.findUnique({
    where: { userId },
    select: { totpEnabled: true, webAuthnCredentials: true },
  });
  const webauthn = Array.isArray(mfa?.webAuthnCredentials) && (mfa.webAuthnCredentials as unknown[]).length > 0;
  const state: UserState = {
    enrolled: mfa?.totpEnabled === true || webauthn,
    graceStartedAt: user.mfaGraceStartedAt instanceof Date ? user.mfaGraceStartedAt : null,
    // OIDC-only accounts have no password to confirm an enrolment with (reauth.ts)
    hasPassword: Boolean(user.passwordHash) || String(user.authSource) === 'LDAP',
  };
  if (userCache.size > 10_000) userCache.clear();
  userCache.set(userId, { state, expires: now + CACHE_TTL_MS });
  return state;
}

export interface MfaEnforcementResult {
  status: MfaEnforcementStatus;
  /** false for SSO-only accounts: they cannot confirm an enrolment with a password. */
  canEnrol: boolean;
}

/**
 * Enforcement status of a user. `mfaVerified` = the session was established
 * with a second factor (never true on mail protocols). The first check of an
 * account without MFA after the switch was turned on starts its grace period
 * (stored). Throws on database errors (callers fail closed).
 */
export async function mfaEnforcementFor(
  userId: string,
  opts: { mfaVerified?: boolean | undefined; now?: Date } = {},
): Promise<MfaEnforcementResult> {
  const policy = await loadMfaEnforcementPolicy();
  if (!policy.enabled) return { status: { state: 'off' }, canEnrol: true };
  const now = opts.now ?? new Date();
  const user = await loadUserState(userId);
  // A missing account is refused by the session checks themselves.
  if (!user) return { status: { state: 'satisfied' }, canEnrol: false };
  if (user.enrolled || opts.mfaVerified === true) return { status: { state: 'satisfied' }, canEnrol: user.hasPassword };

  const { start, persist } = effectiveGraceStart(policy, user.graceStartedAt, now);
  if (persist) {
    const where = policy.since
      ? { id: userId, OR: [{ mfaGraceStartedAt: null }, { mfaGraceStartedAt: { lt: policy.since } }] }
      : { id: userId, mfaGraceStartedAt: null };
    await prisma.user.updateMany({ where, data: { mfaGraceStartedAt: start } });
    user.graceStartedAt = start;
    log.info({ userId, graceDays: policy.graceDays }, 'MFA enforcement: grace period started');
  }
  return {
    status: mfaEnforcementDecision(policy, { enrolled: false, mfaVerified: false, graceStart: start }, now),
    canEnrol: user.hasPassword,
  };
}

/**
 * The request check of a web/API session (api-gateway requireAuth for paths
 * outside the enrolment allow-list, auth-service routes other than /auth/mfa
 * and /auth/sessions): null when the session may be used, else the answer —
 * 403 MFA_ENROLMENT_REQUIRED, or 503 when the state cannot be read (fails
 * closed, like the protocol switch check).
 */
export async function mfaEnrolmentRefusal(
  userId: string, mfaVerified: boolean | undefined,
): Promise<{ status: 403 | 503; body: Record<string, unknown> } | null> {
  try {
    const { status } = await mfaEnforcementFor(userId, { mfaVerified });
    return status.state === 'required' ? { status: 403, body: mfaEnrolmentRequiredBody(status.deadline) } : null;
  } catch (err) {
    log.error({ err, userId }, 'MFA enforcement check failed');
    return { status: 503, body: { error: 'Authentication temporarily unavailable' } };
  }
}

/**
 * Mail protocols: true when the primary password (or a directory password) of
 * the user may no longer be used — enforcement on, the sub-option
 * mfaEnforcementBlocksPrimaryPassword on and the grace period over. Starts the
 * grace period like a web check. Throws on database errors.
 */
export async function mailPrimaryPasswordBlocked(userId: string, now?: Date): Promise<boolean> {
  const policy = await loadMfaEnforcementPolicy();
  if (!policy.enabled) return false;
  const { status } = await mfaEnforcementFor(userId, now ? { now } : {});
  return policy.blocksPrimaryPassword && status.state === 'required';
}
