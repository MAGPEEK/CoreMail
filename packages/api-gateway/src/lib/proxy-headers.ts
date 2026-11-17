/**
 * Headers the gateway sends to internal services (8.0.x).
 *
 * http-proxy-middleware copies every client header to the upstream request.
 * Internal services trust the gateway's forwarding headers (jmap-server runs
 * with `trust proxy: true` and builds its session URLs from X-Forwarded-Host /
 * -Proto; all services take the client IP from X-Forwarded-For), so whatever
 * the client sent must never reach them. For every proxied request:
 *  - removed: Forwarded, X-Forwarded-*, X-Real-IP, X-Client-IP,
 *    True-Client-IP, CF-Connecting-IP, X-Internal-Token and any X-Internal-* /
 *    X-CoreMail-* / X-User-* / X-Auth-* header (internal identity headers);
 *    exception: X-CoreMail-Client (web) and X-CoreMail-App (bcp|mwa) with a
 *    valid value (v8.1, see CLIENT_HEADER_VALUES)
 *  - set from trusted values: X-Forwarded-For (client IP per TRUST_PROXY),
 *    X-Forwarded-Proto (TLS socket or trusted proxy), X-Forwarded-Host (Host;
 *    a forwarded host only from a trusted proxy), X-CoreMail-Proto-Verified
 *    when that scheme is known (not behind an untrusted reverse proxy)
 */
import type { IncomingMessage, IncomingHttpHeaders, ClientRequest } from 'node:http';
import { PROTO_VERIFIED_HEADER } from '@coremail/core';

export type TrustFn = (addr: string, i: number) => boolean;

/** Does the request carry a forwarding header (X-Forwarded-*, Forwarded)? */
export function hasForwardingHeader(req: { headers: IncomingHttpHeaders }): boolean {
  return Object.keys(req.headers).some((h) => h === 'forwarded' || h.startsWith('x-forwarded-'));
}

/**
 * Is the scheme of upstreamProto() known? Yes for a TLS socket, a trusted
 * proxy and a direct client; no when an untrusted peer sent forwarding headers
 * (a reverse proxy without TRUST_PROXY — "http" is only a guess then).
 */
export function upstreamProtoVerified(req: IncomingMessage, trust: TrustFn): boolean {
  if ((req.socket as { encrypted?: boolean } | undefined)?.encrypted) return true;
  return trust(req.socket?.remoteAddress ?? '', 0) || !hasForwardingHeader(req);
}

const DROP_EXACT = new Set([
  'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port',
  'x-forwarded-prefix', 'x-forwarded-server', 'x-forwarded-ssl', 'x-real-ip', 'x-client-ip',
  'true-client-ip', 'cf-connecting-ip', 'x-original-forwarded-for', 'x-internal-token',
]);
const DROP_PREFIX = ['x-internal-', 'x-coremail-', 'x-user-', 'x-auth-'];

export function isUntrustedForwardingHeader(name: string): boolean {
  const n = name.toLowerCase();
  return DROP_EXACT.has(n) || n.startsWith('x-forwarded-') || DROP_PREFIX.some((p) => n.startsWith(p));
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s?.split(',')[0]?.trim() || undefined;
}

/**
 * Client IP: Express requests use req.ip (TRUST_PROXY-aware); raw upgrade
 * requests are resolved with the same trust function.
 */
export function upstreamClientIp(req: IncomingMessage, trust: TrustFn): string {
  const ip = (req as IncomingMessage & { ip?: string }).ip;
  if (typeof ip === 'string' && ip) return ip;
  const raw = req.headers['x-forwarded-for'];
  const hops = (Array.isArray(raw) ? raw.join(',') : (raw ?? ''))
    .split(',').map((h) => h.trim()).filter(Boolean).reverse();
  const addrs = [req.socket?.remoteAddress ?? '', ...hops];
  for (let i = 0; i < addrs.length - 1; i++) {
    if (!trust(addrs[i]!, i)) return addrs[i]!;
  }
  return addrs[addrs.length - 1]!;
}

/** Was the client connection HTTPS? (TLS socket, or X-Forwarded-Proto from a trusted peer.) */
export function upstreamProto(req: IncomingMessage, trust: TrustFn): 'http' | 'https' {
  if ((req.socket as { encrypted?: boolean } | undefined)?.encrypted) return 'https';
  if (trust(req.socket?.remoteAddress ?? '', 0)) {
    const p = firstHeader(req.headers['x-forwarded-proto'])?.toLowerCase();
    if (p === 'https' || p === 'http') return p;
  }
  return 'http';
}

/** Host the client asked for (a forwarded host only from a trusted peer). */
export function upstreamHost(req: IncomingMessage, trust: TrustFn): string | undefined {
  const fwd = trust(req.socket?.remoteAddress ?? '', 0) ? firstHeader(req.headers['x-forwarded-host']) : undefined;
  const host = fwd ?? firstHeader(req.headers['host']);
  return host && /^[A-Za-z0-9.\-:[\]]{1,255}$/.test(host) ? host : undefined;
}

/**
 * v8.1: the two X-CoreMail-* headers a browser frontend sets itself pass the
 * proxy — but only with a known value. `X-CoreMail-Client: web` makes the
 * auth-service (e.g. /auth/mfa/verify) return the refresh token as HttpOnly
 * cookie instead of in the JSON body; `X-CoreMail-App` selects the MWA/BCP cookie.
 * Every other X-CoreMail-* header is still dropped.
 */
const CLIENT_HEADER_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  'x-coremail-client': new Set(['web']),
  'x-coremail-app': new Set(['bcp', 'mwa']),
};

/** Validated value of an allow-listed client header (lower-cased), or undefined. */
export function allowedClientHeader(name: string, value: string | string[] | undefined): string | undefined {
  const allowed = CLIENT_HEADER_VALUES[name.toLowerCase()];
  if (!allowed || value === undefined) return undefined;
  const v = (Array.isArray(value) ? value[0] : value)?.trim().toLowerCase();
  return v && allowed.has(v) ? v : undefined;
}

/** Rewrites the forwarding headers of a proxied request (see module comment). */
export function applyUpstreamHeaders(proxyReq: ClientRequest, req: IncomingMessage, trust: TrustFn): void {
  // compute from the ORIGINAL request headers before anything is removed
  const ip = upstreamClientIp(req, trust);
  const proto = upstreamProto(req, trust);
  const protoVerified = upstreamProtoVerified(req, trust);
  const host = upstreamHost(req, trust);
  for (const name of proxyReq.getHeaderNames()) {
    if (isUntrustedForwardingHeader(name)) proxyReq.removeHeader(name);
  }
  for (const name of Object.keys(CLIENT_HEADER_VALUES)) {
    const v = allowedClientHeader(name, req.headers[name]);
    if (v) proxyReq.setHeader(name, v);
  }
  proxyReq.setHeader('X-Forwarded-For', ip);
  proxyReq.setHeader('X-Forwarded-Proto', proto);
  if (protoVerified) proxyReq.setHeader(PROTO_VERIFIED_HEADER, '1');
  if (host) proxyReq.setHeader('X-Forwarded-Host', host);
}
