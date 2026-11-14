import { ApiError, apiErrorFromBody } from '../lib/errors.js';
import { accessForPath } from '../lib/adminAreas.js';
import { useAccessStore } from '../store/access.js';

const TOKEN_KEY   = 'bcp-token';
const REFRESH_KEY = 'bcp-refresh-token';
const BASE = '/api/v1';

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
    const payload = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    return payload.exp ?? null;
  } catch {
    return null;
  }
}

const MAINTENANCE = Symbol('maintenance');

/**
 * Refreshes the access token. The server rotates the refresh token on every call
 * and treats two refreshes with the same token as reuse (session killed), so the
 * refresh is single-flight within the tab (refreshPromise) and across tabs
 * (Web Locks; a waiting tab adopts the token pair another tab just stored).
 */
async function tryRefresh(): Promise<string | null | typeof MAINTENANCE> {
  const used = getRefreshToken();
  const doRefresh = async (): Promise<string | null | typeof MAINTENANCE> => {
    const current = getRefreshToken();
    const currentAccess = getToken();
    if (current && currentAccess && current !== used) return currentAccess; // rotated by another tab
    if (!current) return null;
    try {
      const res = await fetch('/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: current }),
      });
      if (res.status === 503) return MAINTENANCE;
      if (!res.ok) return null; // REFRESH_INVALID|EXPIRED|REUSED|INACTIVE
      const data = await res.json() as { accessToken: string; refreshToken?: string };
      if (!data.accessToken) return null;
      setToken(data.accessToken);
      if (data.refreshToken) setRefreshToken(data.refreshToken); // always store the rotated token
      return data.accessToken;
    } catch {
      return MAINTENANCE; // network error — transient
    }
  };
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request('coremail-bcp-refresh', doRefresh);
  }
  return doRefresh();
}

let refreshPromise: Promise<string | null> | null = null;

function refreshOnce(): Promise<string | null> {
  if (!refreshPromise) {
    refreshPromise = tryRefresh()
      .then((r) => {
        if (r === MAINTENANCE) throw new Error('Server vorübergehend nicht erreichbar (Wartung). Bitte später erneut versuchen.');
        return r;
      })
      .finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

function redirectToLogin(reason?: string): never {
  clearToken();
  // Admin panel lives under /bcp — React Router basename="/bcp"
  const q = reason ? `?reason=${encodeURIComponent(reason)}` : '';
  window.location.href = `/bcp/login${q}`;
  throw new Error('Session expired');
}

/**
 * fetch() against the API with the Bearer token in the header (never in the URL),
 * proactive refresh and one retry after 401. `/admin/...` → `/api/v1/admin/...`;
 * paths starting with `/api/` or `/auth/` are used unchanged.
 */
export async function apiFetch(path: string, init: RequestInit = {}, contentType: string | null = 'application/json'): Promise<Response> {
  let token = getToken();

  if (token) {
    const exp = getJwtExp(token);
    if (exp !== null && exp - Math.floor(Date.now() / 1000) < 120) {
      token = await refreshOnce();
      if (!token) redirectToLogin();
    }
  }

  const buildHeaders = (t: string | null): Record<string, string> => ({
    ...(contentType ? { 'Content-Type': contentType } : {}),
    ...(t ? { Authorization: `Bearer ${t}` } : {}),
    ...(init.headers as Record<string, string> ?? {}),
  });
  const url = path.startsWith('/api/') || path.startsWith('/auth/') ? path : `${BASE}${path}`;

  const res = await fetch(url, { ...init, headers: buildHeaders(token) });
  if (res.status !== 401) return res;

  const body = await res.clone().json().catch(() => null) as { error?: string; code?: string } | null;
  if (body?.code === 'SESSION_REVOKED' || body?.error === 'SESSION_REVOKED') redirectToLogin('revoked');

  const newToken = await refreshOnce();
  if (newToken) {
    const retryRes = await fetch(url, { ...init, headers: buildHeaders(newToken) });
    if (retryRes.status !== 401) return retryRes;
  }
  redirectToLogin();
}

async function request<T>(path: string, init: RequestInit = {}, contentType: string | null = 'application/json'): Promise<T> {
  // Read-only admin area: block write requests of the current page client-side
  // (the server enforces it as well; this avoids half-applied UI states).
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && path.startsWith('/admin/')
    && accessForPath(useAccessStore.getState().areas, window.location.pathname) === 'read') {
    throw new ApiError('Nur Lesezugriff — Ihre Rolle darf in diesem Bereich nichts ändern.', 'AREA_READ_ONLY', 403);
  }

  const res = await apiFetch(path, init, contentType);

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string; code?: string };
    const code = body.code ?? body.error;
    // v3.18.19 D5: Forced 2FA — 403 MFA_REQUIRED → MFA setup page
    if (res.status === 403 && code === 'MFA_REQUIRED') {
      if (!window.location.pathname.startsWith('/bcp/mfa-required')) {
        window.location.href = '/bcp/mfa-required';
      }
      throw new Error('MFA_REQUIRED');
    }
    // Session without verified second factor → sign in again with MFA
    if (res.status === 403 && code === 'MFA_NOT_VERIFIED') redirectToLogin('mfa');
    throw apiErrorFromBody(body, res.status);
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
  /** POSTs a raw File/Blob as request body (streamed by the browser, never read into a string). */
  postFile: <T>(path: string, file: Blob, contentType = file.type || 'application/octet-stream') =>
    request<T>(path, { method: 'POST', body: file }, contentType),
};

// ── Downloads without tokens in URLs ──────────────────────────────────────────

/** Fetches an authenticated resource as Blob (Authorization header). */
export async function fetchBlob(path: string): Promise<Blob> {
  const res = await apiFetch(path, {}, null);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as unknown;
    throw apiErrorFromBody(body, res.status);
  }
  return res.blob();
}

/** Saves a Blob as a file via a temporary object URL. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Downloads an authenticated API resource (e.g. an export) as a file. */
export async function downloadFile(path: string, filename: string): Promise<void> {
  saveBlob(await fetchBlob(path), filename);
}

// ── Login / MFA / logout ──────────────────────────────────────────────────────

export type MfaMethod = 'webauthn' | 'totp' | 'backup_code';

export type LoginResult =
  | { accessToken: string; refreshToken?: string }
  | { mfaRequired: true; challengeToken: string; method: string; methods?: MfaMethod[] };

export async function loginAdmin(email: string, password: string): Promise<LoginResult> {
  const res = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Login failed' })) as { error?: string; message?: string };
    if (body.error === 'maintenance') throw new Error(body.message ?? 'Wartungsmodus aktiv');
    throw apiErrorFromBody(body, res.status, 'Anmeldung fehlgeschlagen');
  }
  const data = await res.json() as LoginResult;
  if ('accessToken' in data && data.refreshToken) {
    setRefreshToken(data.refreshToken);
  }
  return data;
}

async function postMfaVerify(body: Record<string, unknown>): Promise<string> {
  const res = await fetch('/auth/mfa/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'MFA fehlgeschlagen' })) as unknown;
    throw apiErrorFromBody(err, res.status, 'Überprüfung fehlgeschlagen');
  }
  const data = await res.json() as { accessToken: string; refreshToken?: string };
  if (data.refreshToken) setRefreshToken(data.refreshToken);
  return data.accessToken;
}

/** TOTP code (6 digits) or backup code (XXXX-XXXX) → access token. */
export function verifyMfaAdmin(challengeToken: string, code: string): Promise<string> {
  return postMfaVerify({ challengeToken, code });
}

/** WebAuthn assertion → access token. */
export function verifyMfaAdminWebAuthn(challengeToken: string, webauthnResponse: unknown): Promise<string> {
  return postMfaVerify({ challengeToken, webauthnResponse });
}

export async function startMfaWebAuthn(challengeToken: string): Promise<unknown> {
  const res = await fetch('/auth/mfa/webauthn/auth/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeToken }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'WebAuthn nicht verfügbar' })) as unknown;
    throw apiErrorFromBody(err, res.status);
  }
  return res.json();
}

/**
 * Logout: revokes the refresh token server-side (POST /auth/logout), then clears
 * local tokens. Server/network errors never block the local logout.
 */
export async function logoutSession(): Promise<void> {
  const refreshToken = getRefreshToken();
  const accessToken = getToken();
  if (refreshToken) {
    try {
      await fetch('/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({ refreshToken }),
        keepalive: true,
      });
    } catch { /* offline — still log out locally */ }
  }
  clearToken();
}
