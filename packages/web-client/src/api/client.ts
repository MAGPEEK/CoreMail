import { useAuthStore } from '../store/auth.js';

const BASE = '/api/v1';

/** Decode JWT exp claim without a library (returns seconds since epoch or null). */
function getJwtExp(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]!)) as { exp?: number };
    return payload.exp ?? null;
  } catch {
    return null;
  }
}

let isRefreshing = false;
let refreshPromise: Promise<string | null> | null = null;

/** Attempt to refresh the access token. Returns new access token or null on failure. */
async function tryRefresh(): Promise<string | null> {
  const refreshToken = useAuthStore.getState().refreshToken;
  if (!refreshToken) return null;
  try {
    const res = await fetch('/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { accessToken: string; refreshToken?: string };
    if (data.accessToken) {
      useAuthStore.getState().setTokens(data.accessToken, data.refreshToken ?? refreshToken);
      return data.accessToken;
    }
    return null;
  } catch {
    return null;
  }
}

async function request<T>(path: string, init: RequestInit = {}, skipContentType = false): Promise<T> {
  let token = useAuthStore.getState().accessToken;

  // Proactive refresh: if token expires within 120 seconds, refresh first
  if (token) {
    const exp = getJwtExp(token);
    const nowSecs = Math.floor(Date.now() / 1000);
    if (exp !== null && exp - nowSecs < 120) {
      if (!isRefreshing) {
        isRefreshing = true;
        refreshPromise = tryRefresh().finally(() => { isRefreshing = false; refreshPromise = null; });
      }
      const newToken = await refreshPromise;
      if (newToken) {
        token = newToken;
      } else {
        // Refresh token also expired — clear and redirect to login
        useAuthStore.getState().logout();
        window.location.href = '/login';
        throw new Error('Session expired');
      }
    }
  }

  const headers: Record<string, string> = {
    ...(skipContentType ? {} : { 'Content-Type': 'application/json' }),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(init.headers as Record<string, string> ?? {}),
  };

  const res = await fetch(`${BASE}${path}`, { ...init, headers });

  if (res.status === 401) {
    // Fallback: attempt refresh once before redirecting
    const newToken = await tryRefresh();
    if (newToken) {
      // Retry original request with new token
      const retryHeaders: Record<string, string> = {
        ...(skipContentType ? {} : { 'Content-Type': 'application/json' }),
        Authorization: `Bearer ${newToken}`,
        ...(init.headers as Record<string, string> ?? {}),
      };
      const retryRes = await fetch(`${BASE}${path}`, { ...init, headers: retryHeaders });
      if (retryRes.ok) {
        if (retryRes.status === 204) return undefined as T;
        return retryRes.json() as Promise<T>;
      }
    }
    useAuthStore.getState().logout();
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get:      <T>(path: string)                   => request<T>(path),
  post:     <T>(path: string, body: unknown)    => request<T>(path, { method: 'POST',  body: JSON.stringify(body) }),
  postForm: <T>(path: string, form: FormData)   => request<T>(path, { method: 'POST',  body: form }, true),
  put:      <T>(path: string, body: unknown)    => request<T>(path, { method: 'PUT',   body: JSON.stringify(body) }),
  patch:    <T>(path: string, body: unknown)    => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete:   <T>(path: string)                   => request<T>(path, { method: 'DELETE' }),
};

export type LoginResult =
  | { accessToken: string; refreshToken: string }
  | { mfaRequired: true; challengeToken: string; method: string };

export async function login(email: string, password: string): Promise<LoginResult> {
  const res = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Login failed' })) as { error: string; message?: string };
    // Wartungsmodus: message als Prefix übergeben damit LoginPage ihn erkennt
    if (body.error === 'maintenance') {
      throw new Error(`maintenance:${body.message ?? 'Wartungsmodus aktiv'}`);
    }
    throw new Error(body.error);
  }
  return res.json() as Promise<LoginResult>;
}

export async function verifyMfa(
  challengeToken: string,
  code: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await fetch('/auth/mfa/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeToken, code }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'MFA failed' })) as { error: string };
    throw new Error(body.error);
  }
  return res.json() as Promise<{ accessToken: string; refreshToken: string }>;
}
