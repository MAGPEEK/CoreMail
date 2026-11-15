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
 * handshake with an Origin outside the allow-list is only accepted when it carries
 * an explicit access token (query parameter), which a foreign page cannot borrow.
 * Non-browser clients send no Origin and are unaffected.
 */
export function isWsOriginAllowed(origin: string | undefined, allowed: readonly string[], explicitToken: boolean): boolean {
  if (origin === undefined || explicitToken) return true;
  const norm = normalizeOrigin(origin);
  return !!norm && allowed.includes(norm);
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
