/**
 * HTTP → HTTPS redirect + HSTS (8.0.x).
 *
 * Once the integrated HTTPS proxy serves a certificate marked "active for
 * HTTPS" (BCP → SSL/TLS, Certificate.isActiveHttps), plain-HTTP requests on
 * port 80/3000 get `308 Permanent Redirect` to https://<host><path>, where
 * <host> is the requested host when the active certificates cover it, else
 * ServerSettings.publicHostname (never an arbitrary client-supplied host —
 * no open redirect).
 *
 * Not redirected: /.well-known/acme-challenge/* (HTTP-01 must stay on HTTP),
 * /healthz, /livez, loopback peers (raw socket address; container health
 * checks, internal services) and requests already on HTTPS (`req.secure`: TLS
 * socket, or X-Forwarded-Proto=https from a TRUST_PROXY-trusted proxy).
 *
 * Switch: HTTP_REDIRECT_HTTPS (default true; "false" disables it, e.g. when an
 * external TLS terminator talks plain HTTP to port 3000 without TRUST_PROXY).
 *
 * v8.1: without TRUST_PROXY a request that carries any X-Forwarded-* or
 * Forwarded header is not redirected (a warning is logged once): it comes
 * through a reverse proxy whose X-Forwarded-Proto cannot be trusted, and a
 * redirect would loop (the proxy talks plain HTTP to port 3000 again). The URL
 * port is HTTPS_PUBLIC_PORT (default 443 → omitted) — the port clients reach,
 * not the internal HTTPS_PORT of the listener (e.g. "8443:443" mappings).
 *
 * HSTS (`Strict-Transport-Security`) is sent on HTTPS responses only — on a
 * plain-HTTP response it is meaningless (RFC 6797 §7.2) and helmet sent it
 * unconditionally.
 */
import type { Request, Response, NextFunction } from 'express';
import { createLogger, isLoopbackAddress } from '@coremail/core';
import { hasForwardingHeader } from './proxy-headers.js';

const log = createLogger('api:https-redirect');

export interface HttpsRedirectState {
  /** HTTPS proxy listening with a certificate that is active for HTTPS. */
  active: boolean;
  /** Listener port of the HTTPS proxy (HTTPS_PORT) — not used for the URL. */
  port: number;
  /** Does one of the served certificates cover `host`? */
  covers(host: string): boolean;
}

export interface HttpsRedirectOptions {
  enabled?: boolean;
  state: () => HttpsRedirectState;
  publicHostname: () => Promise<string | null>;
  /** Port in the redirect URL (default: HTTPS_PUBLIC_PORT, else 443). */
  publicPort?: number;
  /** TRUST_PROXY configured? (default: from the env). */
  trustProxy?: boolean;
  /** Called once when a forwarded request is not redirected (default: logger warning). */
  warnUntrustedProxy?: () => void;
}

const EXEMPT = [/^\/\.well-known\/acme-challenge\//, /^\/healthz\/?$/, /^\/livez\/?$/];

/**
 * Autodiscover "HTTP redirect method" (MS-OXDSCLI §3.1.5.2): a client sends an
 * unauthenticated GET to http://autodiscover.<domain>/autodiscover/autodiscover.xml
 * and expects a 302 to the HTTPS endpoint — older Outlook builds do not follow 308.
 */
const AUTODISCOVER_XML = /^\/autodiscover\/autodiscover\.xml$/i;

/** Pure: redirect status for a plain-HTTP request path. */
export function redirectStatusFor(path: string): 302 | 308 {
  return AUTODISCOVER_XML.test(path) ? 302 : 308;
}

export function httpRedirectEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(false|0|no|off)$/i.test((env['HTTP_REDIRECT_HTTPS'] ?? 'true').trim());
}

/** Public HTTPS port for redirect URLs: HTTPS_PUBLIC_PORT (1–65535), default 443. */
export function httpsPublicPort(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number((env['HTTPS_PUBLIC_PORT'] ?? '').trim());
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 443;
}

/** TRUST_PROXY set to something other than empty/false (same rules as parseTrustProxy). */
export function trustProxyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env['TRUST_PROXY'] ?? '').trim();
  return v !== '' && !/^(false|no|off|0)$/i.test(v);
}

function hostOnly(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const h = hostHeader.trim().toLowerCase();
  const m = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/.exec(h);
  return m ? m[1]! : null;
}

export function createHttpsRedirect(opts: HttpsRedirectOptions) {
  const enabled = opts.enabled ?? httpRedirectEnabled();
  const publicPort = opts.publicPort ?? httpsPublicPort();
  const trustProxy = opts.trustProxy ?? trustProxyConfigured();
  const warn = opts.warnUntrustedProxy ?? (() => log.warn(
    'HTTP→HTTPS redirect skipped: request came through a reverse proxy (X-Forwarded-*/Forwarded) but TRUST_PROXY is not set. '
    + 'Set TRUST_PROXY to the proxy address so X-Forwarded-Proto is honoured, or HTTP_REDIRECT_HTTPS=false.',
  ));
  let warned = false;
  return function httpsRedirect(req: Request, res: Response, next: NextFunction): void {
    if (!enabled || req.secure) { next(); return; }
    if (EXEMPT.some((re) => re.test(req.path))) { next(); return; }
    if (isLoopbackAddress(req.socket?.remoteAddress)) { next(); return; }
    const state = opts.state();
    if (!state.active) { next(); return; }
    // Behind an untrusted reverse proxy we cannot know the client's scheme —
    // redirecting would loop when the proxy speaks plain HTTP to port 3000.
    if (!trustProxy && hasForwardingHeader(req)) {
      if (!warned) { warned = true; warn(); }
      next();
      return;
    }
    const requested = hostOnly(req.get('host'));
    const finish = (host: string | null): void => {
      if (!host) { next(); return; }
      const port = publicPort === 443 ? '' : `:${publicPort}`;
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(redirectStatusFor(req.path), `https://${host}${port}${req.originalUrl}`);
    };
    if (requested && state.covers(requested)) { finish(requested); return; }
    opts.publicHostname().then((h) => finish(hostOnly(h ?? undefined)), () => next());
  };
}

/** Strict-Transport-Security on HTTPS responses only. */
export function hstsOnHttps(req: Request, res: Response, next: NextFunction): void {
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  next();
}
