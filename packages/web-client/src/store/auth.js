import { create } from 'zustand';
import { persist } from 'zustand/middleware';
export const useAuthStore = create()(persist((set) => ({
    accessToken: null,
    refreshToken: null,
    userId: null,
    email: null,
    displayName: null,
    role: null,
    setTokens: (accessToken, refreshToken) => set({ accessToken, refreshToken }),
    setProfile: (userId, email, displayName, role) => set({ userId, email, displayName, role }),
    logout: () => set({ accessToken: null, refreshToken: null, userId: null, email: null, displayName: null, role: null }),
}), { name: 'coremail-auth', partialize: (s) => ({ accessToken: s.accessToken, refreshToken: s.refreshToken }) }));
