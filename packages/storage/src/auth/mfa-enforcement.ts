/**
 * 10.5: "MFA für alle Benutzer erzwingen" (ServerSettings.requireMfaForAllUsers).
 *
 * 10.6: the switches became a policy model (mfa-policy.ts: per-user override >
 * admin rule > policy for all users). This module enforces both kinds of
 * "required": `all` (the rules below, unchanged) and `admin` (admin accounts
 * under the admin rule or their own override: admin grace period of at most
 * 14 days, then the admin API needs MFA — adminMfaEnforcementFor(); the webmail
 * is not blocked by it). Per-user overrides have no stale check (the override
 * route clears User.mfaGraceStartedAt, so a new override starts a new grace).
 *
 * When the policy is "required", an account without a second factor (TOTP or a
 * security key) gets a grace period of `mfaEnforcementGraceDays` days, counted
 * per user from the first check after the switch was turned on
 * (User.mfaGraceStartedAt; a value from before ServerSettings.mfaEnforcementSince
 * is stale, so switching off and on again starts a new grace period). During the
 * grace period the webmail shows a banner; afterwards a web/API session of the
 * account may only be used to enrol (api-gateway requireAuth, auth-service
 * bearer: 403 MFA_ENROLMENT_REQUIRED for everything else).
 *
 * The requirement is satisfied by
 *   - an enrolled second factor (TOTP, a passkey or a security key — getAuthFactors), or
 *   - a session that was established with MFA (`mfaVerified`) — this includes
 *     SSO sessions whose IdP MFA (`amr`) CoreMail trusts (auth-sso oidc.ts:
 *     always for plain users unless the provider demands CoreMail MFA; for
 *     admin roles under the admin rule only with
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
 * `mfa-change`, an override change `mfa-policy-change`, a role change `role-change`).
 */
import { createLogger, onAuthInvalidation } from '@coremail/core';
import { prisma } from '../prisma/index.js';
import {
  invalidateMfaPolicyCache, loadMfaPolicySettings, resolveMfaPolicy, type ResolvedMfaPolicy,
} from './mfa-policy.js';
import { getAuthFactors } from './factors.js';

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

interface UserState {
  /** 10.6: read lazily (enrolledOf) — only when a rule applies to the account. */
  enrolled?: boolean;
  graceStartedAt: Date | null;
  /** The account can re-authenticate with a password (needed to enrol). */
  hasPassword: boolean;
  role: string;
  mfaPolicy: string | null;
}
const userCache = new Map<string, { state: UserState; expires: number }>();

onAuthInvalidation((e) => { userCache.delete(e.userId); });

/** Drops the cached policy and per-user states of this process (settings save, tests). */
export function invalidateMfaEnforcementCache(): void {
  invalidateMfaPolicyCache();
  userCache.clear();
}

/**
 * The policy for all users as a 10.5 enforcement policy (cached 15 s) — the
 * view of accounts that inherit the global policy. Throws on database errors.
 */
export async function loadMfaEnforcementPolicy(): Promise<MfaEnforcementPolicy> {
  const s = await loadMfaPolicySettings();
  if (s.users !== 'required') return MFA_ENFORCEMENT_OFF;
  return { enabled: true, graceDays: s.graceDays, since: s.since, blocksPrimaryPassword: s.blocksPrimaryPassword };
}

async function loadUserState(userId: string): Promise<UserState | null> {
  const now = Date.now();
  const hit = userCache.get(userId);
  if (hit && hit.expires > now) return hit.state;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { mfaGraceStartedAt: true, passwordHash: true, authSource: true, role: true, mfaPolicy: true },
  });
  if (!user) return null;
  const state: UserState = {
    graceStartedAt: user.mfaGraceStartedAt instanceof Date ? user.mfaGraceStartedAt : null,
    // OIDC-only accounts have no password to confirm an enrolment with (reauth.ts)
    hasPassword: Boolean(user.passwordHash) || String(user.authSource) === 'LDAP',
    role: typeof user.role === 'string' ? user.role : 'USER',
    mfaPolicy: typeof user.mfaPolicy === 'string' ? user.mfaPolicy : null,
  };
  if (userCache.size > 10_000) userCache.clear();
  userCache.set(userId, { state, expires: now + CACHE_TTL_MS });
  return state;
}

export interface MfaEnforcementResult {
  status: MfaEnforcementStatus;
  /** false for SSO-only accounts: they cannot confirm an enrolment with a password. */
  canEnrol: boolean;
  /** 10.6: the resolved policy of the account (absent for a missing account). */
  policy?: ResolvedMfaPolicy;
}

/** The grace decision of `resolved` for an account without MFA; starts (stores) the grace period. */
async function graceDecision(
  userId: string, user: UserState, resolved: ResolvedMfaPolicy, now: Date,
): Promise<MfaEnforcementStatus> {
  const policy: MfaEnforcementPolicy = {
    enabled: true, graceDays: resolved.graceDays, since: resolved.since, blocksPrimaryPassword: resolved.blocksPrimaryPassword,
  };
  const { start, persist } = effectiveGraceStart(policy, user.graceStartedAt, now);
  if (persist) {
    const where = policy.since
      ? { id: userId, OR: [{ mfaGraceStartedAt: null }, { mfaGraceStartedAt: { lt: policy.since } }] }
      : { id: userId, mfaGraceStartedAt: null };
    await prisma.user.updateMany({ where, data: { mfaGraceStartedAt: start } });
    user.graceStartedAt = start;
    log.info({ userId, graceDays: policy.graceDays, kind: resolved.enforcement }, 'MFA enforcement: grace period started');
  }
  return mfaEnforcementDecision(policy, { enrolled: false, mfaVerified: false, graceStart: start }, now);
}

/** 10.6: enrolled factor (central helper: TOTP, a passkey or a security key), read once per cached state. */
async function enrolledOf(userId: string, user: UserState): Promise<boolean> {
  if (user.enrolled === undefined) user.enrolled = (await getAuthFactors(userId)).enrolled;
  return user.enrolled;
}

async function resolvedFor(userId: string): Promise<{ user: UserState; resolved: ResolvedMfaPolicy } | null> {
  const [settings, user] = await Promise.all([loadMfaPolicySettings(), loadUserState(userId)]);
  if (!user) return null;
  return { user, resolved: resolveMfaPolicy(settings, { role: user.role, mfaPolicy: user.mfaPolicy }) };
}

/**
 * Enforcement status of a user under the `all` kind (10.5 rules). `mfaVerified`
 * = the session was established with a second factor (never true on mail
 * protocols). Accounts whose resolved policy is not "required", or that fall
 * under the admin rule instead, are `off` here. The first check of an account
 * without MFA starts its grace period (stored). Throws on database errors
 * (callers fail closed).
 */
export async function mfaEnforcementFor(
  userId: string,
  opts: { mfaVerified?: boolean | undefined; now?: Date } = {},
): Promise<MfaEnforcementResult> {
  const r = await resolvedFor(userId);
  // A missing account is refused by the session checks themselves.
  if (!r) return { status: { state: 'satisfied' }, canEnrol: false };
  const { user, resolved } = r;
  if (resolved.enforcement !== 'all') return { status: { state: 'off' }, canEnrol: user.hasPassword, policy: resolved };
  if (opts.mfaVerified === true || await enrolledOf(userId, user)) return { status: { state: 'satisfied' }, canEnrol: user.hasPassword, policy: resolved };
  return { status: await graceDecision(userId, user, resolved, opts.now ?? new Date()), canEnrol: user.hasPassword, policy: resolved };
}

/**
 * 10.6: status of the admin rule for an account (`admin` kind): `off` when it
 * does not apply, `satisfied` once a factor is enrolled (whether the SESSION is
 * MFA-verified is the caller's check), else `grace` until the admin grace
 * period (≤ 14 days, from the first check) ends, then `required`. Starts the
 * grace period. Throws on database errors.
 */
export async function adminMfaEnforcementFor(userId: string, opts: { now?: Date } = {}): Promise<MfaEnforcementResult> {
  const r = await resolvedFor(userId);
  if (!r) return { status: { state: 'off' }, canEnrol: false };
  const { user, resolved } = r;
  if (resolved.enforcement !== 'admin') return { status: { state: 'off' }, canEnrol: user.hasPassword, policy: resolved };
  if (await enrolledOf(userId, user)) return { status: { state: 'satisfied' }, canEnrol: user.hasPassword, policy: resolved };
  return { status: await graceDecision(userId, user, resolved, opts.now ?? new Date()), canEnrol: user.hasPassword, policy: resolved };
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
 * the user may no longer be used — `all` enforcement for the account, the
 * sub-option mfaEnforcementBlocksPrimaryPassword on and the grace period over.
 * Starts the grace period like a web check. Throws on database errors.
 */
export async function mailPrimaryPasswordBlocked(userId: string, now?: Date): Promise<boolean> {
  // the sub-option is global: without it (and without the global "required",
  // whose mail logins start grace periods as in 10.5) nothing to look up per user
  const s = await loadMfaPolicySettings();
  if (!s.blocksPrimaryPassword && s.users !== 'required') return false;
  const { status, policy } = await mfaEnforcementFor(userId, now ? { now } : {});
  return policy?.blocksPrimaryPassword === true && status.state === 'required';
}
