/**
 * Pure decision helpers of the API client's token handling (api/client.ts).
 * Kept free of React/store imports so node:test can cover them.
 */

/**
 * What a failed POST /auth/refresh means:
 * - `logout`: the session is really over — 401 with SESSION_REVOKED, REFRESH_* or TOKEN_*,
 *             or (9.4) 403 PROTOCOL_DISABLED: Webmail was switched off for the account.
 * - `retry`:  temporary (429 rate limit, 5xx, network error) — keep the session, retry with backoff.
 * - `fail`:   any other answer — keep the session state, report the error, no retry loop.
 */
export type RefreshVerdict = 'logout' | 'retry' | 'fail';

export function refreshFailureVerdict(status: number | null, code?: string | null): RefreshVerdict {
  if (status === null || status === 429 || status >= 500) return 'retry';
  if (status === 401 && typeof code === 'string' && /^(SESSION_REVOKED$|REFRESH_|TOKEN_)/.test(code)) return 'logout';
  if (isWebmailDisabled(status, code)) return 'logout';
  return 'fail';
}

/**
 * 9.4: Webmail was switched off for the account (403 PROTOCOL_DISABLED) — the
 * session is over for the webmail: a refresh and every API call are refused.
 */
export function isWebmailDisabled(status: number, code?: string | null): boolean {
  return status === 403 && code === 'PROTOCOL_DISABLED';
}

/**
 * Whether a 401 from an API call may be answered with refresh + retry. Only an
 * expired/invalid access token qualifies (no code, TOKEN_* / SESSION_* or
 * UNAUTHORIZED). Other codes (e.g. a failed re-authentication) are passed to the
 * caller unchanged — refreshing and re-sending would count a second failure.
 */
export function shouldRefreshOn401(code?: string | null): boolean {
  if (!code) return true;
  return code === 'UNAUTHORIZED' || /^(TOKEN_|SESSION_)/.test(code);
}

/** Backoff before refresh attempt `attempt` (1-based): 1 s, 2 s, 4 s … capped at 30 s; honours Retry-After (seconds). */
export function refreshBackoffMs(attempt: number, retryAfter?: string | null): number {
  const ra = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 30_000);
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 30_000);
}
