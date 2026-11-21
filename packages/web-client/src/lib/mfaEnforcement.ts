/**
 * 10.5: "MFA für alle Benutzer erzwingen" in the webmail — pure rules.
 *
 * GET /api/v1/user/mfa-enforcement → { state, deadline?, canEnrol }:
 *   - `grace`    → banner with the days left until `deadline` (Layout)
 *   - `required` → the mandatory enrolment page (MFA_ENROLMENT_ROUTE); every
 *                  other API call answers 403 MFA_ENROLMENT_REQUIRED, which
 *                  api/client.ts turns into a navigation to that page
 * Server side: api-gateway middleware/auth.ts + storage auth/mfa-enforcement.ts.
 */

export const MFA_ENROLMENT_ROUTE = '/mfa-enrolment';
export const MFA_ENROLMENT_REQUIRED_CODE = 'MFA_ENROLMENT_REQUIRED';

export type MfaEnforcementState = 'off' | 'satisfied' | 'grace' | 'required';

export interface MfaEnforcementInfo {
  state: MfaEnforcementState;
  /** ISO time the grace period ends (grace / required). */
  deadline?: string;
  /** false for SSO-only accounts (no password to confirm an enrolment with). */
  canEnrol: boolean;
  /** 10.6: effective MFA policy level of the account. */
  policy?: 'required' | 'optional' | 'off';
  /** 10.6: false while the policy is "off" — the webmail offers no new enrolment. */
  enrolmentOffered?: boolean;
  /** 10.6: the admin MFA rule (admin accounts): grace → dismissible prompt; never blocks the webmail. */
  admin?: { state: 'satisfied' | 'grace' | 'required'; deadline?: string };
}

const DAY_MS = 86_400_000;

/** The API refused the call because the account must enrol a second factor first. */
export function isMfaEnrolmentRequired(status: number, code?: string | null): boolean {
  return status === 403 && code === MFA_ENROLMENT_REQUIRED_CODE;
}

/** Whole days left until `deadline` (rounded up, never negative); null without a valid deadline. */
export function graceDaysLeft(deadline: string | undefined, now: Date): number | null {
  const t = deadline ? Date.parse(deadline) : NaN;
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.ceil((t - now.getTime()) / DAY_MS));
}

export interface MfaEnforcementView {
  /** Show the enrolment page instead of the app. */
  redirect: boolean;
  /** Grace banner: days left (0 = last day) and the deadline. */
  banner: { daysLeft: number; deadline: Date } | null;
}

/** What the app frame does with the enforcement state (no data / error → nothing, the server enforces). */
export function enforcementView(info: MfaEnforcementInfo | undefined | null, now: Date): MfaEnforcementView {
  if (!info) return { redirect: false, banner: null };
  if (info.state === 'required') return { redirect: true, banner: null };
  if (info.state === 'grace') {
    const daysLeft = graceDaysLeft(info.deadline, now);
    if (daysLeft === null) return { redirect: false, banner: null };
    return { redirect: false, banner: { daysLeft, deadline: new Date(Date.parse(info.deadline!)) } };
  }
  return { redirect: false, banner: null };
}

/** A 403 MFA_ENROLMENT_REQUIRED leads to the enrolment page — unless it is already shown. */
export function enrolmentRedirectTarget(pathname: string): string | null {
  return pathname === MFA_ENROLMENT_ROUTE ? null : MFA_ENROLMENT_ROUTE;
}

/** The enrolment page offers "continue" once a factor is enrolled (TOTP or a security key). */
export function hasEnrolledFactor(status: { totpEnabled?: boolean; webauthnCount?: number } | undefined | null): boolean {
  return status?.totpEnabled === true || (status?.webauthnCount ?? 0) > 0;
}

// ── 10.6: MFA policy model ────────────────────────────────────────────────────

/** Local calendar day (YYYY-MM-DD) — "Später" hides the admin prompt for the rest of that day. */
export function dayKey(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * The admin MFA prompt of the app frame: during the admin grace period only,
 * hidden for the rest of the day after "Später". Dismissing never moves the
 * deadline (the admin API answers 403 MFA_REQUIRED afterwards; the webmail stays usable).
 */
export function adminPromptView(
  info: MfaEnforcementInfo | undefined | null, dismissedDay: string | null, now: Date,
): { daysLeft: number; deadline: Date } | null {
  const admin = info?.admin;
  if (!admin || admin.state !== 'grace') return null;
  const daysLeft = graceDaysLeft(admin.deadline, now);
  if (daysLeft === null || dismissedDay === dayKey(now)) return null;
  return { daysLeft, deadline: new Date(Date.parse(admin.deadline!)) };
}
