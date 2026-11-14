import { useAuthStore } from '../store/auth.js';
import { apiErrorFromBody } from '../lib/errors.js';

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

let refreshPromise: Promise<string | null> | null = null;
const MAINTENANCE = Symbol('maintenance');

/** Tokens as persisted by zustand (shared by all tabs via localStorage). */
function readPersistedTokens(): { accessToken: string | null; refreshToken: string | null } | null {
  try {
    const raw = localStorage.getItem('coremail-auth');
    if (!raw) return null;
    const s = (JSON.parse(raw) as { state?: { accessToken?: string | null; refreshToken?: string | null } }).state;
    return { accessToken: s?.accessToken ?? null, refreshToken: s?.refreshToken ?? null };
  } catch {
    return null;
  }
}

/**
 * Refreshes the access token. The server rotates the refresh token on every call
 * and treats two refreshes with the same token as token theft (session killed),
 * so this must be single-flight — within the tab (refreshPromise) AND across tabs
 * (Web Locks API; a tab that waited adopts the tokens another tab just obtained).
 * Returns the new access token, null (session over) or MAINTENANCE (503, keep session).
 */
async function tryRefresh(): Promise<string | null | typeof MAINTENANCE> {
  const used = useAuthStore.getState().refreshToken;
  const doRefresh = async (): Promise<string | null | typeof MAINTENANCE> => {
    // Another tab may have rotated the token while we waited for the lock
    const persisted = readPersistedTokens();
    if (persisted?.refreshToken && persisted.accessToken && persisted.refreshToken !== used) {
      useAuthStore.getState().setTokens(persisted.accessToken, persisted.refreshToken);
      return persisted.accessToken;
    }
    const refreshToken = persisted?.refreshToken ?? used;
    if (!refreshToken) return null;
    try {
      const res = await fetch('/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (res.status === 503) return MAINTENANCE;
      if (!res.ok) return null; // 401 REFRESH_INVALID|EXPIRED|REUSED|INACTIVE → logout
      const data = await res.json() as { accessToken: string; refreshToken?: string };
      if (!data.accessToken) return null;
      // Always store the rotated refresh token
      useAuthStore.getState().setTokens(data.accessToken, data.refreshToken ?? refreshToken);
      return data.accessToken;
    } catch {
      return MAINTENANCE; // network error: transient, do not log out
    }
  };
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request('coremail-mwa-refresh', doRefresh);
  }
  return doRefresh();
}

/** Single-flight refresh: concurrent callers share one /auth/refresh request. */
async function refreshOnce(): Promise<string | null> {
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

function sessionExpired(): never {
  useAuthStore.getState().logout();
  window.location.href = '/login';
  throw new Error('Session expired');
}

/**
 * fetch() against the REST API (`/mail/...` → `/api/v1/mail/...`; paths that
 * already start with `/api/` or `/auth/` are used unchanged) with the Bearer token in the Authorization header
 * (never in the URL), proactive refresh shortly before expiry and one retry
 * after a 401. Returns the raw Response (status is NOT checked except 401).
 */
export async function apiFetch(path: string, init: RequestInit = {}, contentType: string | null = null): Promise<Response> {
  let token = useAuthStore.getState().accessToken;

  // Proactive refresh: if token expires within 120 seconds, refresh first
  if (token) {
    const exp = getJwtExp(token);
    const nowSecs = Math.floor(Date.now() / 1000);
    if (exp !== null && exp - nowSecs < 120) {
      token = await refreshOnce();
      if (!token) sessionExpired();
    }
  }

  const buildHeaders = (t: string | null): Record<string, string> => ({
    ...(contentType ? { 'Content-Type': contentType } : {}),
    ...(t ? { Authorization: `Bearer ${t}` } : {}),
    ...(init.headers as Record<string, string> ?? {}),
  });

  // API paths are relative to /api/v1; /api/… and /auth/… are used as given
  const url = path.startsWith('/api/') || path.startsWith('/auth/') ? path : `${BASE}${path}`;
  const res = await fetch(url, { ...init, headers: buildHeaders(token) });
  if (res.status !== 401) return res;

  // Revoked session (admin/user ended it) → no refresh attempt
  const body = await res.clone().json().catch(() => null) as { error?: string; code?: string } | null;
  if (body?.code === 'SESSION_REVOKED' || body?.error === 'SESSION_REVOKED') sessionExpired();

  // Fallback: attempt refresh once before redirecting
  const newToken = await refreshOnce();
  if (newToken) {
    const retryRes = await fetch(url, { ...init, headers: buildHeaders(newToken) });
    if (retryRes.status !== 401) return retryRes;
  }
  sessionExpired();
}

async function request<T>(path: string, init: RequestInit = {}, skipContentType = false): Promise<T> {
  const res = await apiFetch(path, init, skipContentType ? null : 'application/json');

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as unknown;
    throw apiErrorFromBody(body, res.status);
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
  /** DELETE with an optional JSON body (e.g. `{ currentPassword }` for re-authentication). */
  delete:   <T>(path: string, body?: unknown)   => request<T>(path, { method: 'DELETE', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),
};

// ── Binary / text downloads without tokens in URLs ───────────────────────────

/** Fetches an authenticated API resource as a Blob (Authorization header, no `?token=`). */
export async function fetchBlob(path: string): Promise<Blob> {
  const res = await apiFetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

/** Fetches an authenticated API resource as text. */
export async function fetchText(path: string): Promise<string> {
  const res = await apiFetch(path, { headers: { Accept: 'text/plain, message/rfc822, */*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Saves a Blob as a file via a temporary object URL. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser time to start the download before revoking
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Downloads an authenticated API resource as a file. */
export async function downloadFile(path: string, filename: string): Promise<void> {
  saveBlob(await fetchBlob(path), filename);
}

// ── Auth (login / MFA / logout) ───────────────────────────────────────────────

export type MfaMethod = 'webauthn' | 'totp' | 'backup_code';

export type LoginResult =
  | { accessToken: string; refreshToken: string }
  | { mfaRequired: true; challengeToken: string; method: string; methods?: MfaMethod[] };

export async function login(email: string, password: string): Promise<LoginResult> {
  const res = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Login failed' })) as { error: string; message?: string };
    // Maintenance mode: pass message as prefix so LoginPage can detect it
    if (body.error === 'maintenance') {
      throw new Error(`maintenance:${body.message ?? 'Wartungsmodus aktiv'}`);
    }
    throw new Error(body.error);
  }
  return res.json() as Promise<LoginResult>;
}

type TokenPair = { accessToken: string; refreshToken: string };

async function postMfaVerify(body: Record<string, unknown>): Promise<TokenPair> {
  const res = await fetch('/auth/mfa/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'MFA fehlgeschlagen' })) as unknown;
    throw apiErrorFromBody(err, res.status, 'Überprüfung fehlgeschlagen');
  }
  return res.json() as Promise<TokenPair>;
}

/**
 * Verifies the MFA step. `code` is a 6-digit TOTP code or a backup code
 * (XXXX-XXXX; the server ignores dashes/spaces/case).
 * Errors carry `code` MFA_INVALID_CODE / MFA_CHALLENGE_EXHAUSTED (→ back to login).
 */
export function verifyMfa(challengeToken: string, code: string): Promise<TokenPair> {
  return postMfaVerify({ challengeToken, code });
}

/** Completes the MFA step with a WebAuthn assertion (security key / passkey). */
export function verifyMfaWebAuthn(challengeToken: string, webauthnResponse: unknown): Promise<TokenPair> {
  return postMfaVerify({ challengeToken, webauthnResponse });
}

/** Fetches WebAuthn request options for the pending MFA challenge. */
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
 * Ends the session: revokes the refresh token server-side (POST /auth/logout)
 * and clears the local auth state. Server errors never block the local logout.
 */
export async function logoutSession(): Promise<void> {
  const { refreshToken, accessToken } = useAuthStore.getState();
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
  useAuthStore.getState().logout();
}
