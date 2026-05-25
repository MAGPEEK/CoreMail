const TOKEN_KEY   = 'bcp-token';
const REFRESH_KEY = 'bcp-refresh-token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_KEY);
}

export function setRefreshToken(token: string) {
  localStorage.setItem(REFRESH_KEY, token);
}

export function clearRefreshToken() {
  localStorage.removeItem(REFRESH_KEY);
}

/** Decode JWT exp claim without a library (returns seconds since epoch or null). */
function getJwtExp(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]!)) as { exp?: number };
    return payload.exp ?? null;
  } catch {
    return null;
  }
}

/** Attempt to refresh the access token. Returns new access token or null on failure. */
async function tryRefresh(): Promise<string | null> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return null;
  try {
    const res = await fetch('/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { accessToken: string };
    if (data.accessToken) {
      setToken(data.accessToken);
      return data.accessToken;
    }
    return null;
  } catch {
    return null;
  }
}

let isRefreshing = false;
let refreshPromise: Promise<string | null> | null = null;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let token = getToken();

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
        // Refresh token also expired — clear and redirect
        clearToken();
        window.location.href = '/bcp/login';
        throw new Error('Session expired');
      }
    }
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(init.headers as Record<string, string> ?? {}),
  };

  const res = await fetch(`/api/v1${path}`, { ...init, headers });

  if (res.status === 401) {
    // Fallback: attempt refresh once before redirecting
    const newToken = await tryRefresh();
    if (newToken) {
      // Retry the original request with the new token
      const retryHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${newToken}`,
        ...(init.headers as Record<string, string> ?? {}),
      };
      const retryRes = await fetch(`/api/v1${path}`, { ...init, headers: retryHeaders });
      if (retryRes.ok) {
        if (retryRes.status === 204) return undefined as T;
        return retryRes.json() as Promise<T>;
      }
    }
    clearToken();
    // Admin-Panel liegt unter /bcp — React Router basename="/bcp"
    window.location.href = '/bcp/login';
    throw new Error('Unauthorized');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error: string; code?: string };
    // v3.18.19 D5: Forced 2FA — Backend liefert 403 mit code=MFA_REQUIRED wenn
    // requireMfaForAdmins=true und User keine MFA aktiviert hat. Frontend leitet
    // auf MFA-Setup-Seite. (Verhindert dass User in Endlos-Fehler-Loop landen.)
    if (res.status === 403 && body.code === 'MFA_REQUIRED') {
      // Vermeide doppelte Redirects wenn schon auf der MFA-Seite
      if (!window.location.pathname.startsWith('/bcp/mfa-required')) {
        window.location.href = '/bcp/mfa-required';
      }
      throw new Error('MFA_REQUIRED');
    }
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get:    <T>(path: string) => request<T>(path),
  post:   <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST',  body: JSON.stringify(body) }),
  put:    <T>(path: string, body: unknown)  => request<T>(path, { method: 'PUT',   body: JSON.stringify(body) }),
  patch:  <T>(path: string, body: unknown)  => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete:         <T>(path: string)              => request<T>(path, { method: 'DELETE' }),
  deleteWithBody: <T>(path: string, body: unknown) => request<T>(path, { method: 'DELETE', body: JSON.stringify(body) }),
};

/**
 * Build a download URL with the auth token appended as a query parameter.
 * Required for `window.open()`/`<a href>` style downloads where we can't
 * set the Authorization header. The `requireAuth` middleware accepts
 * `?token=…` as a fallback.
 */
export function exportUrl(path: string, params: URLSearchParams): string {
  const token = getToken();
  if (token) params.set('token', token);
  return `/api/v1${path}?${params.toString()}`;
}

export type LoginResult =
  | { accessToken: string; refreshToken?: string }
  | { mfaRequired: true; challengeToken: string; method: string };

export async function loginAdmin(email: string, password: string): Promise<LoginResult> {
  const res = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Login failed' })) as { error: string };
    throw new Error(body.error);
  }
  const data = await res.json() as LoginResult;
  if ('accessToken' in data && data.refreshToken) {
    setRefreshToken(data.refreshToken);
  }
  return data;
}

export async function verifyMfaAdmin(
  challengeToken: string,
  code: string,
): Promise<string> {
  const res = await fetch('/auth/mfa/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeToken, code }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'MFA fehlgeschlagen' })) as { error: string };
    throw new Error(body.error);
  }
  const data = await res.json() as { accessToken: string; refreshToken?: string };
  if (data.refreshToken) {
    setRefreshToken(data.refreshToken);
  }
  return data.accessToken;
}
