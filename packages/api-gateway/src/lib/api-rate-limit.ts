/**
 * Global API rate limit of the api-gateway (9.4; before: a fixed 500 requests / 15 min
 * per IP that webmail users behind one NAT address exhausted together).
 *
 *  - Signed-in requests (valid Bearer access token) count per USER, anonymous ones per
 *    client IP (IPv6 per /56) — an office behind one address no longer shares a budget.
 *  - Exempt: loopback peers (internal services), static assets / SPA pages (GET/HEAD
 *    outside the API and protocol paths) and the live-event stream GET /api/v1/events
 *    (counted per IP only when its ticket/token is refused). The ticket request
 *    POST /api/v1/events/ticket counts like any API request (per user): every stream
 *    needs a fresh one-time ticket, so this bounds how many streams a token can open.
 *  - Configurable in BCP → Settings → Security (ServerSettings.apiRateLimit*); the
 *    environment variables API_RATE_LIMIT_ENABLED / _WINDOW_MIN / _PER_IP / _PER_USER
 *    override the stored values when set. Fixed window per bucket, in memory (one
 *    api-gateway process).
 *
 * The strict limiters for login, setup, SSO and admin mutations are unchanged
 * (middleware/security.ts) and run in addition.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';

export interface ApiRateLimitConfig {
  enabled: boolean;
  windowMs: number;
  perIp: number;
  perUser: number;
}

export type ApiRateLimitField = 'apiRateLimitEnabled' | 'apiRateLimitWindowMin' | 'apiRateLimitPerIp' | 'apiRateLimitPerUser';

/** The ServerSettings columns (optional: a missing row keeps the defaults). */
export type ApiRateLimitRow = Partial<{
  apiRateLimitEnabled: boolean; apiRateLimitWindowMin: number; apiRateLimitPerIp: number; apiRateLimitPerUser: number;
}>;

/** Schema defaults — sized for webmail use (a busy user makes a few hundred requests in 15 min). */
export const API_RATE_LIMIT_DEFAULTS = { enabled: true, windowMin: 15, perIp: 500, perUser: 3000 } as const;

/** Accepted ranges (the admin API validates the same). */
export const API_RATE_LIMIT_BOUNDS = {
  windowMin: [1, 1440],
  perIp: [10, 1_000_000],
  perUser: [10, 1_000_000],
} as const;

export const API_RATE_LIMIT_ENV: Readonly<Record<ApiRateLimitField, string>> = {
  apiRateLimitEnabled: 'API_RATE_LIMIT_ENABLED',
  apiRateLimitWindowMin: 'API_RATE_LIMIT_WINDOW_MIN',
  apiRateLimitPerIp: 'API_RATE_LIMIT_PER_IP',
  apiRateLimitPerUser: 'API_RATE_LIMIT_PER_USER',
};

const clamp = (v: number, [min, max]: readonly [number, number]) => Math.min(max, Math.max(min, Math.round(v)));

/** Pure: effective configuration — environment variable (when set and valid) > column > default. */
export function resolveApiRateLimit(
  row: ApiRateLimitRow | null,
  env: Record<string, string | undefined> = process.env,
): ApiRateLimitConfig & { envOverrides: ApiRateLimitField[] } {
  const envOverrides: ApiRateLimitField[] = [];
  const envText = (f: ApiRateLimitField): string | null => {
    const v = (env[API_RATE_LIMIT_ENV[f]] ?? '').trim();
    return v === '' ? null : v;
  };
  const num = (f: ApiRateLimitField, stored: number | undefined, fallback: number, bounds: readonly [number, number]): number => {
    const t = envText(f);
    const n = t === null ? NaN : Number(t);
    if (Number.isFinite(n)) { envOverrides.push(f); return clamp(n, bounds); }
    return clamp(typeof stored === 'number' && Number.isFinite(stored) ? stored : fallback, bounds);
  };
  const enabledText = envText('apiRateLimitEnabled');
  let enabled = row?.apiRateLimitEnabled ?? API_RATE_LIMIT_DEFAULTS.enabled;
  if (enabledText !== null && /^(true|1|yes|on|false|0|no|off)$/i.test(enabledText)) {
    envOverrides.unshift('apiRateLimitEnabled');
    enabled = /^(true|1|yes|on)$/i.test(enabledText);
  }
  const windowMin = num('apiRateLimitWindowMin', row?.apiRateLimitWindowMin, API_RATE_LIMIT_DEFAULTS.windowMin, API_RATE_LIMIT_BOUNDS.windowMin);
  return {
    enabled,
    windowMs: windowMin * 60_000,
    perIp: num('apiRateLimitPerIp', row?.apiRateLimitPerIp, API_RATE_LIMIT_DEFAULTS.perIp, API_RATE_LIMIT_BOUNDS.perIp),
    perUser: num('apiRateLimitPerUser', row?.apiRateLimitPerUser, API_RATE_LIMIT_DEFAULTS.perUser, API_RATE_LIMIT_BOUNDS.perUser),
    envOverrides,
  };
}

// ── request classification ───────────────────────────────────────────────────

/** Paths served by the API or a protocol service (everything else is a static asset / SPA page). */
const API_PATHS = [
  '/api/', '/auth/', '/jmap', '/.well-known/', '/autodiscover', '/microsoft-server-activesync', '/dav',
  '/mail/config-v1.1.xml', '/ews', '/oab', '/mapi',
];

export type RateLimitClass =
  | { kind: 'exempt' }
  | { kind: 'user'; userId: string }
  | { kind: 'ip' }
  /** Live-event stream: counted per IP only when the response refuses it. */
  | { kind: 'sse' };

export interface ClassifyInput {
  method: string;
  path: string;
  authorization?: string | undefined;
}

/** Pure: bucket of a request; `verify` maps an access token to its user id (null = invalid). */
export function classifyRequest(req: ClassifyInput, verify: (token: string) => string | null): RateLimitClass {
  const path = req.path.toLowerCase();
  const isApi = API_PATHS.some((p) => path === p.replace(/\/$/, '') || path.startsWith(p));
  if (!isApi && (req.method === 'GET' || req.method === 'HEAD')) return { kind: 'exempt' };
  if (req.method === 'GET' && path === '/api/v1/events') return { kind: 'sse' };
  const m = /^Bearer\s+(\S+)$/i.exec(req.authorization ?? '');
  const userId = m ? verify(m[1]!) : null;
  return userId ? { kind: 'user', userId } : { kind: 'ip' };
}

// ── counter ──────────────────────────────────────────────────────────────────

/** Fixed-window counters per key (in memory; expired windows are pruned). */
export class FixedWindowCounter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private lastPrune = 0;

  hit(key: string, windowMs: number, now: number): { count: number; resetAt: number } {
    this.prune(now, windowMs);
    let w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, w);
    }
    w.count++;
    return w;
  }

  /** Current count of a key without counting (0 when no window is open). */
  peek(key: string, now: number): number {
    const w = this.windows.get(key);
    return w && w.resetAt > now ? w.count : 0;
  }

  /** Remove expired windows at most once per window length. */
  private prune(now: number, windowMs: number): void {
    if (now - this.lastPrune < windowMs) return;
    this.lastPrune = now;
    for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
  }

  get size(): number { return this.windows.size; }
}

// ── middleware ───────────────────────────────────────────────────────────────

export interface ApiRateLimitDeps {
  /** Current configuration (synchronous; refreshed elsewhere). */
  config: () => ApiRateLimitConfig;
  /** Access token → user id (null = invalid). */
  verifyUser: (token: string) => string | null;
  /** Loopback peers (internal services) are never limited. */
  isLoopback: (req: Request) => boolean;
  now?: () => number;
  onLimited?: (info: { kind: 'user' | 'ip'; path: string }) => void;
}

function refuse(res: Response, limit: number, resetAt: number, now: number): void {
  const retry = Math.max(1, Math.ceil((resetAt - now) / 1000));
  res.setHeader('Retry-After', String(retry));
  res.setHeader('RateLimit-Limit', String(limit));
  res.setHeader('RateLimit-Remaining', '0');
  res.setHeader('RateLimit-Reset', String(retry));
  res.status(429).json({ error: 'Too many requests. Please try again later.' });
}

export function createApiRateLimit(deps: ApiRateLimitDeps): RequestHandler {
  const counter = new FixedWindowCounter();
  const now = deps.now ?? (() => Date.now());
  const ipKey = (req: Request) => `ip:${ipKeyGenerator(req.ip ?? req.socket?.remoteAddress ?? '')}`;

  return (req: Request, res: Response, next: NextFunction): void => {
    const cfg = deps.config();
    if (!cfg.enabled || deps.isLoopback(req)) { next(); return; }
    const cls = classifyRequest({ method: req.method, path: req.path, authorization: req.headers.authorization }, deps.verifyUser);
    if (cls.kind === 'exempt') { next(); return; }
    if (cls.kind === 'sse') {
      // An address whose budget is used up (e.g. by refused tickets) gets no stream either.
      if (counter.peek(ipKey(req), now()) >= cfg.perIp) { refuse(res, cfg.perIp, now() + cfg.windowMs, now()); return; }
      res.on('finish', () => {
        if (res.statusCode === 401 || res.statusCode === 403) counter.hit(ipKey(req), cfg.windowMs, now());
      });
      next();
      return;
    }
    const [key, limit] = cls.kind === 'user' ? [`user:${cls.userId}`, cfg.perUser] : [ipKey(req), cfg.perIp];
    const t = now();
    const w = counter.hit(key, cfg.windowMs, t);
    if (w.count > limit) {
      deps.onLimited?.({ kind: cls.kind, path: req.path });
      refuse(res, limit, w.resetAt, t);
      return;
    }
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - w.count)));
    res.setHeader('RateLimit-Reset', String(Math.max(1, Math.ceil((w.resetAt - t) / 1000))));
    next();
  };
}
