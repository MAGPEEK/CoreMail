/**
 * 10.5: connection hardening of the gateway's HTTP servers (port 3000 and the
 * integrated HTTPS proxy) against slowloris, slow POST and idle-connection
 * floods. docs/api-gateway-security.md "Connection limits and timeouts".
 *
 *   HTTP_HEADERS_TIMEOUT_MS            (20000)   complete request headers within this time
 *   HTTP_REQUEST_TIMEOUT_MS            (300000)  complete request (headers + body) within this
 *                                                time; 0 = off. Only bounds RECEIVING the request:
 *                                                long responses (SSE, EAS Ping, MAPI
 *                                                NotificationWait, JMAP EventSource) are not
 *                                                affected, WebSocket upgrades leave the HTTP parser.
 *   HTTP_KEEPALIVE_TIMEOUT_MS          (5000)    idle keep-alive connection between requests
 *   HTTP_MAX_REQUESTS_PER_SOCKET       (0)       requests per keep-alive connection; 0 = unlimited
 *   HTTP_CONNECTIONS_CHECK_INTERVAL_MS (5000)    how often header/request deadlines are checked
 *   HTTP_MAX_CONNS                     (4000)    open connections, HTTP + HTTPS together; 0 = off
 *   HTTP_MAX_CONNS_PER_IP              (300)     open connections per client IP (IPv6: per /64); 0 = off
 *   HTTP_CONN_EXEMPT_CIDRS             (empty)   IPs/CIDRs without the per-IP cap (loopback always)
 *   HTTPS_HANDSHAKE_TIMEOUT_MS         (10000)   TLS handshake of the HTTPS proxy
 *
 * The per-IP cap is counted on the raw TCP socket, before TLS. On port 3000 a
 * peer that TRUST_PROXY trusts (a reverse proxy — every client shares its
 * address) is not subject to the per-IP cap; the global cap still applies.
 * Loopback (container healthcheck, CLI) is exempt from both caps.
 */
import type http from 'node:http';
import type https from 'node:https';
import type net from 'node:net';
import { isIP } from 'node:net';
import { createLogger } from '@coremail/core';
import { createExemptIpMatcher, normalizeIp, isLoopbackIp } from '@coremail/storage';

const log = createLogger('http-hardening');

// ── Configuration ─────────────────────────────────────────────────────────────

export interface HttpHardeningConfig {
  headersTimeoutMs: number;
  requestTimeoutMs: number;
  keepAliveTimeoutMs: number;
  maxRequestsPerSocket: number;
  connectionsCheckingIntervalMs: number;
  maxConnections: number;
  maxConnectionsPerIp: number;
  exemptCidrs: string;
  tlsHandshakeTimeoutMs: number;
}

export const HTTP_HARDENING_DEFAULTS: Readonly<HttpHardeningConfig> = Object.freeze({
  headersTimeoutMs: 20_000,
  requestTimeoutMs: 300_000,
  keepAliveTimeoutMs: 5_000,
  maxRequestsPerSocket: 0,
  connectionsCheckingIntervalMs: 5_000,
  maxConnections: 4_000,
  maxConnectionsPerIp: 300,
  exemptCidrs: '',
  tlsHandshakeTimeoutMs: 10_000,
});

/** Integer env value >= min, otherwise the default (with a warning for a set but invalid value). */
function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, warnings: string[]): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < min) {
    warnings.push(`${name}="${raw}" is invalid (integer >= ${min} expected) — using ${fallback}`);
    return fallback;
  }
  return n;
}

/**
 * Reads the configuration from the environment. Invalid values fall back to
 * the default; inconsistent timeouts are corrected (headers > keep-alive,
 * request >= headers — Node refuses a requestTimeout below headersTimeout).
 */
export function loadHttpHardeningConfig(env: NodeJS.ProcessEnv = process.env): { config: HttpHardeningConfig; warnings: string[] } {
  const d = HTTP_HARDENING_DEFAULTS;
  const warnings: string[] = [];
  const config: HttpHardeningConfig = {
    headersTimeoutMs: readInt(env, 'HTTP_HEADERS_TIMEOUT_MS', d.headersTimeoutMs, 1_000, warnings),
    requestTimeoutMs: readInt(env, 'HTTP_REQUEST_TIMEOUT_MS', d.requestTimeoutMs, 0, warnings),
    keepAliveTimeoutMs: readInt(env, 'HTTP_KEEPALIVE_TIMEOUT_MS', d.keepAliveTimeoutMs, 1, warnings),
    maxRequestsPerSocket: readInt(env, 'HTTP_MAX_REQUESTS_PER_SOCKET', d.maxRequestsPerSocket, 0, warnings),
    connectionsCheckingIntervalMs: readInt(env, 'HTTP_CONNECTIONS_CHECK_INTERVAL_MS', d.connectionsCheckingIntervalMs, 100, warnings),
    maxConnections: readInt(env, 'HTTP_MAX_CONNS', d.maxConnections, 0, warnings),
    maxConnectionsPerIp: readInt(env, 'HTTP_MAX_CONNS_PER_IP', d.maxConnectionsPerIp, 0, warnings),
    exemptCidrs: (env['HTTP_CONN_EXEMPT_CIDRS'] ?? '').trim(),
    tlsHandshakeTimeoutMs: readInt(env, 'HTTPS_HANDSHAKE_TIMEOUT_MS', d.tlsHandshakeTimeoutMs, 1_000, warnings),
  };
  return { config: normalizeTimeouts(config, warnings), warnings };
}

/** headersTimeout > keepAliveTimeout, and requestTimeout (when on) >= headersTimeout. */
export function normalizeTimeouts(cfg: HttpHardeningConfig, warnings: string[] = []): HttpHardeningConfig {
  const out = { ...cfg };
  if (out.headersTimeoutMs <= out.keepAliveTimeoutMs) {
    const fixed = out.keepAliveTimeoutMs + 1_000;
    warnings.push(`HTTP_HEADERS_TIMEOUT_MS (${out.headersTimeoutMs}) must exceed HTTP_KEEPALIVE_TIMEOUT_MS (${out.keepAliveTimeoutMs}) — using ${fixed}`);
    out.headersTimeoutMs = fixed;
  }
  if (out.requestTimeoutMs > 0 && out.requestTimeoutMs < out.headersTimeoutMs) {
    warnings.push(`HTTP_REQUEST_TIMEOUT_MS (${out.requestTimeoutMs}) is below HTTP_HEADERS_TIMEOUT_MS — using ${out.headersTimeoutMs}`);
    out.requestTimeoutMs = out.headersTimeoutMs;
  }
  return out;
}

/** Options for http.createServer / https.createServer (the deadline checker can only be set here). */
export function httpServerOptions(cfg: HttpHardeningConfig): http.ServerOptions {
  return {
    headersTimeout: cfg.headersTimeoutMs,
    requestTimeout: cfg.requestTimeoutMs,
    connectionsCheckingInterval: cfg.connectionsCheckingIntervalMs,
    keepAliveTimeout: cfg.keepAliveTimeoutMs,
  } as http.ServerOptions;
}

/** Additional options for the HTTPS proxy. */
export function httpsServerOptions(cfg: HttpHardeningConfig): https.ServerOptions {
  return { ...httpServerOptions(cfg), handshakeTimeout: cfg.tlsHandshakeTimeoutMs } as https.ServerOptions;
}

/**
 * Sets the timeouts on a created server (properties are read per check, so
 * this also covers Node versions without the keepAliveTimeout option).
 * `server.timeout` (socket inactivity) stays 0: SSE heartbeats every 25 s and
 * an ActiveSync Ping that is silent for up to 59 minutes must not be cut.
 */
export function applyServerTimeouts(server: http.Server, cfg: HttpHardeningConfig): void {
  server.headersTimeout = cfg.headersTimeoutMs;
  server.requestTimeout = cfg.requestTimeoutMs;
  server.keepAliveTimeout = cfg.keepAliveTimeoutMs;
  server.maxRequestsPerSocket = cfg.maxRequestsPerSocket;
  server.timeout = 0;
}

// ── Per-IP / global connection cap ────────────────────────────────────────────

/** Expands an IPv6 address to 8 hextets (no zone, no embedded IPv4 handling beyond the last 32 bits). */
function expandIpv6(ip: string): string[] | null {
  let v = ip;
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    v = v.slice(0, v4.index) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const halves = v.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const parts = [...head, ...Array<string>(fill).fill('0'), ...tail];
  return parts.length === 8 ? parts.map((p) => parseInt(p || '0', 16).toString(16)) : null;
}

/**
 * The key a connection is counted under: the IPv4 address, or the /64 prefix
 * of an IPv6 address (one subscriber usually owns a whole /64, so per-address
 * counting would be trivial to evade).
 */
export function connectionKey(rawIp: string | null | undefined): string {
  const ip = normalizeIp(rawIp);
  if (isIP(ip) !== 6) return ip;
  const parts = expandIpv6(ip.toLowerCase());
  return parts ? `${parts.slice(0, 4).join(':')}::/64` : ip;
}

export interface GuardOptions {
  maxPerIp: number;
  maxTotal: number;
  /** IPs without the per-IP cap (they count towards the total). */
  isExempt: (ip: string) => boolean;
  /** IPs that bypass BOTH caps (default: loopback — healthcheck, CLI). */
  bypassAll?: (ip: string) => boolean;
  /** Rate limit of the refusal log line per key + reason (default 60 s). */
  logWindowMs?: number;
  now?: () => number;
  onRefused?: (info: RefusalInfo) => void;
}

export interface RefusalInfo { ip: string; key: string; reason: 'per_ip' | 'total'; limit: number; suppressed: number; server: string }

export type AdmitResult =
  | { ok: true; release: () => void }
  | { ok: false; reason: 'per_ip' | 'total'; limit: number };

export type ServerKind = 'http' | 'https';

const REFUSED_HTTP_RESPONSE =
  'HTTP/1.1 503 Service Unavailable\r\n' +
  'Retry-After: 10\r\n' +
  'Connection: close\r\n' +
  'Content-Type: text/plain\r\n' +
  'Content-Length: 21\r\n' +
  '\r\n' +
  'Too many connections\n';

/**
 * Counts open connections per key (IPv4 / IPv6 /64) and in total, shared by
 * the HTTP server and the HTTPS proxy.
 */
export class HttpConnectionGuard {
  private readonly perKey = new Map<string, number>();
  private open = 0;
  private readonly refused = new WeakSet<net.Socket>();
  private readonly lastLog = new Map<string, { at: number; suppressed: number }>();

  constructor(private readonly opts: GuardOptions) {}

  /** Open connections in total, or for one IP (its /64 for IPv6). */
  count(ip?: string): number {
    return ip === undefined ? this.open : this.perKey.get(connectionKey(ip)) ?? 0;
  }

  /**
   * Reserves a slot for a connection from `rawIp`. `perIpApplies` is false
   * for a TRUST_PROXY-trusted reverse proxy peer.
   */
  acquire(rawIp: string | null | undefined, perIpApplies = true): AdmitResult {
    const ip = normalizeIp(rawIp);
    const key = connectionKey(ip);
    const bypass = !ip || (this.opts.bypassAll ?? isLoopbackIp)(ip);
    if (!bypass) {
      if (this.opts.maxTotal > 0 && this.open >= this.opts.maxTotal) return { ok: false, reason: 'total', limit: this.opts.maxTotal };
      const current = this.perKey.get(key) ?? 0;
      if (perIpApplies && this.opts.maxPerIp > 0 && current >= this.opts.maxPerIp && !this.opts.isExempt(ip)) {
        return { ok: false, reason: 'per_ip', limit: this.opts.maxPerIp };
      }
    }
    this.open++;
    this.perKey.set(key, (this.perKey.get(key) ?? 0) + 1);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.open = Math.max(0, this.open - 1);
        const n = (this.perKey.get(key) ?? 1) - 1;
        if (n <= 0) this.perKey.delete(key);
        else this.perKey.set(key, n);
      },
    };
  }

  /** True for a plain-HTTP socket that was answered with 503 (its requests are dropped). */
  isRefused(socket: net.Socket | null | undefined): boolean {
    return !!socket && this.refused.has(socket);
  }

  /**
   * Admission check for a new raw TCP connection. Over the cap a plain-HTTP
   * connection gets a minimal 503 and is closed; an HTTPS connection is
   * destroyed before the TLS handshake. The slot is released on 'close'.
   */
  admit(socket: net.Socket, kind: ServerKind, perIpApplies: boolean): boolean {
    const result = this.acquire(socket.remoteAddress, perIpApplies);
    if (result.ok) {
      socket.once('close', result.release);
      return true;
    }
    this.logRefusal(socket.remoteAddress ?? '', result.reason, result.limit, kind);
    if (kind === 'https') {
      socket.destroy();
    } else {
      this.refused.add(socket);
      socket.on('error', () => undefined);
      socket.end(REFUSED_HTTP_RESPONSE);
      setTimeout(() => socket.destroy(), 2_000).unref();
    }
    return false;
  }

  private logRefusal(rawIp: string, reason: 'per_ip' | 'total', limit: number, kind: ServerKind): void {
    const ip = normalizeIp(rawIp);
    const key = connectionKey(ip);
    const now = (this.opts.now ?? Date.now)();
    const window = this.opts.logWindowMs ?? 60_000;
    const id = `${reason}|${reason === 'total' ? '*' : key}`;
    const entry = this.lastLog.get(id);
    if (entry && now - entry.at < window) { entry.suppressed++; return; }
    if (this.lastLog.size > 10_000) this.lastLog.clear();
    const info: RefusalInfo = { ip, key, reason, limit, suppressed: entry?.suppressed ?? 0, server: kind };
    this.lastLog.set(id, { at: now, suppressed: 0 });
    if (this.opts.onRefused) this.opts.onRefused(info);
    else log.warn(info, 'HTTP connection refused — connection limit reached');
  }
}

export function createHttpConnectionGuard(cfg: HttpHardeningConfig, extra: Partial<GuardOptions> = {}): { guard: HttpConnectionGuard; invalidExempt: string[] } {
  const exempt = createExemptIpMatcher(cfg.exemptCidrs);
  const guard = new HttpConnectionGuard({
    maxPerIp: cfg.maxConnectionsPerIp,
    maxTotal: cfg.maxConnections,
    isExempt: exempt.isExempt,
    ...extra,
  });
  return { guard, invalidExempt: exempt.invalid };
}

// ── Wiring ────────────────────────────────────────────────────────────────────

export interface HardenOptions {
  kind: ServerKind;
  guard: HttpConnectionGuard;
  config: HttpHardeningConfig;
  /** Port 3000 only: socket peers TRUST_PROXY trusts are not subject to the per-IP cap. */
  isTrustedProxyPeer?: (ip: string) => boolean;
}

/**
 * Applies the timeouts and the connection cap to a server. The admission
 * listener runs BEFORE Node's own connection listener (prepend), i.e. on the
 * raw TCP socket and — for HTTPS — before the TLS handshake.
 */
export function hardenHttpServer(server: http.Server | https.Server, opts: HardenOptions): void {
  applyServerTimeouts(server, opts.config);
  server.prependListener('connection', (socket: net.Socket) => {
    const peer = normalizeIp(socket.remoteAddress);
    const perIpApplies = !(opts.isTrustedProxyPeer && peer && opts.isTrustedProxyPeer(peer));
    opts.guard.admit(socket, opts.kind, perIpApplies);
  });
}

/** Wraps a request handler so requests on a refused (503) socket are dropped. */
export function guardedRequestHandler(
  guard: HttpConnectionGuard,
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (req, res) => {
    if (guard.isRefused(req.socket)) { req.socket.destroy(); return; }
    handler(req, res);
  };
}

// ── Process-wide instance (HTTP server + HTTPS proxy share one guard) ───────

let shared: { config: HttpHardeningConfig; guard: HttpConnectionGuard } | null = null;

/** Configuration + shared guard from the environment (created once, warnings logged once). */
export function httpHardening(): { config: HttpHardeningConfig; guard: HttpConnectionGuard } {
  if (shared) return shared;
  const { config, warnings } = loadHttpHardeningConfig();
  for (const w of warnings) log.warn(w);
  const { guard, invalidExempt } = createHttpConnectionGuard(config);
  if (invalidExempt.length) log.warn({ invalid: invalidExempt }, 'HTTP_CONN_EXEMPT_CIDRS: invalid entries ignored');
  log.info({ ...config, exemptCidrs: config.exemptCidrs || undefined }, 'HTTP connection hardening active');
  shared = { config, guard };
  return shared;
}
