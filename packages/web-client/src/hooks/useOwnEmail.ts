import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useAuthStore } from '../store/auth.js';

/** The signed-in user's address — from the auth store, else (after a reload) from the profile. */
export function useOwnEmail(): string {
  const storeEmail = useAuthStore((s) => s.email);
  const { data: profile } = useQuery({
    queryKey: ['user', 'profile'],
    queryFn: () => api.get<{ email: string }>('/user/profile'),
    enabled: !storeEmail,
    staleTime: 5 * 60_000,
  });
  return storeEmail ?? profile?.email ?? '';
}
