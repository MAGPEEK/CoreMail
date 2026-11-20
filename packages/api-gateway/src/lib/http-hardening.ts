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
 *   10.5 review:
 *   HTTP_MAX_CONNS_PER_V6_56           (600)     open connections per IPv6 /56 (all its /64s together); 0 = off
 *   HTTP_MAX_CONNS_PER_V6_48           (1200)    open connections per IPv6 /48; 0 = off
 *   HTTP_CONN_RESERVE_PERCENT          (20)      the last N % of HTTP_MAX_CONNS are kept for light clients:
 *                                                above (100-N) % a new connection is refused when its
 *                                                IPv4 address / IPv6 /48 already holds HTTP_CONN_HEAVY_THRESHOLD
 *                                                connections (heaviest first); 0 = off
 *   HTTP_CONN_HEAVY_THRESHOLD          (16)      "heavy" in that sense
 *   HTTP_WRITE_STALL_TIMEOUT_MS        (60000)   a connection whose queued response bytes have not moved
 *                                                for this long (a client that stopped reading) is closed;
 *                                                0 = off. Idle connections (SSE between heartbeats, EAS Ping,
 *                                                MAPI NotificationWait) have nothing queued and are not affected.
 *
 * The per-IP cap is counted on the raw TCP socket, before TLS. On port 3000 a
 * peer that TRUST_PROXY trusts (a reverse proxy — every client shares its
 * address) is not subject to the per-IP / prefix caps nor the reserve; the
 * global cap still applies. Loopback (container healthcheck, CLI) is exempt
 * from all caps. HTTP_CONN_EXEMPT_CIDRS skip the per-IP / prefix caps and the reserve.
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
  /** 10.5 review: IPv6 aggregate caps (0 = off). */
  maxConnectionsPerV6_56: number;
  maxConnectionsPerV6_48: number;
  /** 10.5 review: share of maxConnections kept for light clients (0 = off). */
  reservePercent: number;
  heavyThreshold: number;
  /** 10.5 review: queued response bytes that do not move for this long close the connection (0 = off). */
  writeStallTimeoutMs: number;
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
  maxConnectionsPerV6_56: 600,
  maxConnectionsPerV6_48: 1_200,
  reservePercent: 20,
  heavyThreshold: 16,
  writeStallTimeoutMs: 60_000,
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
    maxConnectionsPerV6_56: readInt(env, 'HTTP_MAX_CONNS_PER_V6_56', d.maxConnectionsPerV6_56, 0, warnings),
    maxConnectionsPerV6_48: readInt(env, 'HTTP_MAX_CONNS_PER_V6_48', d.maxConnectionsPerV6_48, 0, warnings),
    reservePercent: readInt(env, 'HTTP_CONN_RESERVE_PERCENT', d.reservePercent, 0, warnings),
    heavyThreshold: readInt(env, 'HTTP_CONN_HEAVY_THRESHOLD', d.heavyThreshold, 1, warnings),
    writeStallTimeoutMs: readInt(env, 'HTTP_WRITE_STALL_TIMEOUT_MS', d.writeStallTimeoutMs, 0, warnings),
  };
  if (config.reservePercent > 90) {
    warnings.push(`HTTP_CONN_RESERVE_PERCENT="${config.reservePercent}" is too high (0–90) — using 90`);
    config.reservePercent = 90;
  }
  if (config.writeStallTimeoutMs > 0 && config.writeStallTimeoutMs < 1_000) {
    warnings.push(`HTTP_WRITE_STALL_TIMEOUT_MS="${config.writeStallTimeoutMs}" is too short (≥ 1000 or 0) — using 1000`);
    config.writeStallTimeoutMs = 1_000;
  }
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

/**
 * 10.5 review: the IPv6 aggregate a connection also counts under — the /56 or
 * /48 prefix text; null for IPv4 (and anything that is not IPv6).
 */
export function ipv6PrefixKey(rawIp: string | null | undefined, bits: 48 | 56): string | null {
  const ip = normalizeIp(rawIp);
  if (isIP(ip) !== 6) return null;
  const parts = expandIpv6(ip.toLowerCase());
  if (!parts) return null;
  if (bits === 48) return `${parts.slice(0, 3).join(':')}::/48`;
  const fourth = (parseInt(parts[3]!, 16) & 0xff00).toString(16);
  return `${parts.slice(0, 3).join(':')}:${fourth}::/56`;
}

export interface GuardOptions {
  maxPerIp: number;
  maxTotal: number;
  /** 10.5 review: open connections per IPv6 /56 and /48 (0 / absent = no cap). */
  maxPerV6_56?: number;
  maxPerV6_48?: number;
  /**
   * 10.5 review: above this many open connections (the reserve of maxTotal) a
   * new connection is admitted only from a key (IPv4 address, IPv6 /48) that
   * holds fewer than `heavyThreshold` connections; 0 / absent = off.
   */
  softTotal?: number;
  heavyThreshold?: number;
  /** IPs without the per-IP / prefix caps and the reserve (they count towards the total). */
  isExempt: (ip: string) => boolean;
  /** IPs that bypass BOTH caps (default: loopback — healthcheck, CLI). */
  bypassAll?: (ip: string) => boolean;
  /** Rate limit of the refusal log line per key + reason (default 60 s). */
  logWindowMs?: number;
  now?: () => number;
  onRefused?: (info: RefusalInfo) => void;
}

/**
 * per_ip = the address / IPv6 /64 cap, per_prefix = an IPv6 /56 or /48 cap,
 * total = the global cap, reserve = near the global cap a heavy key is refused
 * to keep headroom for light clients (10.5 review).
 */
export type RefusalReason = 'per_ip' | 'per_prefix' | 'total' | 'reserve';

export interface RefusalInfo { ip: string; key: string; reason: RefusalReason; limit: number; suppressed: number; server: string }

export type AdmitResult =
  | { ok: true; release: () => void }
  | { ok: false; reason: RefusalReason; limit: number; key?: string };

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
  /** 10.5 review: IPv6 /56 and /48 aggregates (keys carry their prefix length). */
  private readonly perPrefix = new Map<string, number>();
  private open = 0;
  private readonly refused = new WeakSet<net.Socket>();
  private readonly lastLog = new Map<string, { at: number; suppressed: number }>();

  constructor(private readonly opts: GuardOptions) {}

  /** Open connections in total, or for one IP (its /64 for IPv6). */
  count(ip?: string): number {
    return ip === undefined ? this.open : this.perKey.get(connectionKey(ip)) ?? 0;
  }

  /** 10.5 review: open connections of an IPv6 prefix (`ipv6PrefixKey` text), 0 when unknown. */
  prefixCount(prefixKey: string): number {
    return this.perPrefix.get(prefixKey) ?? 0;
  }

  /**
   * Reserves a slot for a connection from `rawIp`. `perIpApplies` is false
   * for a TRUST_PROXY-trusted reverse proxy peer.
   */
  acquire(rawIp: string | null | undefined, perIpApplies = true): AdmitResult {
    const ip = normalizeIp(rawIp);
    const key = connectionKey(ip);
    const k56 = ipv6PrefixKey(ip, 56);
    const k48 = ipv6PrefixKey(ip, 48);
    const bypass = !ip || (this.opts.bypassAll ?? isLoopbackIp)(ip);
    if (!bypass) {
      if (this.opts.maxTotal > 0 && this.open >= this.opts.maxTotal) return { ok: false, reason: 'total', limit: this.opts.maxTotal };
      const current = this.perKey.get(key) ?? 0;
      if (perIpApplies && !this.opts.isExempt(ip)) {
        if (this.opts.maxPerIp > 0 && current >= this.opts.maxPerIp) {
          return { ok: false, reason: 'per_ip', limit: this.opts.maxPerIp };
        }
        // 10.5 review: a subscriber owning a /56 or /48 must not get 256 / 65536 per-/64 budgets
        const max56 = this.opts.maxPerV6_56 ?? 0;
        if (k56 && max56 > 0 && (this.perPrefix.get(k56) ?? 0) >= max56) return { ok: false, reason: 'per_prefix', limit: max56, key: k56 };
        const max48 = this.opts.maxPerV6_48 ?? 0;
        if (k48 && max48 > 0 && (this.perPrefix.get(k48) ?? 0) >= max48) return { ok: false, reason: 'per_prefix', limit: max48, key: k48 };
        // 10.5 review: near the global cap the heaviest sources are refused first (headroom for light clients)
        const soft = this.opts.softTotal ?? 0;
        const heavy = this.opts.heavyThreshold ?? 0;
        if (soft > 0 && heavy > 0 && this.open >= soft) {
          const heaviness = k48 ? (this.perPrefix.get(k48) ?? 0) : current;
          if (heaviness >= heavy) return { ok: false, reason: 'reserve', limit: soft, key: k48 ?? key };
        }
      }
    }
    this.open++;
    this.perKey.set(key, (this.perKey.get(key) ?? 0) + 1);
    for (const k of [k56, k48]) if (k) this.perPrefix.set(k, (this.perPrefix.get(k) ?? 0) + 1);
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
        for (const k of [k56, k48]) {
          if (!k) continue;
          const m = (this.perPrefix.get(k) ?? 1) - 1;
          if (m <= 0) this.perPrefix.delete(k);
          else this.perPrefix.set(k, m);
        }
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
    this.logRefusal(socket.remoteAddress ?? '', result.reason, result.limit, kind, result.key);
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

  private logRefusal(rawIp: string, reason: RefusalReason, limit: number, kind: ServerKind, prefixKey?: string): void {
    const ip = normalizeIp(rawIp);
    const key = prefixKey ?? connectionKey(ip);
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

/** 10.5 review: where the reserve starts (0 = no reserve). */
export function softTotalOf(cfg: Pick<HttpHardeningConfig, 'maxConnections' | 'reservePercent'>): number {
  if (cfg.maxConnections <= 0 || cfg.reservePercent <= 0) return 0;
  return Math.max(1, Math.floor(cfg.maxConnections * (100 - cfg.reservePercent) / 100));
}

export function createHttpConnectionGuard(cfg: HttpHardeningConfig, extra: Partial<GuardOptions> = {}): { guard: HttpConnectionGuard; invalidExempt: string[] } {
  const exempt = createExemptIpMatcher(cfg.exemptCidrs);
  const guard = new HttpConnectionGuard({
    maxPerIp: cfg.maxConnectionsPerIp,
    maxTotal: cfg.maxConnections,
    maxPerV6_56: cfg.maxConnectionsPerV6_56,
    maxPerV6_48: cfg.maxConnectionsPerV6_48,
    softTotal: softTotalOf(cfg),
    heavyThreshold: cfg.heavyThreshold,
    isExempt: exempt.isExempt,
    ...extra,
  });
  return { guard, invalidExempt: exempt.invalid };
}

// ── Write stall (slow readers) ────────────────────────────────────────────────

/** The part of a socket the stall watcher reads. */
export interface StallSocket {
  readonly writableLength: number;
  readonly bytesWritten: number;
  readonly destroyed: boolean;
  destroy(): void;
}

/**
 * 10.5 review: closes connections whose client stopped reading. A socket is
 * stalled while it has queued response bytes (writableLength > 0) and none of
 * them moved on to the kernel since the last sample (bytesWritten −
 * writableLength unchanged); after `timeoutMs` of that it is destroyed.
 * Connections with nothing queued — an SSE stream between heartbeats, a silent
 * EAS Ping or MAPI NotificationWait — are never stalled, and every byte the
 * client reads restarts the clock (a slow but reading client is kept).
 */
export class WriteStallWatcher {
  private readonly sockets = new Map<StallSocket, { delivered: number; since: number | null }>();

  constructor(
    private readonly timeoutMs: number,
    private readonly now: () => number = Date.now,
    private readonly onStall?: (s: StallSocket) => void,
  ) {}

  get size(): number { return this.sockets.size; }

  watch(socket: StallSocket & { once(event: 'close', fn: () => void): unknown }): void {
    if (this.timeoutMs <= 0) return;
    this.sockets.set(socket, { delivered: -1, since: null });
    socket.once('close', () => { this.sockets.delete(socket); });
  }

  /** One sample of every watched socket; returns how many were closed. */
  sweep(): number {
    const now = this.now();
    let closed = 0;
    for (const [s, st] of this.sockets) {
      if (s.destroyed) { this.sockets.delete(s); continue; }
      const pending = s.writableLength;
      const delivered = s.bytesWritten - pending;
      if (pending <= 0 || delivered !== st.delivered) {
        st.delivered = delivered;
        st.since = pending > 0 ? now : null;
        continue;
      }
      st.since ??= now;
      if (now - st.since >= this.timeoutMs) {
        this.sockets.delete(s);
        closed++;
        this.onStall?.(s);
        s.destroy();
      }
    }
    return closed;
  }
}

// ── Wiring ────────────────────────────────────────────────────────────────────

export interface HardenOptions {
  kind: ServerKind;
  guard: HttpConnectionGuard;
  config: HttpHardeningConfig;
  /** Port 3000 only: socket peers TRUST_PROXY trusts are not subject to the per-IP cap. */
  isTrustedProxyPeer?: (ip: string) => boolean;
  /** 10.5 review: the slow-reader watcher (default: none). */
  stallWatcher?: WriteStallWatcher | undefined;
}

/**
 * Applies the timeouts and the connection cap to a server. The admission
 * listener runs BEFORE Node's own connection listener (prepend), i.e. on the
 * raw TCP socket and — for HTTPS — before the TLS handshake. 10.5 review: the
 * socket the HTTP parser writes to (plain: the TCP socket, HTTPS: the TLS
 * socket) is watched for a write stall.
 */
export function hardenHttpServer(server: http.Server | https.Server, opts: HardenOptions): void {
  applyServerTimeouts(server, opts.config);
  server.prependListener('connection', (socket: net.Socket) => {
    const peer = normalizeIp(socket.remoteAddress);
    const perIpApplies = !(opts.isTrustedProxyPeer && peer && opts.isTrustedProxyPeer(peer));
    const admitted = opts.guard.admit(socket, opts.kind, perIpApplies);
    if (admitted && opts.kind === 'http') opts.stallWatcher?.watch(socket);
  });
  if (opts.kind === 'https' && opts.stallWatcher) {
    const watcher = opts.stallWatcher;
    server.on('secureConnection', (socket: net.Socket) => watcher.watch(socket));
  }
}

/** 10.5 review: a watcher that samples every min(timeout/4, 5 s) (timer unref'd); null when off. */
export function startWriteStallWatcher(timeoutMs: number, onStall?: (s: StallSocket) => void): WriteStallWatcher | null {
  if (timeoutMs <= 0) return null;
  const watcher = new WriteStallWatcher(timeoutMs, Date.now, onStall);
  const timer = setInterval(() => { watcher.sweep(); }, Math.max(50, Math.min(5_000, Math.floor(timeoutMs / 4))));
  timer.unref();
  return watcher;
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

let shared: { config: HttpHardeningConfig; guard: HttpConnectionGuard; stallWatcher: WriteStallWatcher | undefined } | null = null;

/** Configuration + shared guard (+ slow-reader watcher) from the environment (created once, warnings logged once). */
export function httpHardening(): { config: HttpHardeningConfig; guard: HttpConnectionGuard; stallWatcher: WriteStallWatcher | undefined } {
  if (shared) return shared;
  const { config, warnings } = loadHttpHardeningConfig();
  for (const w of warnings) log.warn(w);
  const { guard, invalidExempt } = createHttpConnectionGuard(config);
  if (invalidExempt.length) log.warn({ invalid: invalidExempt }, 'HTTP_CONN_EXEMPT_CIDRS: invalid entries ignored');
  let stalls = 0;
  let lastStallLog = 0;
  const stallWatcher = startWriteStallWatcher(config.writeStallTimeoutMs, () => {
    stalls++;
    const now = Date.now();
    if (now - lastStallLog < 60_000) return;
    lastStallLog = now;
    log.warn({ closed: stalls, timeoutMs: config.writeStallTimeoutMs }, 'HTTP connections closed — the client stopped reading the response (write stall)');
    stalls = 0;
  }) ?? undefined;
  log.info({ ...config, exemptCidrs: config.exemptCidrs || undefined, reserveFrom: softTotalOf(config) || undefined }, 'HTTP connection hardening active');
  shared = { config, guard, stallWatcher };
  return shared;
}
