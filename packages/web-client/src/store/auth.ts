import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  userId: string | null;
  email: string | null;
  displayName: string | null;
  role: string | null;
  setTokens: (access: string, refresh: string) => void;
  setProfile: (userId: string, email: string, displayName: string, role: string) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      userId: null,
      email: null,
      displayName: null,
      role: null,
      setTokens: (accessToken, refreshToken) => set({ accessToken, refreshToken }),
      setProfile: (userId, email, displayName, role) => set({ userId, email, displayName, role }),
      logout: () => set({ accessToken: null, refreshToken: null, userId: null, email: null, displayName: null, role: null }),
    }),
    { name: 'coremail-auth', partialize: (s) => ({ accessToken: s.accessToken, refreshToken: s.refreshToken }) }
  )
);
