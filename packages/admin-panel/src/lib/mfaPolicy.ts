/**
 * BCP → Authentifizierung → Mehrstufige Anmeldung (MFA) (10.6) — pure helpers
 * (unit-tested with node --test, no imports). Server side: storage
 * auth/mfa-policy.ts (keep resolveLevel in step with resolveMfaPolicy),
 * api-gateway routes/admin/global-settings.ts (/settings/mfa-policy) and
 * routes/admin/user-mfa.ts, docs/mfa-policy.md.
 */

export type MfaLevel = 'required' | 'optional' | 'off';
export type AdminRule = 'required' | 'as_users';
export type MfaSource = 'user' | 'admin' | 'global';
export type OverrideChoice = 'inherit' | MfaLevel;

export interface MfaPolicyForm {
  users: MfaLevel;
  admins: AdminRule;
  graceDays: number;
  blocksPrimaryPassword: boolean;
  adminGraceDays: number;
  rememberDays: number;
  rememberDaysAdmins: number;
}

export const MFA_POLICY_FORM_DEFAULTS: MfaPolicyForm = {
  users: 'optional', admins: 'as_users', graceDays: 7, blocksPrimaryPassword: false,
  adminGraceDays: 14, rememberDays: 30, rememberDaysAdmins: 30,
};

export const ADMIN_GRACE_MAX_DAYS = 14;
export const REMEMBER_MAX_DAYS = 365;
/** Preset durations of "Gerät merken" (0 = off); anything else is "custom". */
export const REMEMBER_PRESETS: readonly number[] = [0, 30, 60, 90];

export interface AdminAccount {
  id: string;
  email: string;
  displayName?: string;
  role: string;
  mfaPolicy: MfaLevel | null;
  enrolled: boolean;
}

/** Same precedence as the server: per-user override > admin rule (admin roles) > policy for all users. */
export function resolveLevel(
  form: Pick<MfaPolicyForm, 'users' | 'admins'>, account: { role: string; mfaPolicy: MfaLevel | null },
): { level: MfaLevel; source: MfaSource } {
  if (account.mfaPolicy) return { level: account.mfaPolicy, source: 'user' };
  if (account.role !== 'USER' && form.admins === 'required') return { level: 'required', source: 'admin' };
  return { level: form.users, source: 'global' };
}

/**
 * Admins that would end up without MFA under the (unsaved) form: no "required"
 * policy and no enrolled factor. The page shows a warning listing them.
 */
export function adminsWithoutMfa(form: Pick<MfaPolicyForm, 'users' | 'admins'>, admins: readonly AdminAccount[]): AdminAccount[] {
  return admins.filter((a) => !a.enrolled && resolveLevel(form, a).level !== 'required');
}

/** The select value of a remember duration: a preset or 'custom'. */
export function rememberChoice(days: number): string {
  return REMEMBER_PRESETS.includes(days) ? String(days) : 'custom';
}

/** Clamp a typed number of days to [min, max] (NaN → min). */
export function clampDays(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

/** Client-side form check (the server validates again); null = valid, else a problem key. */
export function formProblem(f: MfaPolicyForm): 'admin_grace' | 'remember_admins' | null {
  if (f.adminGraceDays < 0 || f.adminGraceDays > ADMIN_GRACE_MAX_DAYS) return 'admin_grace';
  if (f.rememberDaysAdmins > f.rememberDays) return 'remember_admins';
  return null;
}

/** The fields of the form that differ from `saved` (PUT body). */
export function changedFields(saved: MfaPolicyForm, form: MfaPolicyForm): Partial<MfaPolicyForm> {
  const out: Partial<MfaPolicyForm> = {};
  for (const k of Object.keys(form) as Array<keyof MfaPolicyForm>) {
    if (form[k] !== saved[k]) (out as Record<string, unknown>)[k] = form[k];
  }
  return out;
}

/** Would setting `choice` on an admin account leave it without an MFA requirement? */
export function overrideLeavesAdminWithoutMfa(
  form: Pick<MfaPolicyForm, 'users' | 'admins'>, role: string, choice: OverrideChoice,
): boolean {
  if (role === 'USER') return false;
  return resolveLevel(form, { role, mfaPolicy: choice === 'inherit' ? null : choice }).level !== 'required';
}

// ── Admin grace prompt (BCP + webmail) ────────────────────────────────────────

const DAY_MS = 86_400_000;

/** Whole days left until `deadline` (rounded up, never negative); null without a valid deadline. */
export function daysLeft(deadline: string | undefined, now: Date): number | null {
  const t = deadline ? Date.parse(deadline) : NaN;
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.ceil((t - now.getTime()) / DAY_MS));
}

/** Local calendar day (YYYY-MM-DD) — "Später" hides the prompt for the rest of that day. */
export function dayKey(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * Show the admin MFA prompt? Only during the grace period, and not when it was
 * dismissed ("Später") on the same day. Dismissing never moves the deadline —
 * the server enforces it (403 MFA_REQUIRED afterwards).
 */
export function adminPromptVisible(
  status: { state?: string; deadline?: string } | null | undefined, dismissedDay: string | null, now: Date,
): boolean {
  if (!status || status.state !== 'grace' || daysLeft(status.deadline, now) === null) return false;
  return dismissedDay !== dayKey(now);
}
