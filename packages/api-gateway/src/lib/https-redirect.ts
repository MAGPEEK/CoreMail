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
 * HSTS (`Strict-Transport-Security`) is sent on HTTPS responses only — on a
 * plain-HTTP response it is meaningless (RFC 6797 §7.2) and helmet sent it
 * unconditionally.
 */
import type { Request, Response, NextFunction } from 'express';
import { isLoopbackAddress } from '@coremail/core';

export interface HttpsRedirectState {
  /** HTTPS proxy listening with a certificate that is active for HTTPS. */
  active: boolean;
  /** Public HTTPS port (443 → omitted from the URL). */
  port: number;
  /** Does one of the served certificates cover `host`? */
  covers(host: string): boolean;
}

export interface HttpsRedirectOptions {
  enabled?: boolean;
  state: () => HttpsRedirectState;
  publicHostname: () => Promise<string | null>;
}

const EXEMPT = [/^\/\.well-known\/acme-challenge\//, /^\/healthz\/?$/, /^\/livez\/?$/];

export function httpRedirectEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(false|0|no|off)$/i.test((env['HTTP_REDIRECT_HTTPS'] ?? 'true').trim());
}

function hostOnly(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const h = hostHeader.trim().toLowerCase();
  const m = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/.exec(h);
  return m ? m[1]! : null;
}

export function createHttpsRedirect(opts: HttpsRedirectOptions) {
  const enabled = opts.enabled ?? httpRedirectEnabled();
  return function httpsRedirect(req: Request, res: Response, next: NextFunction): void {
    if (!enabled || req.secure) { next(); return; }
    if (EXEMPT.some((re) => re.test(req.path))) { next(); return; }
    if (isLoopbackAddress(req.socket?.remoteAddress)) { next(); return; }
    const state = opts.state();
    if (!state.active) { next(); return; }
    const requested = hostOnly(req.get('host'));
    const finish = (host: string | null): void => {
      if (!host) { next(); return; }
      const port = state.port === 443 ? '' : `:${state.port}`;
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(308, `https://${host}${port}${req.originalUrl}`);
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
