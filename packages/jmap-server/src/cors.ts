/**
 * CORS for /jmap and /.well-known/jmap (RFC 8620 §8.5).
 *
 * Credentialed CORS (cookies / HTTP auth sent by the browser) is only granted
 * to an allow-list: the public origin of this server (ServerSettings
 * publicHostname/useHttps/httpPort) plus JMAP_CORS_ORIGINS (comma-separated).
 * Any other origin gets `Access-Control-Allow-Origin: *` WITHOUT
 * credentials — third-party JMAP web clients that send an explicit
 * `Authorization: Bearer` header keep working, but a foreign page can no
 * longer ride on credentials the browser attaches automatically. Previously
 * every Origin was reflected together with Allow-Credentials: true.
 */
export interface CorsHeaders { [name: string]: string }

/** Canonical origin ("https://host[:port]") or null for garbage / "null". */
export function normalizeOrigin(origin: string | undefined | null): string | null {
  if (!origin || origin === 'null') return null;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}

export function parseOriginList(v: string | undefined): string[] {
  return (v ?? '').split(',').map((s) => normalizeOrigin(s.trim())).filter((s): s is string => !!s);
}

/**
 * WebSocket upgrade (RFC 8887 §8, RFC 6455 §10.2): browsers attach cached HTTP
 * credentials to cross-site WebSocket handshakes and CORS does not apply. A
 * handshake with an Origin outside the allow-list is only accepted when it
 * authenticates with an explicit, non-empty access token in the query AND carries
 * no Authorization header. The login prefers the header, so a foreign page must not
 * be able to add a dummy (or empty) `?access_token=` and ride on the Basic
 * credentials the browser has cached. Browser WebSocket APIs cannot set an
 * Authorization header, so a header on a cross-origin handshake is always an
 * ambient credential. Non-browser clients send no Origin and are unaffected.
 */
export interface WsCredentials {
  /** Raw Authorization header (undefined or empty when absent). */
  authorization?: string | undefined;
  /** `access_token` / `token` query parameter (undefined when absent). */
  queryToken?: string | undefined;
}

export function isWsOriginAllowed(origin: string | undefined, allowed: readonly string[], creds: WsCredentials): boolean {
  if (origin === undefined) return true;
  const norm = normalizeOrigin(origin);
  if (norm && allowed.includes(norm)) return true;
  const hasHeader = (creds.authorization ?? '').trim() !== '';
  const hasToken = (creds.queryToken ?? '').trim() !== '';
  return hasToken && !hasHeader;
}

/** Pure: response headers for a request with `origin`. */
export function corsHeadersFor(origin: string | undefined, allowed: readonly string[]): CorsHeaders {
  const base: CorsHeaders = {
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
  const norm = normalizeOrigin(origin);
  if (norm && allowed.includes(norm)) {
    return { ...base, 'Access-Control-Allow-Origin': norm, 'Access-Control-Allow-Credentials': 'true' };
  }
  return { ...base, 'Access-Control-Allow-Origin': '*' };
}
