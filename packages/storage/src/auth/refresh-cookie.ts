/**
 * Refresh-token cookie for the browser frontends (v8.1).
 *
 * Browser clients (MWA, BCP) mark their auth requests with the header
 * `X-CoreMail-Client: web`. For them every endpoint that issues a token pair
 * (POST /auth/login, /auth/mfa/verify, /auth/refresh — and any later issuer)
 * puts the refresh token into an HttpOnly cookie instead of the JSON body:
 *
 *   cm_rt=<token>; Path=/auth; Max-Age=<JWT_REFRESH_TTL>; HttpOnly; SameSite=Strict[; Secure]
 *
 * `Secure` is set when the request came in over HTTPS (req.secure — TLS proxy or
 * a trusted X-Forwarded-Proto) or the page origin is https:// (TLS terminated by
 * an untrusted-for-headers reverse proxy). The BCP additionally sends
 * `X-CoreMail-App: bcp` and gets its own cookie `cm_rt_bcp`, so an admin session
 * in /bcp never replaces the MWA session of the same browser (and vice versa).
 *
 * POST /auth/refresh and /auth/logout read the cookie when the body carries no
 * `refreshToken`; cookie use requires a same-origin Origin (or Referer) header
 * (CSRF defence in depth on top of SameSite=Strict). Non-browser clients (the
 * admin CLI) keep sending/receiving the refresh token in the JSON body.
 *
 * Pure helpers — no Express dependency; routers pass `req.headers` / `req.secure`.
 */
import type { IncomingHttpHeaders } from 'node:http';
import { config } from '@coremail/core';
import type { TokenPair } from './sessions.js';
import { prisma } from '../prisma/index.js';

export const REFRESH_COOKIE = 'cm_rt';
export const REFRESH_COOKIE_BCP = 'cm_rt_bcp';
export const REFRESH_COOKIE_PATH = '/auth';
/** Request header marking a browser client: `X-CoreMail-Client: web`. */
export const WEB_CLIENT_HEADER = 'x-coremail-client';
/** Optional request header selecting the BCP cookie: `X-CoreMail-App: bcp`. */
export const WEB_APP_HEADER = 'x-coremail-app';

export interface CookieRequestLike {
  headers: IncomingHttpHeaders;
  /** Express `req.secure` (TLS socket or trusted X-Forwarded-Proto). */
  secure?: boolean;
  /** Express `req.hostname` (honours X-Forwarded-Host only with trust proxy). */
  hostname?: string;
}

function header(h: IncomingHttpHeaders, name: string): string | undefined {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
}

export function isWebClient(h: IncomingHttpHeaders): boolean {
  return header(h, WEB_CLIENT_HEADER)?.trim().toLowerCase() === 'web';
}

/** The BCP marks its auth requests with `X-CoreMail-App: bcp`. */
export function isBcpClient(h: IncomingHttpHeaders): boolean {
  return header(h, WEB_APP_HEADER)?.trim().toLowerCase() === 'bcp';
}

export function refreshCookieName(h: IncomingHttpHeaders): string {
  return isBcpClient(h) ? REFRESH_COOKIE_BCP : REFRESH_COOKIE;
}

/**
 * 9.4: which surface a login / refresh asks a session for — the webmail
 * (`X-CoreMail-Client: web` without `X-CoreMail-App: bcp`) or the admin
 * surface (BCP, admin CLI). Only a hint for the Webmail switch at login: the
 * API checks every request by its path anyway (api-gateway requireAuth).
 */
export function sessionSurfaceOf(h: IncomingHttpHeaders): 'webmail' | 'admin' {
  return isWebClient(h) && !isBcpClient(h) ? 'webmail' : 'admin';
}

/** Value of one cookie from the Cookie header (first occurrence), or undefined. */
export function readCookie(h: IncomingHttpHeaders, name: string): string | undefined {
  const raw = header(h, 'cookie');
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    let v = part.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    try { v = decodeURIComponent(v); } catch { /* keep raw */ }
    return v || undefined;
  }
  return undefined;
}

/** The refresh cookie of this request (MWA or BCP cookie, per X-CoreMail-App). */
export function readRefreshCookie(req: CookieRequestLike): string | undefined {
  const v = readCookie(req.headers, refreshCookieName(req.headers));
  return v && v.length <= 4096 ? v : undefined;
}

function pageOrigin(h: IncomingHttpHeaders): URL | null {
  const origin = header(h, 'origin');
  const candidate = origin && origin !== 'null' ? origin : header(h, 'referer');
  if (!candidate) return null;
  try { return new URL(candidate); } catch { return null; }
}

export function isSecureRequest(req: CookieRequestLike): boolean {
  return req.secure === true || pageOrigin(req.headers)?.protocol === 'https:';
}

function cookieAttrs(secure: boolean, maxAgeSec: number): string {
  const expires = maxAgeSec <= 0 ? '; Expires=Thu, 01 Jan 1970 00:00:00 GMT' : '';
  return `; Path=${REFRESH_COOKIE_PATH}; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}${expires}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

/** Set-Cookie value carrying a refresh token for this request's frontend. */
export function refreshCookieHeader(req: CookieRequestLike, token: string, maxAgeSec = config.JWT_REFRESH_TTL): string {
  return `${refreshCookieName(req.headers)}=${encodeURIComponent(token)}${cookieAttrs(isSecureRequest(req), maxAgeSec)}`;
}

/** Set-Cookie value deleting this request's refresh cookie. */
export function clearRefreshCookieHeader(req: CookieRequestLike): string {
  return `${refreshCookieName(req.headers)}=${cookieAttrs(isSecureRequest(req), 0)}`;
}

/**
 * Same-origin check for cookie-authenticated auth requests: the Origin (or, if
 * absent, the Referer) must name this server — the Host header, Express'
 * `req.hostname` (X-Forwarded-Host with trust proxy), the configured public
 * hostname or an entry of COREMAIL_ALLOWED_ORIGINS (comma-separated origins or
 * host names, for unusual reverse-proxy setups). No Origin and no Referer → false.
 */
export function isSameOriginRequest(req: CookieRequestLike, extraHosts: readonly string[] = []): boolean {
  const url = pageOrigin(req.headers);
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) return false;
  const host = url.host.toLowerCase();
  const hostname = url.hostname.toLowerCase();
  const reqHost = header(req.headers, 'host')?.trim().toLowerCase();
  if (reqHost && reqHost === host) return true;
  if (req.hostname && req.hostname.toLowerCase() === hostname) return true;
  const allowed = [
    ...extraHosts,
    ...(process.env['COREMAIL_ALLOWED_ORIGINS'] ?? '').split(','),
  ].map((s) => s.trim().toLowerCase()).filter(Boolean);
  return allowed.some((a) => {
    if (a.includes('://')) {
      try { return new URL(a).origin === url.origin; } catch { return false; }
    }
    return a === host || a === hostname;
  });
}

/** isSameOriginRequest plus ServerSettings.publicHostname (DB errors → not allowed). */
export async function isSameOriginCookieRequest(req: CookieRequestLike): Promise<boolean> {
  if (isSameOriginRequest(req)) return true;
  const s = await prisma.serverSettings
    .findUnique({ where: { id: 'singleton' }, select: { publicHostname: true } })
    .catch(() => null);
  return s?.publicHostname ? isSameOriginRequest(req, [s.publicHostname]) : false;
}

export interface TokenHttpResponse {
  body: Record<string, unknown>;
  /** Set-Cookie value to append (browser clients only). */
  setCookie?: string;
}

/**
 * Response for a freshly issued token pair: browser clients (or a request that
 * authenticated with the cookie) get the refresh token as cookie and only
 * `{ accessToken, expiresIn }` in the body; other clients get the full pair.
 */
export function tokenPairResponse(req: CookieRequestLike, tokens: TokenPair, opts: { viaCookie?: boolean } = {}): TokenHttpResponse {
  if (opts.viaCookie || isWebClient(req.headers)) {
    return {
      body: { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn },
      setCookie: refreshCookieHeader(req, tokens.refreshToken),
    };
  }
  return { body: { ...tokens } };
}
