/**
 * Security Middleware — OWASP-aligned HTTP hardening for the API Gateway.
 *
 * Applied layers (in order of registration in server.ts):
 *   1. requestId          — Correlation-ID für jeden Request (Logging, Tracing)
 *   2. helmetMiddleware   — Vollständiger HTTP-Security-Header-Stack
 *   3. suspiciousInput    — Null-Byte, CRLF-Injection, Path-Traversal, Header-Overflow
 *   4. generalRateLimit   — Globales IP-basiertes Throttling (500 req / 15 min)
 *   5. authRateLimit      — Strenges Throttling auf /auth (20 req / 15 min, Brute-Force)
 *   6. setupRateLimit     — Einmaliger Setup-Endpunkt (5 req / h)
 */

import type { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createLogger } from '@coremail/core';
import { randomUUID } from 'node:crypto';

const log = createLogger('api:security');

// ── Hilfsfunktionen ──────────────────────────────────────────────────────────

/** Gibt true zurück, wenn der Request vom Loopback kommt (interne Services). */
const isLoopback = (req: Request): boolean =>
  req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';

// ── 1. Request-ID ────────────────────────────────────────────────────────────
/**
 * Fügt jedem Request eine eindeutige ID hinzu.
 * Bereits vorhandene X-Request-Id werden validiert — ungültige werden ersetzt.
 * Die ID erscheint im Response-Header und kann für Logging/Tracing genutzt werden.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers['x-request-id'];
  // Nur bekannte, sichere Zeichen akzeptieren (UUID-Format oder alphanumerisch)
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
 * Setzt alle relevanten HTTP-Security-Header:
 *
 * Content-Security-Policy  — Verhindert XSS und Clickjacking
 * Strict-Transport-Security — HSTS: erzwingt HTTPS für 1 Jahr
 * X-Content-Type-Options   — Verhindert MIME-Type-Sniffing
 * X-Frame-Options          — Verhindert Einbettung in iframes (Clickjacking)
 * Referrer-Policy          — Begrenzt Referrer-Informationsweitergabe
 * Permissions-Policy       — Deaktiviert nicht benötigte Browser-APIs
 * X-DNS-Prefetch-Control   — Kein DNS-Prefetch (Privacy)
 */
export const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc:   ["'self'"],
      scriptSrc:    ["'self'"],
      // TailwindCSS und shadcn/ui benötigen inline styles
      styleSrc:     ["'self'", "'unsafe-inline'"],
      imgSrc:       ["'self'", 'data:', 'blob:'],
      fontSrc:      ["'self'", 'data:'],
      // EventSource (SSE) und fetch() gegen dieselbe Origin
      connectSrc:   ["'self'"],
      // Web Workers für potenzielle zukünftige Nutzung
      workerSrc:    ["'self'", 'blob:'],
      mediaSrc:     ["'none'"],
      objectSrc:    ["'none'"],
      frameSrc:     ["'none'"],
      baseUri:      ["'self'"],
      formAction:   ["'self'"],
      // Verhindert Einbettung dieser Seite als iframe (doppelt mit X-Frame-Options)
      frameAncestors: ["'none'"],
    },
  },

  // HSTS — Browser merken sich HTTPS-Anforderung für 1 Jahr
  hsts: {
    maxAge: 31_536_000,      // 1 Jahr in Sekunden
    includeSubDomains: true,
    preload: true,
  },

  // Deaktiviert X-Powered-By (kein Fingerprinting des Frameworks)
  hidePoweredBy: true,

  // Verhindert MIME-Type-Sniffing
  noSniff: true,

  // Legacy XSS-Filter (moderner Browser ignorieren ihn, schadet aber nicht)
  xssFilter: true,

  // Keine iFrame-Einbettung erlaubt
  frameguard: { action: 'deny' },

  // Kein DNS-Prefetch (Privacy)
  dnsPrefetchControl: { allow: false },

  // Referrer-Header nur bei gleicher Origin vollständig senden
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },

  // Ressourcen dürfen nur von gleicher Origin geladen werden
  crossOriginResourcePolicy: { policy: 'same-origin' },

  // COEP deaktiviert — würde SharedArrayBuffer erfordern, bricht Mail-Clients
  crossOriginEmbedderPolicy: false,

  // Keine Flash/PDF Cross-Domain-Policies
  permittedCrossDomainPolicies: { permittedPolicies: 'none' },
});

// ── 3. Verdächtige-Eingaben-Filter ───────────────────────────────────────────
/**
 * Erkennt und blockt Angriffsmuster auf HTTP-Ebene:
 *
 * - CRLF-Injection in Headers (Header-Splitting / Response-Splitting)
 * - Null-Bytes in Headers (können Parser umgehen)
 * - Oversized Header (> 16 KB) — verhindert Header-Flooding
 * - Path-Traversal (../ oder ..\) in der Request-URL
 *
 * Muss VOR dem Body-Parser registriert werden.
 */
export function suspiciousInputGuard(req: Request, res: Response, next: NextFunction): void {
  let headerSize = 0;

  for (const [key, rawVal] of Object.entries(req.headers)) {
    const val = Array.isArray(rawVal) ? rawVal.join(',') : (rawVal ?? '');
    headerSize += key.length + val.length;

    // Null-Bytes und CRLF-Injection-Versuche abfangen
    if (/[\x00\r\n]/.test(key) || /[\x00\r\n]/.test(val)) {
      log.warn({ ip: req.ip, path: req.path, header: key }, 'Header injection attempt blocked');
      res.status(400).json({ error: 'Bad request' });
      return;
    }
  }

  // 16 KB Hard-Limit für alle Header zusammen
  if (headerSize > 16_384) {
    log.warn({ ip: req.ip, size: headerSize }, 'Oversized request headers rejected');
    res.status(431).json({ error: 'Request header fields too large' });
    return;
  }

  // Path-Traversal in der URL
  if (/(?:\.\.\/|\.\.\\)/.test(req.path)) {
    log.warn({ ip: req.ip, path: req.path }, 'Path traversal attempt blocked');
    res.status(400).json({ error: 'Bad request' });
    return;
  }

  next();
}

// ── 4. Rate Limiter ───────────────────────────────────────────────────────────

/**
 * Globales Throttling — 500 Requests pro 15 Minuten pro IP.
 * Loopback-Adressen (interne Services) sind ausgenommen.
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
 * Auth-Endpunkte — max. 20 Versuche pro 15 Minuten pro IP.
 * Schützt gegen Brute-Force-Angriffe auf Login und Token-Refresh.
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
 * Setup-Endpunkt — max. 5 Versuche pro Stunde.
 * Der Setup-Endpoint existiert nur einmal und sollte nach der Initialkonfiguration
 * ohnehin keine Requests mehr erhalten.
 */
export const setupRateLimit = rateLimit({
  windowMs: 60 * 60 * 1_000,
  max: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many setup attempts.' },
});

/**
 * Admin-Mutations (POST/PUT/PATCH/DELETE auf /api/v1/admin) —
 * 200 mutierende Requests pro 15 Minuten pro IP.
 */
export const adminMutationRateLimit = rateLimit({
  windowMs: 15 * 60 * 1_000,
  max: 200,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (req) => isLoopback(req) || req.method === 'GET' || req.method === 'HEAD',
  message: { error: 'Admin mutation rate limit exceeded. Please slow down.' },
});
