import { useEffect, useSyncExternalStore } from 'react';
import toast from 'react-hot-toast';
import { ApiError, apiErrorFromBody } from '../lib/errors.js';
import { refreshFailureVerdict, refreshBackoffMs, shouldRefreshOn401 } from '../lib/authRetry.js';
import { accessForPath } from '../lib/adminAreas.js';
import { useAccessStore } from '../store/access.js';

/** Keys of the pre-8.1 token storage (localStorage) — only read once for migration. */
const LEGACY_TOKEN_KEY   = 'bcp-token';
const LEGACY_REFRESH_KEY = 'bcp-refresh-token';
const BASE = '/api/v1';

/**
 * v8.1: the BCP keeps the access token in memory only. The refresh token is the
 * HttpOnly cookie `cm_rt_bcp` (Path=/auth), selected by `X-CoreMail-App: bcp` —
 * separate from the MWA cookie so both apps can hold different sessions.
 * After a page load the access token is re-obtained via /auth/refresh
 * (ensureSession / useSessionChecked).
 */
const WEB_CLIENT_HEADERS: Record<string, string> = { 'X-CoreMail-Client': 'web', 'X-CoreMail-App': 'bcp' };

let accessToken: string | null = null;
/** A refresh token received in a body (SSO exchange, legacy migration) — moved into the cookie by the next refresh. */
let pendingRefreshToken: string | null = null;
let sessionChecked = false;
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };

export function getToken(): string | null {
  return accessToken;
}

export function setToken(token: string) {
  accessToken = token;
  sessionChecked = true;
  notify();
}

export function clearToken() {
  accessToken = null;
  pendingRefreshToken = null;
  sessionChecked = true;
  try {
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    localStorage.removeItem(LEGACY_REFRESH_KEY);
  } catch { /* storage unavailable */ }
  notify();
}

/** @deprecated v8.1 — the refresh token is an HttpOnly cookie; only a not yet adopted body token is returned. */
export function getRefreshToken(): string | null {
  return pendingRefreshToken;
}

/**
 * Hands over a refresh token received in a response body (SSO exchange): it is
 * moved into the HttpOnly cookie right away by one /auth/refresh.
 */
export function setRefreshToken(token: string) {
  if (!token) return;
  pendingRefreshToken = token;
  void refreshOnce().catch(() => undefined);
}

export function clearRefreshToken() {
  pendingRefreshToken = null;
}

/** One-time migration of a pre-8.1 refresh token; call only inside the refresh lock. */
function takeLegacyRefreshToken(): string | null {
  try {
    const t = localStorage.getItem(LEGACY_REFRESH_KEY);
    localStorage.removeItem(LEGACY_REFRESH_KEY);
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    return t || null;
  } catch {
    return null;
  }
}

let sessionCheck: Promise<void> | null = null;

/** Start-up session check: with no access token in memory, asks /auth/refresh (cookie) for one. */
export function ensureSession(): Promise<void> {
  if (sessionChecked) return Promise.resolve();
  sessionCheck ??= (async () => {
    if (!accessToken) {
      // more attempts than mid-session (429/5xx/offline are retried with backoff);
      // if it still fails the login page shows, but the cookie session is kept
      try { await refreshOnce(6); } catch { /* temporary failure — see RefreshUnavailableError */ }
    }
    sessionChecked = true;
    notify();
  })().finally(() => { sessionCheck = null; });
  return sessionCheck;
}

/** Hook for route guards: false while the start-up session check runs; re-renders on token changes. */
export function useSessionChecked(): boolean {
  const checked = useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => sessionChecked,
  );
  useEffect(() => { if (!checked) void ensureSession(); }, [checked]);
  return checked;
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

type RefreshAttempt =
  | { kind: 'ok'; token: string }
  | { kind: 'logout' }
  | { kind: 'retry'; retryAfter: string | null }
  | { kind: 'fail' };

/** Thrown when a refresh failed temporarily (429, 5xx, offline) — the session is kept. */
export class RefreshUnavailableError extends Error {
  constructor() {
    super('Server vorübergehend nicht erreichbar. Bitte später erneut versuchen.');
    this.name = 'RefreshUnavailableError';
  }
}

/**
 * One refresh attempt. v8.1: authenticated by the HttpOnly cookie
 * `cm_rt_bcp`, which the server rotates on every call; it treats two refreshes
 * with the same token as reuse (session killed), so the refresh is single-flight
 * within the tab (refreshPromise) and across tabs (Web Locks — a waiting tab
 * sends the cookie the previous response already replaced). A body token (SSO
 * exchange, pre-8.1 localStorage) is sent once and thereby moved into the cookie.
 * Only a 401 with SESSION_REVOKED / REFRESH_* / TOKEN_* ends the session; 429,
 * 5xx and network errors are temporary (lib/authRetry.ts).
 */
async function tryRefresh(): Promise<RefreshAttempt> {
  const doRefresh = async (): Promise<RefreshAttempt> => {
    const bodyToken = pendingRefreshToken ?? takeLegacyRefreshToken();
    pendingRefreshToken = null;
    const keepBodyToken = () => { if (bodyToken && !pendingRefreshToken) pendingRefreshToken = bodyToken; };
    try {
      const res = await fetch('/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', ...WEB_CLIENT_HEADERS },
        body: JSON.stringify(bodyToken ? { refreshToken: bodyToken } : {}),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({})) as { accessToken?: string };
        if (!data.accessToken) return { kind: 'fail' };
        setToken(data.accessToken);
        return { kind: 'ok', token: data.accessToken };
      }
      const body = await res.json().catch(() => null) as { code?: string; error?: string } | null;
      const verdict = refreshFailureVerdict(res.status, body?.code ?? body?.error);
      if (verdict === 'logout') return { kind: 'logout' };
      keepBodyToken();
      return verdict === 'retry' ? { kind: 'retry', retryAfter: res.headers.get('Retry-After') } : { kind: 'fail' };
    } catch {
      keepBodyToken();
      return { kind: 'retry', retryAfter: null }; // network error — transient
    }
  };
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request('coremail-bcp-refresh', doRefresh);
  }
  return doRefresh();
}

const RETRY_NOTICE_ID = 'auth-refresh-retry';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Refresh with backoff: the new access token, null when the session is over, or
 * RefreshUnavailableError on a temporary failure (session kept, non-blocking notice).
 */
async function refreshWithRetry(maxAttempts: number): Promise<string | null> {
  for (let attempt = 1; ; attempt++) {
    const r = await tryRefresh();
    if (r.kind === 'ok' || r.kind === 'logout') {
      toast.dismiss(RETRY_NOTICE_ID);
      return r.kind === 'ok' ? r.token : null;
    }
    if (r.kind === 'fail' || attempt >= maxAttempts) {
      toast.error('Server vorübergehend nicht erreichbar — Ihre Sitzung bleibt erhalten.', { id: RETRY_NOTICE_ID, duration: 6000 });
      throw new RefreshUnavailableError();
    }
    toast.loading('Server ausgelastet — Sitzung wird erneut geprüft …', { id: RETRY_NOTICE_ID });
    await sleep(refreshBackoffMs(attempt, r.retryAfter));
  }
}

let refreshPromise: Promise<string | null> | null = null;

/** Single-flight refresh: concurrent callers share one /auth/refresh request (and its retries). */
function refreshOnce(maxAttempts = 3): Promise<string | null> {
  refreshPromise ??= refreshWithRetry(maxAttempts).finally(() => { refreshPromise = null; });
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
    const left = exp === null ? Infinity : exp - Math.floor(Date.now() / 1000);
    if (left < 120) {
      try {
        token = await refreshOnce();
      } catch (err) {
        // temporary refresh failure: go on with the still valid token
        if (left <= 5) throw err;
      }
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
  // A 401 that is not about the access token (e.g. a failed re-authentication)
  // goes to the caller unchanged — no refresh, no re-send, no logout.
  if (!shouldRefreshOn401(body?.code)) return res;

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

/**
 * v8.1: single-use SSE ticket (POST /api/v1/events/ticket, 60 s) for
 * `GET /api/v1/events?ticket=` — the access token never goes into a URL.
 * apiFetch sends the in-memory token and refreshes once on a 401. Returns null
 * when no session exists (the caller retries later).
 */
export async function fetchEventTicket(): Promise<string | null> {
  if (!getToken()) return null;
  const res = await apiFetch('/api/v1/events/ticket', { method: 'POST', body: '{}' });
  if (!res.ok) throw new Error(`SSE ticket: HTTP ${res.status}`);
  const data = await res.json() as { ticket?: unknown };
  return typeof data.ticket === 'string' && data.ticket ? data.ticket : null;
}

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

/**
 * Like downloadFile, but the server's Content-Disposition file name wins over
 * `fallbackName` (backup downloads: the server knows the decrypted name).
 */
export async function downloadFileNamed(path: string, fallbackName: string, nameFromHeader: (h: string | null) => string | null): Promise<void> {
  const res = await apiFetch(path, {}, null);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as unknown;
    throw apiErrorFromBody(body, res.status);
  }
  const name = nameFromHeader(res.headers.get('content-disposition')) ?? fallbackName;
  saveBlob(await res.blob(), name);
}

// ── Login / MFA / logout ──────────────────────────────────────────────────────

export type MfaMethod = 'webauthn' | 'totp' | 'backup_code';

export type LoginResult =
  | { accessToken: string; refreshToken?: string }
  | { mfaRequired: true; challengeToken: string; method: string; methods?: MfaMethod[] };

export async function loginAdmin(email: string, password: string): Promise<LoginResult> {
  const res = await fetch('/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...WEB_CLIENT_HEADERS },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Login failed' })) as { error?: string; message?: string; code?: string };
    if (body.error === 'maintenance') throw new Error(body.message ?? 'Wartungsmodus aktiv');
    if (body.code === 'ACCOUNT_LOCKED') throw new Error('Zu viele fehlgeschlagene Anmeldeversuche. Bitte versuchen Sie es später erneut.');
    throw apiErrorFromBody(body, res.status, 'Anmeldung fehlgeschlagen');
  }
  // v8.1: the refresh token arrives as HttpOnly cookie, not in the body
  const data = await res.json() as LoginResult;
  if ('accessToken' in data && data.refreshToken) setRefreshToken(data.refreshToken); // older server
  return data;
}

/**
 * Trades the one-time SSO code for tokens (POST /auth/sso/exchange). v8.1: sent
 * as BCP browser client, so the refresh token comes back as the HttpOnly cookie
 * `cm_rt_bcp` and the body only carries the access token (or an MFA challenge).
 */
export async function exchangeSsoCode(code: string): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  const res = await fetch('/auth/sso/exchange', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...WEB_CLIENT_HEADERS },
    body: JSON.stringify({ code }),
  });
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { ok: res.ok, body };
}

async function postMfaVerify(body: Record<string, unknown>): Promise<string> {
  const res = await fetch('/auth/mfa/verify', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...WEB_CLIENT_HEADERS },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'MFA fehlgeschlagen' })) as { code?: string };
    if (err.code === 'ACCOUNT_LOCKED') throw new Error('Zu viele fehlgeschlagene Anmeldeversuche. Bitte versuchen Sie es später erneut.');
    throw apiErrorFromBody(err, res.status, 'Überprüfung fehlgeschlagen');
  }
  const data = await res.json() as { accessToken: string; refreshToken?: string };
  if (data.refreshToken) setRefreshToken(data.refreshToken); // older server
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
  const token = getToken();
  try {
    await fetch('/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...WEB_CLIENT_HEADERS,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      // v8.1: the server revokes the session of the cm_rt_bcp cookie and deletes it
      body: JSON.stringify(pendingRefreshToken ? { refreshToken: pendingRefreshToken } : {}),
      keepalive: true,
    });
  } catch { /* offline — still log out locally */ }
  clearToken();
}
