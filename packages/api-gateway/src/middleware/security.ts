/**
 * Security Middleware — OWASP-aligned HTTP hardening for the API Gateway.
 *
 * Applied layers (in order of registration in server.ts):
 *   1. requestId          — correlation ID for every request (logging, tracing)
 *   2. helmetMiddleware   — complete HTTP security header stack
 *   3. suspiciousInput    — null bytes, CRLF injection, path traversal, header overflow
 *   4. generalRateLimit   — global IP-based throttling (500 req / 15 min)
 *   5. authRateLimit      — strict throttling on /auth (20 req / 15 min, brute force)
 *   6. setupRateLimit     — one-time setup endpoint (5 req / h)
 */

import type { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createLogger } from '@coremail/core';
import { randomUUID } from 'node:crypto';

const log = createLogger('api:security');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Returns true when the request comes from loopback (internal services). */
const isLoopback = (req: Request): boolean =>
  req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';

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

  // HSTS — browsers remember the HTTPS requirement for 1 year
  hsts: {
    maxAge: 31_536_000,      // 1 year in seconds
    includeSubDomains: true,
    preload: true,
  },

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
 * Global throttling — 500 requests per 15 minutes per IP.
 * Loopback addresses (internal services) are exempt.
 */
export const generalRateLimit = rateLimit({
  windowMs: 15 * 60 * 1_000,
  max: 500,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: isLoopback,
  message: { error: 'Too many requests. Please try again later.' },
  handler(req, res, _next, options) {
    log.warn({ ip: req.ip, path: req.path }, 'General rate limit exceeded');
    res.status(options.statusCode).json(options.message);
  },
});

/**
 * Auth endpoints — max. 20 attempts per 15 minutes per IP.
 * Protects against brute-force attacks on login and token refresh.
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
 * Setup endpoint — max. 5 attempts per hour.
 * The setup endpoint exists only once and should not receive any requests
 * after the initial configuration anyway.
 */
export const setupRateLimit = rateLimit({
  windowMs: 60 * 60 * 1_000,
  max: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
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
