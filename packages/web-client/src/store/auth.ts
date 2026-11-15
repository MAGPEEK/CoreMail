import { create } from 'zustand';

/**
 * Auth state of the MWA (v8.1).
 *
 * - The access token lives in memory only (never localStorage/sessionStorage).
 *   After a page load it is re-obtained with POST /auth/refresh, which
 *   authenticates with the HttpOnly refresh cookie `cm_rt` (see api/client.ts).
 * - The refresh token is never readable by scripts. The only exception is a
 *   token handed over in a response body (the SSO exchange, or the one-time
 *   migration of a pre-8.1 localStorage token): it is kept in memory as
 *   `pendingRefreshToken` and moved into the cookie by the next refresh.
 */
interface AuthState {
  accessToken: string | null;
  /** Body refresh token waiting to be moved into the cookie (memory only). */
  pendingRefreshToken: string | null;
  /** True once the start-up session check (cookie → access token) has finished. */
  sessionChecked: boolean;
  userId: string | null;
  email: string | null;
  displayName: string | null;
  role: string | null;
  /**
   * Stores the access token of a fresh login. `refresh` is only passed by
   * callers that received a refresh token in a body (SSO exchange); browser
   * logins get the cookie instead and pass nothing / ''.
   */
  setTokens: (access: string, refresh?: string | null) => void;
  setAccessToken: (access: string) => void;
  setProfile: (userId: string, email: string, displayName: string, role: string) => void;
  setSessionChecked: (checked: boolean) => void;
  logout: () => void;
}

/** Key of the pre-8.1 zustand persist store (access + refresh token in localStorage). */
const LEGACY_STORAGE_KEY = 'coremail-auth';

function usableToken(t: string | null | undefined): t is string {
  return typeof t === 'string' && t.length > 0 && t !== 'undefined' && t !== 'null';
}

export const useAuthStore = create<AuthState>()((set) => ({
  accessToken: null,
  pendingRefreshToken: null,
  sessionChecked: false,
  userId: null,
  email: null,
  displayName: null,
  role: null,
  setTokens: (accessToken, refresh) => set({
    accessToken,
    pendingRefreshToken: usableToken(refresh) ? refresh : null,
    sessionChecked: true,
  }),
  setAccessToken: (accessToken) => set({ accessToken }),
  setProfile: (userId, email, displayName, role) => set({ userId, email, displayName, role }),
  setSessionChecked: (sessionChecked) => set({ sessionChecked }),
  logout: () => set({
    accessToken: null, pendingRefreshToken: null, userId: null, email: null, displayName: null, role: null,
    sessionChecked: true,
  }),
}));

/**
 * One-time migration: returns the refresh token a pre-8.1 MWA left in
 * localStorage and deletes the stored tokens. Call it only while holding the
 * cross-tab refresh lock, so exactly one tab presents the old token.
 */
export function takeLegacyRefreshToken(): string | null {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (raw === null) return null;
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    const state = (JSON.parse(raw) as { state?: { refreshToken?: unknown } }).state;
    return typeof state?.refreshToken === 'string' && usableToken(state.refreshToken) ? state.refreshToken : null;
  } catch {
    return null;
  }
}
