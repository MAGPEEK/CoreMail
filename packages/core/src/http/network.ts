/**
 * Network trust helpers (v6 hardening).
 *
 *  parseTrustProxy(env)     — TRUST_PROXY env → value for app.set('trust proxy', …)
 *  isLoopbackAddress(addr)  — loopback check on the RAW socket address
 *  stripForwardedHeaders()  — drop client-supplied X-Forwarded-* / Forwarded
 *  resolveBindHost(env)     — listen address for internal services
 *  requireInternal(opts)    — middleware for /internal/* routes
 */
import { timingSafeEqual, createHash } from 'node:crypto';

export type TrustProxyValue = boolean | number | string[];

/**
 * TRUST_PROXY:
 *   unset / '' / 'false' / '0'   → false (default — req.ip is the socket peer)
 *   'true'                        → true (trust every hop — only behind a proxy that overwrites XFF!)
 *   '1', '2', …                   → number of trusted hops
 *   'loopback, 10.0.0.0/8, ::1'   → list of trusted proxy addresses/CIDRs/named ranges
 *                                   (Express/proxy-addr syntax: loopback | linklocal | uniquelocal)
 */
export function parseTrustProxy(raw: string | undefined): TrustProxyValue {
  const v = (raw ?? '').trim();
  if (v === '' || /^(false|no|off|0)$/i.test(v)) return false;
  if (/^(true|yes|on)$/i.test(v)) return true;
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  const list = v.split(',').map((s) => s.trim()).filter(Boolean);
  for (const entry of list) {
    if (!/^(loopback|linklocal|uniquelocal|[0-9a-fA-F:.]+(\/\d{1,3})?)$/.test(entry)) {
      throw new Error(`Invalid TRUST_PROXY entry "${entry}" (expected true/false, a hop count or a list of IPs/CIDRs/loopback/linklocal/uniquelocal)`);
    }
  }
  return list;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** True for loopback socket addresses (127.0.0.0/8, ::1, IPv4-mapped). */
export function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr) return false;
  if (LOOPBACK.has(addr)) return true;
  const v4 = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

const FORWARDED_HEADERS = ['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-port', 'x-real-ip', 'forwarded'];

/**
 * Set ("1") by the api-gateway on a proxied request when its X-Forwarded-Proto
 * is known — TLS socket, a TRUST_PROXY-trusted proxy, or a direct client
 * without any forwarding header — and absent when an untrusted reverse proxy
 * forwarded it (the scheme the client used is unknown then). Internal services
 * act on a plain-HTTP scheme (e.g. redirect to HTTPS) only when it is set;
 * clients cannot send it (the gateway drops every X-CoreMail-* header).
 */
export const PROTO_VERIFIED_HEADER = 'x-coremail-proto-verified';

/**
 * Remove proxy headers from a request that reached us DIRECTLY from the
 * client (integrated TLS proxy). Whatever TRUST_PROXY says, these headers
 * can only be client-forged on that path.
 */
export function stripForwardedHeaders(req: { headers: Record<string, unknown> }): void {
  for (const h of FORWARDED_HEADERS) delete req.headers[h];
}

/**
 * Listen address for internal HTTP services (auth-service, backup-service,
 * security-filter, EWS, CalDAV, …). Default 127.0.0.1 — they are reached via
 * the api-gateway / other processes in the same container. Multi-host
 * deployments (Kubernetes) set INTERNAL_BIND_HOST=0.0.0.0.
 */
export function resolveBindHost(env: NodeJS.ProcessEnv = process.env): string {
  const v = (env['INTERNAL_BIND_HOST'] ?? '').trim();
  return v || '127.0.0.1';
}

function sha(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

/** Constant-time string comparison (hash-normalised, length-independent). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha(a), sha(b));
}

interface InternalReq {
  socket?: { remoteAddress?: string | undefined } | undefined;
  headers: Record<string, string | string[] | undefined>;
}
interface InternalRes {
  status(code: number): InternalRes;
  json(body: unknown): unknown;
}

/**
 * Guard for service-to-service routes:
 *  - INTERNAL_API_TOKEN set → header `X-Internal-Token` must match (constant time)
 *  - otherwise              → only loopback peers (raw socket address, never XFF)
 */
export function requireInternal(opts: { token?: string | undefined } = {}) {
  const token = opts.token ?? process.env['INTERNAL_API_TOKEN'] ?? '';
  return function internalGuard(req: InternalReq, res: InternalRes, next: () => void): void {
    if (token) {
      const h = req.headers['x-internal-token'];
      const given = Array.isArray(h) ? h[0] : h;
      if (typeof given === 'string' && given.length > 0 && safeEqual(given, token)) { next(); return; }
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    if (isLoopbackAddress(req.socket?.remoteAddress)) { next(); return; }
    res.status(403).json({ error: 'Forbidden' });
  };
}

/** Headers to attach when calling another service's /internal/* route. */
export function internalAuthHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const t = env['INTERNAL_API_TOKEN'];
  return t ? { 'X-Internal-Token': t } : {};
}
