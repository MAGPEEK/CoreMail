import { useEffect } from 'react';
import { useAuthStore, takeLegacyRefreshToken } from '../store/auth.js';
import toast from 'react-hot-toast';
import { apiErrorFromBody } from '../lib/errors.js';
import { isWebmailDisabled, refreshFailureVerdict, refreshBackoffMs, shouldRefreshOn401 } from '../lib/authRetry.js';

const BASE = '/api/v1';

/**
 * v8.1: marks auth requests as coming from the browser frontend — the server
 * then keeps the refresh token in the HttpOnly cookie `cm_rt` (Path=/auth)
 * instead of the JSON body. The access token stays in memory (store/auth.ts).
 */
const WEB_CLIENT_HEADERS: Record<string, string> = { 'X-CoreMail-Client': 'web' };

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
 * One refresh attempt. v8.1: the refresh token is the HttpOnly cookie
 * `cm_rt` (sent by the browser, rotated by the server's Set-Cookie). The server
 * treats two refreshes with the same token as token theft (session killed), so
 * this must be single-flight — within the tab (refreshPromise) AND across tabs
 * (Web Locks API: a tab that waited sends the cookie the previous tab's response
 * already replaced). A refresh token received in a body (SSO exchange) or left
 * in localStorage by a pre-8.1 MWA is sent once in the body; the answer moves it
 * into the cookie.
 * Only a 401 with SESSION_REVOKED / REFRESH_* / TOKEN_* ends the session; 429,
 * 5xx and network errors are temporary (lib/authRetry.ts).
 */
async function tryRefresh(): Promise<RefreshAttempt> {
  const doRefresh = async (): Promise<RefreshAttempt> => {
    const pending = useAuthStore.getState().pendingRefreshToken;
    const bodyToken = pending ?? takeLegacyRefreshToken();
    if (pending) useAuthStore.setState({ pendingRefreshToken: null });
    // keep a body token for the next try when this one was not answered
    const keepBodyToken = () => {
      if (bodyToken && !useAuthStore.getState().pendingRefreshToken) useAuthStore.setState({ pendingRefreshToken: bodyToken });
    };
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
        useAuthStore.getState().setAccessToken(data.accessToken);
        return { kind: 'ok', token: data.accessToken };
      }
      const body = await res.json().catch(() => null) as { code?: string; error?: string } | null;
      const verdict = refreshFailureVerdict(res.status, body?.code ?? body?.error);
      if (verdict === 'logout') return { kind: 'logout' };
      keepBodyToken();
      return verdict === 'retry' ? { kind: 'retry', retryAfter: res.headers.get('Retry-After') } : { kind: 'fail' };
    } catch {
      keepBodyToken(); // network error: transient, do not log out
      return { kind: 'retry', retryAfter: null };
    }
  };
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request('coremail-mwa-refresh', doRefresh);
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

/** Single-flight refresh: concurrent callers share one /auth/refresh request (and its retries). */
async function refreshOnce(maxAttempts = 3): Promise<string | null> {
  refreshPromise ??= refreshWithRetry(maxAttempts).finally(() => { refreshPromise = null; });
  return refreshPromise;
}

// A body refresh token handed to the store (SSO exchange) is moved into the
// HttpOnly cookie right away — it must not linger in memory until the access
// token expires (and a reload would lose it).
useAuthStore.subscribe((s, prev) => {
  if (s.pendingRefreshToken && s.pendingRefreshToken !== prev.pendingRefreshToken) {
    void refreshOnce().catch(() => undefined);
  }
});

let sessionCheck: Promise<void> | null = null;

/**
 * Start-up session check: with no access token in memory (page load), asks
 * /auth/refresh with the cookie for one. Resolves when done; afterwards
 * `sessionChecked` is true and `accessToken` is set when a session exists.
 */
export function ensureSession(): Promise<void> {
  if (useAuthStore.getState().sessionChecked) return Promise.resolve();
  sessionCheck ??= (async () => {
    if (!useAuthStore.getState().accessToken) {
      // more attempts than mid-session (429/5xx/offline are retried with backoff);
      // if it still fails the login page shows, but the cookie session is kept
      try { await refreshOnce(6); } catch { /* temporary failure — see RefreshUnavailableError */ }
    }
    useAuthStore.getState().setSessionChecked(true);
  })().finally(() => { sessionCheck = null; });
  return sessionCheck;
}

/** Hook for route guards: false while the start-up session check runs. */
export function useSessionChecked(): boolean {
  const checked = useAuthStore((s) => s.sessionChecked);
  useEffect(() => { if (!checked) void ensureSession(); }, [checked]);
  return checked;
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
      try {
        token = await refreshOnce();
      } catch (err) {
        // temporary refresh failure: go on with the still valid token
        if (exp - nowSecs <= 5) throw err;
      }
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
  if (res.status === 403) {
    // 9.4: Webmail was switched off for the account — the session is over (like a refused refresh)
    const body = await res.clone().json().catch(() => null) as { code?: string } | null;
    if (isWebmailDisabled(res.status, body?.code)) sessionExpired();
  }
  if (res.status !== 401) return res;

  // Revoked session (admin/user ended it) → no refresh attempt
  const body = await res.clone().json().catch(() => null) as { error?: string; code?: string } | null;
  if (body?.code === 'SESSION_REVOKED' || body?.error === 'SESSION_REVOKED') sessionExpired();
  // A 401 that is not about the access token (e.g. a failed re-authentication)
  // goes to the caller unchanged — no refresh, no re-send, no logout.
  if (!shouldRefreshOn401(body?.code)) return res;

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
  postForm: <T>(path: string, form: FormData, init: RequestInit = {}) => request<T>(path, { ...init, method: 'POST', body: form }, true),
  put:      <T>(path: string, body: unknown)    => request<T>(path, { method: 'PUT',   body: JSON.stringify(body) }),
  patch:    <T>(path: string, body: unknown)    => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  /** DELETE with an optional JSON body (e.g. `{ currentPassword }` for re-authentication). */
  delete:   <T>(path: string, body?: unknown)   => request<T>(path, { method: 'DELETE', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }),
};

/**
 * v8.1: single-use SSE ticket (POST /api/v1/events/ticket, 60 s) for
 * `GET /api/v1/events?ticket=` — the access token never goes into a URL.
 * apiFetch sends the in-memory token and refreshes once on a 401. Returns null
 * when no session exists (the caller retries later).
 */
export async function fetchEventTicket(): Promise<string | null> {
  if (!useAuthStore.getState().accessToken) return null;
  const res = await apiFetch('/api/v1/events/ticket', { method: 'POST', body: '{}' }, 'application/json');
  if (!res.ok) throw new Error(`SSE ticket: HTTP ${res.status}`);
  const data = await res.json() as { ticket?: unknown };
  return typeof data.ticket === 'string' && data.ticket ? data.ticket : null;
}

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

/**
 * v8.1: `refreshToken` is '' for browser logins — the refresh token is set as
 * the HttpOnly cookie by the server; callers pass it on to setTokens() unchanged.
 */
export async function login(email: string, password: string): Promise<LoginResult> {
  const res = await fetch('/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...WEB_CLIENT_HEADERS },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Login failed' })) as { error: string; message?: string; code?: string };
    // Maintenance mode: pass message as prefix so LoginPage can detect it
    if (body.error === 'maintenance') {
      throw new Error(`maintenance:${body.message ?? 'Wartungsmodus aktiv'}`);
    }
    if (body.code === 'ACCOUNT_LOCKED') {
      throw new Error('Zu viele fehlgeschlagene Anmeldeversuche. Bitte versuchen Sie es später erneut.');
    }
    if (body.code === 'PROTOCOL_DISABLED') throw apiErrorFromBody(body, res.status); // 9.4: Webmail off
    throw new Error(body.error);
  }
  const data = await res.json() as LoginResult | { accessToken: string; refreshToken?: string };
  if ('accessToken' in data) return { accessToken: data.accessToken, refreshToken: data.refreshToken ?? '' };
  return data;
}

/**
 * Trades the one-time SSO code for tokens (POST /auth/sso/exchange). v8.1: sent
 * as browser client, so the refresh token comes back as the HttpOnly cookie
 * `cm_rt` and the body only carries the access token (or an MFA challenge).
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

type TokenPair = { accessToken: string; refreshToken: string };

async function postMfaVerify(body: Record<string, unknown>): Promise<TokenPair> {
  const res = await fetch('/auth/mfa/verify', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...WEB_CLIENT_HEADERS },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'MFA fehlgeschlagen' })) as { code?: string };
    if (err.code === 'ACCOUNT_LOCKED') {
      throw new Error('Zu viele fehlgeschlagene Anmeldeversuche. Bitte versuchen Sie es später erneut.');
    }
    throw apiErrorFromBody(err, res.status, 'Überprüfung fehlgeschlagen');
  }
  const data = await res.json() as { accessToken: string; refreshToken?: string };
  return { accessToken: data.accessToken, refreshToken: data.refreshToken ?? '' };
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
 * Ends the session: revokes the refresh token server-side (POST /auth/logout —
 * v8.1: the cookie, or a not yet adopted body token) and clears the local auth
 * state. The server deletes the cookie. Server errors never block the local logout.
 */
export async function logoutSession(): Promise<void> {
  const { pendingRefreshToken, accessToken } = useAuthStore.getState();
  try {
    await fetch('/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...WEB_CLIENT_HEADERS,
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(pendingRefreshToken ? { refreshToken: pendingRefreshToken } : {}),
      keepalive: true,
    });
  } catch { /* offline — still log out locally */ }
  takeLegacyRefreshToken(); // never leave a pre-8.1 token behind
  useAuthStore.getState().logout();
}
