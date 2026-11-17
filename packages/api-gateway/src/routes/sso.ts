/**
 * OIDC single sign-on routes (v6.1) — logic in @coremail/auth-sso.
 *
 *   GET  /auth/sso/providers               → [{ id, name }] active providers (public, no client data)
 *   GET  /auth/sso/:providerId/start       → 302 to the IdP (?target=mwa|bcp), sets the
 *                                            binding cookie `cm_sso` (HttpOnly, SameSite=Lax,
 *                                            Secure on https, Path=/auth/sso, 10 min)
 *   GET  /auth/sso/:providerId/callback    → 302 to /sso/callback?code=… (MWA) or
 *                                            /bcp/sso/callback?code=… — on error to
 *                                            /login?sso_error=<reason> (/bcp/login for the BCP)
 *   POST /auth/sso/exchange { code }       → same body as POST /auth/login:
 *                                            { accessToken, refreshToken, expiresIn }
 *                                            (browser clients: refresh token only in the
 *                                            HttpOnly cookie cm_rt / cm_rt_bcp, v8.1)
 *                                            | { mfaRequired, challengeToken, method, methods }
 *
 * Redirect URI to register at the IdP: <public base URL>/auth/sso/<providerId>/callback
 * (base URL = COREMAIL_PUBLIC_URL or ServerSettings publicHostname/useHttps/httpPort).
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import {
  listPublicProviders, startSso, completeSsoCallback, exchangeSsoCode, SSO_COOKIE, SSO_STATE_TTL, type SsoTarget,
} from '@coremail/auth-sso';
import { protocolDisabledBody, tokenPairResponse } from '@coremail/storage/auth';
import { deriveServerUrls } from '../lib/server-urls.js';

const log = createLogger('api:sso');
export const ssoRouter: RouterType = Router();

/** Public base URL of this CoreMail installation (used for the OIDC redirect_uri). */
export async function publicBaseUrl(): Promise<string> {
  const env = process.env['COREMAIL_PUBLIC_URL']?.trim();
  if (env) return env.replace(/\/+$/, '');
  const s = await prisma.serverSettings.findUnique({ where: { id: 'singleton' } });
  // v7: ewsUrl is gone with EWS — derive the base from the MWA URL (`<base>/owa/`)
  const owa = deriveServerUrls(s?.publicHostname || 'localhost', s?.useHttps ?? true, s?.httpPort ?? 443).owaUrl;
  return owa.replace(/\/owa\/$/, '');
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

function cookieHeader(req: Request, value: string, maxAge: number): string {
  const secure = req.secure ? '; Secure' : '';
  return `${SSO_COOKIE}=${value}; Path=/auth/sso; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

const clientInfo = (req: Request) => ({ ip: req.ip ?? 'unknown', userAgent: req.get('user-agent') ?? '' });
const loginPath = (t: SsoTarget) => (t === 'bcp' ? '/bcp/login' : '/login');
const callbackPath = (t: SsoTarget) => (t === 'bcp' ? '/bcp/sso/callback' : '/sso/callback');

// ── GET /providers ────────────────────────────────────────────────────────────
ssoRouter.get('/providers', async (_req: Request, res: Response) => {
  try {
    res.set('Cache-Control', 'no-store').json(await listPublicProviders());
  } catch (err) {
    log.error({ err }, 'SSO provider list failed');
    res.json([]);
  }
});

// ── GET /:providerId/start ────────────────────────────────────────────────────
ssoRouter.get('/:providerId/start', async (req: Request, res: Response) => {
  const target: SsoTarget = req.query['target'] === 'bcp' ? 'bcp' : 'mwa';
  try {
    const r = await startSso(String(req.params['providerId']), target, await publicBaseUrl());
    if (!r.ok) { res.redirect(302, `${loginPath(target)}?sso_error=${r.error}`); return; }
    res.setHeader('Set-Cookie', cookieHeader(req, r.cookie, SSO_STATE_TTL));
    res.set('Cache-Control', 'no-store').redirect(302, r.url);
  } catch (err) {
    log.error({ err }, 'SSO start failed');
    res.redirect(302, `${loginPath(target)}?sso_error=provider_unavailable`);
  }
});

// ── GET /:providerId/callback ─────────────────────────────────────────────────
ssoRouter.get('/:providerId/callback', async (req: Request, res: Response) => {
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.query)) if (typeof v === 'string') params[k] = v;
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  try {
    const r = await completeSsoCallback(String(req.params['providerId']), params, readCookie(req, SSO_COOKIE), clientInfo(req));
    if (!r.ok) { res.redirect(302, `${loginPath(r.target)}?sso_error=${r.error}`); return; }
    res.redirect(302, `${callbackPath(r.target)}?code=${encodeURIComponent(r.code)}`);
  } catch (err) {
    log.error({ err }, 'SSO callback failed');
    res.redirect(302, `${loginPath('mwa')}?sso_error=token_invalid`);
  }
});

// ── POST /exchange ────────────────────────────────────────────────────────────
ssoRouter.post('/exchange', async (req: Request, res: Response) => {
  const code = (req.body as { code?: unknown } | undefined)?.code;
  res.set('Cache-Control', 'no-store');
  try {
    const r = await exchangeSsoCode(typeof code === 'string' ? code : '', readCookie(req, SSO_COOKIE), clientInfo(req));
    if (r.kind === 'invalid') { res.status(401).json({ error: 'SSO login expired or invalid — please try again' }); return; }
    res.setHeader('Set-Cookie', cookieHeader(req, '', 0)); // binding cookie no longer needed
    if (r.kind === 'maintenance') { res.status(503).json({ error: 'maintenance', message: r.message }); return; }
    if (r.kind === 'protocol_disabled') { res.status(403).json(protocolDisabledBody('webmail')); return; }
    if (r.kind === 'mfa') { res.json({ mfaRequired: true, challengeToken: r.challengeToken, method: r.method, methods: r.methods }); return; }
    // v8.1: like /auth/login — browser clients (X-CoreMail-Client: web, BCP with
    // X-CoreMail-App: bcp) get the refresh token as HttpOnly cookie only.
    const out = tokenPairResponse(req, r.tokens);
    if (out.setCookie) res.append('Set-Cookie', out.setCookie);
    res.json(out.body);
  } catch (err) {
    log.error({ err }, 'SSO exchange failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});
