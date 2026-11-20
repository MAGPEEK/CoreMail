/**
 * Where a 403 of the admin API about MFA leads the BCP (api/client.ts):
 *  - MFA_REQUIRED            requireMfaForAdmins on (10.5: default of fresh
 *                            installations) and no second factor enrolled
 *  - MFA_ENROLMENT_REQUIRED  10.5 "MFA für alle Benutzer erzwingen", grace over
 *    → both: the MFA page (/bcp/mfa-required — enrolment happens in the webmail)
 *  - MFA_NOT_VERIFIED        enrolled, but this session was not established with
 *                            MFA → sign in again with the second factor
 */
export type MfaRedirect = 'mfa-page' | 'login-mfa' | null;

export const MFA_PAGE_PATH = '/bcp/mfa-required';

export function mfaRedirectFor(status: number, code: string | undefined): MfaRedirect {
  if (status !== 403) return null;
  if (code === 'MFA_REQUIRED' || code === 'MFA_ENROLMENT_REQUIRED') return 'mfa-page';
  if (code === 'MFA_NOT_VERIFIED') return 'login-mfa';
  return null;
}
