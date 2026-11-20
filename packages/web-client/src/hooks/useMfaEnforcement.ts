import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import type { MfaEnforcementInfo } from '../lib/mfaEnforcement.js';

/**
 * 10.5: "MFA für alle Benutzer erzwingen" state of the signed-in account
 * (GET /api/v1/user/mfa-enforcement — reachable while enrolment is required).
 * Settings → Sicherheit invalidates the key after an enrolment.
 */
export function useMfaEnforcement() {
  return useQuery<MfaEnforcementInfo>({
    queryKey: ['mfa-enforcement'],
    queryFn: () => api.get<MfaEnforcementInfo>('/user/mfa-enforcement'),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    retry: 1,
  });
}
