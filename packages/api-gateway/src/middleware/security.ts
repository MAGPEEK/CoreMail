/**
 * Security Middleware — OWASP-aligned HTTP hardening for the API Gateway.
 *
 * Applied layers (in order of registration in server.ts):
 *   1. requestId          — correlation ID for every request (logging, tracing)
 *   2. helmetMiddleware   — complete HTTP security header stack
 *   3. suspiciousInput    — null bytes, CRLF injection, path traversal, header overflow
 *   4. generalRateLimit   — global IP-based throttling (500 req / 15 min; /mapi exempt)
 *   5. authRateLimit      — strict throttling on /auth (20 req / 15 min, brute force)
 *   6. setupRateLimit     — one-time setup endpoint (5 req / h)
 */

import type { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createLogger, isLoopbackAddress } from '@coremail/core';
import { randomUUID } from 'node:crypto';

const log = createLogger('api:security');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true when the request comes from loopback (internal services).
 * v6: uses the RAW socket peer — never req.ip, which honours X-Forwarded-For
 * when TRUST_PROXY is set and could be spoofed to "127.0.0.1".
 */
export const isLoopback = (req: Request): boolean => isLoopbackAddress(req.socket?.remoteAddress);

// ── 1. Request-ID ────────────────────────────────────────────────────────────
/**
 * Adds a unique ID to every request.
 * Existing X-Request-Id values are validated — invalid ones are replaced.
 * The ID appears in the response header and can be used for logging/tracing.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers['x-request-id'];
  // Accept only known, safe characters (UUID format or alphanumeric)
  const id =
    typeof incoming === 'string' && /^[\w\-]{8,64}$/.test(incoming)
      ? incoming
      : randomUUID();
  req.headers['x-request-id'] = id;
  res.setHeader('X-Request-Id', id);
  next();
}

// ── 2. Helmet (HTTP Security Headers) ────────────────────────────────────────
/**
 * Sets all relevant HTTP security headers:
 *
 * Content-Security-Policy  — prevents XSS and clickjacking
 * Strict-Transport-Security — HSTS: enforces HTTPS for 1 year
 * X-Content-Type-Options   — prevents MIME-type sniffing
 * X-Frame-Options          — prevents embedding in iframes (clickjacking)
 * Referrer-Policy          — limits referrer information disclosure
 * Permissions-Policy       — disables browser APIs that are not needed
 * X-DNS-Prefetch-Control   — no DNS prefetch (privacy)
 */
export const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc:   ["'self'"],
      scriptSrc:    ["'self'"],
      // TailwindCSS and shadcn/ui require inline styles
      styleSrc:     ["'self'", "'unsafe-inline'"],
      imgSrc:       ["'self'", 'data:', 'blob:'],
      fontSrc:      ["'self'", 'data:'],
      // EventSource (SSE) and fetch() against the same origin
      connectSrc:   ["'self'"],
      // Web Workers for potential future use
      workerSrc:    ["'self'", 'blob:'],
      mediaSrc:     ["'none'"],
      objectSrc:    ["'none'"],
      frameSrc:     ["'none'"],
      baseUri:      ["'self'"],
      formAction:   ["'self'"],
      // Prevents embedding this page as an iframe (redundant with X-Frame-Options)
      frameAncestors: ["'none'"],
    },
  },

  // HSTS (1 year, includeSubDomains, preload) is set by hstsOnHttps()
  // (lib/https-redirect.ts) on HTTPS responses only — 8.0.x.
  hsts: false,

  // Disables X-Powered-By (no framework fingerprinting)
  hidePoweredBy: true,

  // Prevents MIME-type sniffing
  noSniff: true,

  // Legacy XSS filter (modern browsers ignore it, but it does no harm)
  xssFilter: true,

  // No iframe embedding allowed
  frameguard: { action: 'deny' },

  // No DNS prefetch (privacy)
  dnsPrefetchControl: { allow: false },

  // Send the full Referrer header only for the same origin
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },

  // Resources may only be loaded from the same origin
  crossOriginResourcePolicy: { policy: 'same-origin' },

  // COEP disabled — would require SharedArrayBuffer, breaks mail clients
  crossOriginEmbedderPolicy: false,

  // No Flash/PDF cross-domain policies
  permittedCrossDomainPolicies: { permittedPolicies: 'none' },
});

// ── 3. Suspicious-input filter ───────────────────────────────────────────────
/**
 * Detects and blocks attack patterns at the HTTP level:
 *
 * - CRLF injection in headers (header splitting / response splitting)
 * - Null bytes in headers (can bypass parsers)
 * - Oversized headers (> 16 KB) — prevents header flooding
 * - Path traversal (../ or ..\) in the request URL
 *
 * Must be registered BEFORE the body parser.
 */
export function suspiciousInputGuard(req: Request, res: Response, next: NextFunction): void {
  let headerSize = 0;

  for (const [key, rawVal] of Object.entries(req.headers)) {
    const val = Array.isArray(rawVal) ? rawVal.join(',') : (rawVal ?? '');
    headerSize += key.length + val.length;

    // Catch null bytes and CRLF injection attempts
    if (/[\x00\r\n]/.test(key) || /[\x00\r\n]/.test(val)) {
      log.warn({ ip: req.ip, path: req.path, header: key }, 'Header injection attempt blocked');
      res.status(400).json({ error: 'Bad request' });
      return;
    }
  }

  // 16 KB hard limit for all headers combined
  if (headerSize > 16_384) {
    log.warn({ ip: req.ip, size: headerSize }, 'Oversized request headers rejected');
    res.status(431).json({ error: 'Request header fields too large' });
    return;
  }

  // Path traversal in the URL
  if (/(?:\.\.\/|\.\.\\)/.test(req.path)) {
    log.warn({ ip: req.ip, path: req.path }, 'Path traversal attempt blocked');
    res.status(400).json({ error: 'Bad request' });
    return;
  }

  next();
}

// ── 4. Rate Limiter ───────────────────────────────────────────────────────────

/**
 * MAPI over HTTP (9.4): classic Outlook sends many requests per minute and
 * several clients often share one IP (NAT), so /mapi is not counted per IP.
 * The MAPI server counts per authenticated mail account instead
 * (MAPI_RATE_LIMIT / MAPI_RATE_WINDOW_SEC); unauthenticated guessing stays
 * bounded by the shared mail-login lockout. Express mounts are
 * case-insensitive, so the test is too.
 */
export const isMapiPath = (path: string): boolean => /^\/mapi(?:\/|$)/i.test(path);

/**
 * Global throttling — 500 requests per 15 minutes per IP.
 * Loopback addresses (internal services) and /mapi are exempt.
 */
export const generalRateLimit = rateLimit({
  windowMs: 15 * 60 * 1_000,
  max: 500,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (req) => isLoopback(req) || isMapiPath(req.path),
  message: { error: 'Too many requests. Please try again later.' },
  handler(req, res, _next, options) {
    log.warn({ ip: req.ip, path: req.path }, 'General rate limit exceeded');
    res.status(options.statusCode).json(options.message);
  },
});

/**
 * Auth endpoints — max. 20 attempts per 15 minutes per IP.
 * Protects against brute-force attacks on login, MFA and password reset.
 * Token refresh/logout have their own limiter (authRefreshRateLimit).
 */
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1_000,
  max: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Please try again in 15 minutes.' },
  handler(req, res, _next, options) {
    log.warn({ ip: req.ip }, 'Auth rate limit exceeded — possible brute force');
    res.status(options.statusCode).json(options.message);
  },
});

/**
 * Token refresh + logout — 300 failed requests per 15 minutes per IP.
 * The access token lives in memory only, so every page load and every new tab
 * calls POST /auth/refresh; counting those against the 20-request login budget
 * produced 429s that the frontends took for a logout. Successful refreshes are
 * not counted; refresh tokens are 256-bit random, so the failure budget is no
 * brute-force risk.
 */
export const authRefreshRateLimit = rateLimit({
  windowMs: 15 * 60 * 1_000,
  max: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many token refresh attempts. Please try again later.', code: 'RATE_LIMITED' },
  handler(req, res, _next, options) {
    log.warn({ ip: req.ip, path: req.path }, 'Refresh rate limit exceeded');
    res.status(options.statusCode).json(options.message);
  },
});

/** Paths under /auth that use authRefreshRateLimit instead of the strict login limiter. */
const REFRESH_PATHS = new Set(['/refresh', '/logout']);

/**
 * Limiter for the /auth mount (authRouter): POST /refresh and /logout get the
 * generous refresh limiter, everything else (login, password reset) the strict one.
 */
export const authRouteRateLimit = (req: Request, res: Response, next: NextFunction): unknown =>
  REFRESH_PATHS.has(req.path) ? authRefreshRateLimit(req, res, next) : authRateLimit(req, res, next);

/**
 * SSO flow (v6.1) — start/callback/exchange: 60 per 15 minutes per IP (one
 * login = 3 requests). The public provider list (GET /auth/sso/providers) is
 * exempt so the login page cannot lock users out.
 */
const ssoFlowLimit = rateLimit({
  windowMs: 15 * 60 * 1_000,
  max: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many SSO attempts. Please try again in 15 minutes.' },
});
export const ssoRateLimit = (req: Request, res: Response, next: NextFunction): unknown =>
  req.method === 'GET' && req.path === '/providers' ? next() : ssoFlowLimit(req, res, next);

/**
 * Setup endpoint — max. 5 attempts per hour.
 * The setup endpoint exists only once and should not receive any requests
 * after the initial configuration anyway.
 *
 * Only POST attempts count: MWA and BCP call GET /api/v1/setup/status on every
 * page load, so counting reads exhausted the budget after a few reloads and the
 * wizard's POST /complete then failed with 429 for an hour.
 */
export const setupRateLimit = rateLimit({
  windowMs: 60 * 60 * 1_000,
  max: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (req) => req.method === 'GET' || req.method === 'HEAD',
  message: { error: 'Too many setup attempts.' },
});

/**
 * Admin mutations (POST/PUT/PATCH/DELETE on /api/v1/admin) —
 * 200 mutating requests per 15 minutes per IP.
 */
export const adminMutationRateLimit = rateLimit({
  windowMs: 15 * 60 * 1_000,
  max: 200,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (req) => isLoopback(req) || req.method === 'GET' || req.method === 'HEAD',
  message: { error: 'Admin mutation rate limit exceeded. Please slow down.' },
});
