/**
 * 10.6: the MFA policy model (BCP → Authentifizierung → Mehrstufige Anmeldung).
 *
 * Three inputs, most specific wins:
 *   1. per-user override `User.mfaPolicy` (REQUIRED / OPTIONAL / OFF, null = inherit)
 *   2. admin rule `ServerSettings.mfaAdminPolicy` (REQUIRED / AS_USERS) — accounts
 *      with an admin role only
 *   3. policy for all users `ServerSettings.mfaUserPolicy` (REQUIRED / OPTIONAL / OFF)
 *
 * Levels:
 *   - required — the account must enrol a second factor (grace period first)
 *   - optional — the user decides (enrolment offered, nothing enforced)
 *   - off      — enrolment is not offered (the webmail hides it, the enrolment
 *                endpoints answer 403 MFA_NOT_OFFERED); factors enrolled earlier
 *                keep working: the login still asks for them, the user may remove them
 *
 * Which enforcement a "required" account gets:
 *   - `admin` — an admin account required by the admin rule or by its own
 *     override: the admin API needs an enrolled factor and an MFA-verified
 *     session (403 MFA_REQUIRED / MFA_NOT_VERIFIED, api-gateway adminGuard) after
 *     an admin grace period of at most 14 days (mfaAdminGraceDays); the webmail
 *     is not blocked (as with requireMfaForAdmins before 10.6), it shows a prompt.
 *   - `all` — every other required account (users; admins under "wie alle
 *     Benutzer"): the 10.5 enforcement (mfa-enforcement.ts) with the global
 *     grace period (0–90 days) and the mail-protocol sub-option.
 *
 * Backward compatibility: the new columns are null on existing installs; then
 * the legacy switches decide (requireMfaForAllUsers → required / optional,
 * requireMfaForAdmins → required / as_users). Every save writes both forms
 * (mfaPolicyWriteData), so readers of the legacy booleans keep working.
 */
import { prisma } from '../prisma/index.js';

export type MfaPolicyLevel = 'required' | 'optional' | 'off';
export type AdminMfaRule = 'required' | 'as_users';
export type MfaPolicySource = 'user' | 'admin' | 'global';
export type MfaEnforcementKind = 'admin' | 'all' | 'none';

export const MFA_POLICY_LEVELS: readonly MfaPolicyLevel[] = ['required', 'optional', 'off'];
export const ADMIN_MFA_RULES: readonly AdminMfaRule[] = ['required', 'as_users'];

/** Upper bound of the admin grace period (days) — also for per-user overrides of admins. */
export const MFA_ADMIN_GRACE_MAX_DAYS = 14;
/** Bounds of the "Gerät merken" durations (days; 0 = off). */
export const MFA_REMEMBER_DAYS_BOUNDS: readonly [number, number] = [0, 365];

export interface MfaPolicySettings {
  users: MfaPolicyLevel;
  admins: AdminMfaRule;
  /** Grace period of the `all` enforcement (0–90 days). */
  graceDays: number;
  since: Date | null;
  blocksPrimaryPassword: boolean;
  /** Grace period of the `admin` enforcement (0–14 days). */
  adminGraceDays: number;
  adminSince: Date | null;
  /** "Gerät merken" days for users / admins (0 = off). */
  rememberDays: number;
  rememberDaysAdmins: number;
}

export const MFA_POLICY_DEFAULTS: MfaPolicySettings = Object.freeze({
  users: 'optional', admins: 'as_users', graceDays: 7, since: null, blocksPrimaryPassword: false,
  adminGraceDays: MFA_ADMIN_GRACE_MAX_DAYS, adminSince: null, rememberDays: 30, rememberDaysAdmins: 0,
}) as MfaPolicySettings;

/** The ServerSettings columns the policy is read from (all optional: older rows / fakes). */
export interface MfaSettingsRow {
  requireMfaForAdmins?: boolean | null;
  requireMfaForAllUsers?: boolean | null;
  mfaEnforcementGraceDays?: number | null;
  mfaEnforcementSince?: Date | null;
  mfaEnforcementBlocksPrimaryPassword?: boolean | null;
  mfaUserPolicy?: string | null;
  mfaAdminPolicy?: string | null;
  mfaAdminGraceDays?: number | null;
  mfaAdminEnforcementSince?: Date | null;
  mfaRememberDays?: number | null;
  mfaRememberDaysAdmins?: number | null;
}

export const MFA_SETTINGS_SELECT = {
  requireMfaForAdmins: true, requireMfaForAllUsers: true, mfaEnforcementGraceDays: true, mfaEnforcementSince: true,
  mfaEnforcementBlocksPrimaryPassword: true, mfaUserPolicy: true, mfaAdminPolicy: true, mfaAdminGraceDays: true,
  mfaAdminEnforcementSince: true, mfaRememberDays: true, mfaRememberDaysAdmins: true,
} as const;

// ── Pure helpers ──────────────────────────────────────────────────────────────

/** Database enum value (REQUIRED / OPTIONAL / OFF) → level; anything else → null (= inherit). */
export function levelFromDb(v: unknown): MfaPolicyLevel | null {
  if (v === 'REQUIRED') return 'required';
  if (v === 'OPTIONAL') return 'optional';
  if (v === 'OFF') return 'off';
  return null;
}

export function levelToDb(l: MfaPolicyLevel): 'REQUIRED' | 'OPTIONAL' | 'OFF' {
  return l === 'required' ? 'REQUIRED' : l === 'off' ? 'OFF' : 'OPTIONAL';
}

/** Every role but USER is an admin role (UserRole enum). */
export function isAdminRoleName(role: string | null | undefined): boolean {
  return !!role && role !== 'USER';
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : fallback;
}

/** The policy of a ServerSettings row; null columns fall back to the legacy switches (no row = defaults). */
export function mfaPolicySettingsFromRow(row: MfaSettingsRow | null | undefined): MfaPolicySettings {
  if (!row) return { ...MFA_POLICY_DEFAULTS };
  const users = levelFromDb(row.mfaUserPolicy) ?? (row.requireMfaForAllUsers === true ? 'required' : 'optional');
  const admins: AdminMfaRule = row.mfaAdminPolicy === 'REQUIRED' ? 'required'
    : row.mfaAdminPolicy === 'AS_USERS' ? 'as_users'
      : row.requireMfaForAdmins === true ? 'required' : 'as_users';
  const rememberDays = clampInt(row.mfaRememberDays, 0, MFA_REMEMBER_DAYS_BOUNDS[1], MFA_POLICY_DEFAULTS.rememberDays);
  return {
    users,
    admins,
    graceDays: clampInt(row.mfaEnforcementGraceDays, 0, 90, MFA_POLICY_DEFAULTS.graceDays),
    since: row.mfaEnforcementSince instanceof Date ? row.mfaEnforcementSince : null,
    blocksPrimaryPassword: row.mfaEnforcementBlocksPrimaryPassword === true,
    adminGraceDays: clampInt(row.mfaAdminGraceDays, 0, MFA_ADMIN_GRACE_MAX_DAYS, MFA_POLICY_DEFAULTS.adminGraceDays),
    adminSince: row.mfaAdminEnforcementSince instanceof Date ? row.mfaAdminEnforcementSince : null,
    rememberDays,
    rememberDaysAdmins: Math.min(rememberDays, clampInt(row.mfaRememberDaysAdmins, 0, MFA_REMEMBER_DAYS_BOUNDS[1], 0)),
  };
}

export interface MfaPolicySubject {
  role: string;
  /** User.mfaPolicy (database enum value or level); null/undefined = inherit. */
  mfaPolicy?: string | null | undefined;
}

export interface ResolvedMfaPolicy {
  level: MfaPolicyLevel;
  source: MfaPolicySource;
  enforcement: MfaEnforcementKind;
  /** Grace period of the enforcement (days). */
  graceDays: number;
  /** Grace starts older than this are stale (null = every stored start counts). */
  since: Date | null;
  /** Mail protocols: primary password refused after the grace period (`all` only). */
  blocksPrimaryPassword: boolean;
  /** "Gerät merken" days for this account (0 = not offered). */
  rememberDays: number;
  /** Enrolment is offered (level ≠ off). */
  enrolmentOffered: boolean;
}

/** Override (accepts the database enum or a level). */
function overrideOf(v: string | null | undefined): MfaPolicyLevel | null {
  if (v === 'required' || v === 'optional' || v === 'off') return v;
  return levelFromDb(v);
}

/** Precedence: per-user override > admin rule (admin roles) > policy for all users. */
export function resolveMfaPolicy(s: MfaPolicySettings, user: MfaPolicySubject): ResolvedMfaPolicy {
  const admin = isAdminRoleName(user.role);
  const override = overrideOf(user.mfaPolicy);
  let level: MfaPolicyLevel;
  let source: MfaPolicySource;
  if (override) { level = override; source = 'user'; }
  else if (admin && s.admins === 'required') { level = 'required'; source = 'admin'; }
  else { level = s.users; source = 'global'; }

  const rememberDays = admin ? Math.min(s.rememberDaysAdmins, s.rememberDays) : s.rememberDays;
  const base = { level, source, rememberDays, enrolmentOffered: level !== 'off' };
  if (level === 'required' && admin && source !== 'global') {
    return {
      ...base, enforcement: 'admin',
      graceDays: Math.min(Math.max(0, s.adminGraceDays), MFA_ADMIN_GRACE_MAX_DAYS),
      since: source === 'admin' ? s.adminSince : null,
      blocksPrimaryPassword: false,
    };
  }
  if (level === 'required') {
    return {
      ...base, enforcement: 'all', graceDays: s.graceDays,
      since: source === 'global' ? s.since : null,
      blocksPrimaryPassword: s.blocksPrimaryPassword,
    };
  }
  return { ...base, enforcement: 'none', graceDays: 0, since: null, blocksPrimaryPassword: false };
}

const STRENGTH: Record<MfaPolicyLevel, number> = { off: 0, optional: 1, required: 2 };

/** true when `after` is a weaker level than `before`. */
export function weakensMfaPolicy(before: MfaPolicyLevel, after: MfaPolicyLevel): boolean {
  return STRENGTH[after] < STRENGTH[before];
}

/** Validation errors of a policy (null = valid). */
export function mfaPolicyProblem(s: Pick<MfaPolicySettings, 'adminGraceDays' | 'rememberDays' | 'rememberDaysAdmins'>): string | null {
  if (s.adminGraceDays < 0 || s.adminGraceDays > MFA_ADMIN_GRACE_MAX_DAYS) return `adminGraceDays must be 0–${MFA_ADMIN_GRACE_MAX_DAYS}`;
  if (s.rememberDaysAdmins > s.rememberDays) return 'rememberDaysAdmins must not exceed rememberDays';
  return null;
}

/**
 * Prisma data for a policy save: the new columns AND the legacy switches in
 * step (requireMfaForAllUsers = users required, requireMfaForAdmins = admin rule
 * required). `before` decides the activation times: switching the users policy
 * to required sets mfaEnforcementSince, switching the admin rule to required sets
 * mfaAdminEnforcementSince (new grace periods).
 */
export function mfaPolicyWriteData(
  before: MfaPolicySettings, next: Partial<MfaPolicySettings>, now: Date,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (next.users !== undefined) {
    data['mfaUserPolicy'] = levelToDb(next.users);
    data['requireMfaForAllUsers'] = next.users === 'required';
    if (next.users === 'required' && before.users !== 'required') data['mfaEnforcementSince'] = now;
  }
  if (next.admins !== undefined) {
    data['mfaAdminPolicy'] = next.admins === 'required' ? 'REQUIRED' : 'AS_USERS';
    data['requireMfaForAdmins'] = next.admins === 'required';
    if (next.admins === 'required' && before.admins !== 'required') data['mfaAdminEnforcementSince'] = now;
  }
  if (next.graceDays !== undefined) data['mfaEnforcementGraceDays'] = next.graceDays;
  if (next.blocksPrimaryPassword !== undefined) data['mfaEnforcementBlocksPrimaryPassword'] = next.blocksPrimaryPassword;
  if (next.adminGraceDays !== undefined) data['mfaAdminGraceDays'] = next.adminGraceDays;
  if (next.rememberDays !== undefined) data['mfaRememberDays'] = next.rememberDays;
  if (next.rememberDaysAdmins !== undefined) data['mfaRememberDaysAdmins'] = next.rememberDaysAdmins;
  return data;
}

/**
 * The legacy PUT /admin/settings/security switches mapped onto the new model:
 * requireMfaForAllUsers true → users required, false → optional (an "off"
 * policy stays off); requireMfaForAdmins true → required, false → as_users.
 */
export function legacySwitchesToPolicy(
  before: MfaPolicySettings, legacy: { requireMfaForAllUsers?: boolean | undefined; requireMfaForAdmins?: boolean | undefined },
): Partial<MfaPolicySettings> {
  const out: Partial<MfaPolicySettings> = {};
  if (legacy.requireMfaForAllUsers !== undefined) {
    out.users = legacy.requireMfaForAllUsers ? 'required' : before.users === 'off' ? 'off' : 'optional';
  }
  if (legacy.requireMfaForAdmins !== undefined) out.admins = legacy.requireMfaForAdmins ? 'required' : 'as_users';
  return out;
}

// ── Database ──────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 15_000;
let settingsCache: { value: MfaPolicySettings; expires: number } | null = null;

/** Drops the cached policy of this process (settings save, tests). */
export function invalidateMfaPolicyCache(): void {
  settingsCache = null;
}

/** The current policy (cached 15 s). Throws on database errors. */
export async function loadMfaPolicySettings(): Promise<MfaPolicySettings> {
  const now = Date.now();
  if (settingsCache && settingsCache.expires > now) return settingsCache.value;
  const row = await prisma.serverSettings.findUnique({ where: { id: 'singleton' }, select: MFA_SETTINGS_SELECT });
  const value = mfaPolicySettingsFromRow(row as MfaSettingsRow | null);
  settingsCache = { value, expires: now + CACHE_TTL_MS };
  return value;
}

/** Resolved policy of one account; null when the account does not exist. Throws on database errors. */
export async function loadUserMfaPolicy(userId: string): Promise<ResolvedMfaPolicy | null> {
  const [settings, user] = await Promise.all([
    loadMfaPolicySettings(),
    prisma.user.findUnique({ where: { id: userId }, select: { role: true, mfaPolicy: true } }),
  ]);
  if (!user) return null;
  return resolveMfaPolicy(settings, { role: String(user.role), mfaPolicy: user.mfaPolicy ?? null });
}

/** Error code of the enrolment endpoints while the policy of the account is "off". */
export const MFA_NOT_OFFERED_CODE = 'MFA_NOT_OFFERED';

/** May the account enrol a new second factor? Fails open to true only for a missing account (refused elsewhere). */
export async function mfaEnrolmentOffered(userId: string): Promise<boolean> {
  const r = await loadUserMfaPolicy(userId);
  return r ? r.enrolmentOffered : true;
}
