/**
 * 9.4: the webmail policy of the signed-in account (GET /user/features) — one
 * call, cached, refreshed by the `settings` / `policies` live event
 * (lib/realtimeEvents.ts). Until it is loaded (or when it fails) the UI keeps
 * today's behaviour; the server enforces the switches anyway.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useAuthStore } from '../store/auth.js';
import { SAFETY_REFETCH_MS } from '../lib/realtimeEvents.js';
import { DEFAULT_FEATURES, FEATURES_QUERY_KEY, type FeaturesResponse } from '../lib/webmailFeatures.js';

export function useWebmailFeatures(): FeaturesResponse {
  const signedIn = useAuthStore((s) => !!s.accessToken);
  const { data } = useQuery({
    queryKey: FEATURES_QUERY_KEY,
    queryFn: () => api.get<FeaturesResponse>('/user/features'),
    enabled: signedIn,
    staleTime: SAFETY_REFETCH_MS,
    refetchInterval: SAFETY_REFETCH_MS,
  });
  return data ?? DEFAULT_FEATURES;
}
