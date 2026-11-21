/**
 * auth-service login endpoints — v7.0.0: thin delegates to the single login
 * service in @coremail/storage/auth (same code as the api-gateway's /auth/*).
 *
 * The api-gateway serves /auth/login, /auth/refresh and /auth/logout itself and
 * proxies /auth/mfa/* here, so /auth/mfa/verify (which needs WebAuthn) lives in
 * this service. /auth/login stays available for internal callers (CalDAV and
 * JMAP Basic-auth fallbacks).
 *
 * v8.1: token-issuing answers go through sendOutcome(): browser clients
 * (`X-CoreMail-Client: web`) get the refresh token only as the HttpOnly cookie
 * cm_rt / cm_rt_bcp (Path=/auth, passed through by the gateway proxy); a locked
 * account answers 429 ACCOUNT_LOCKED with Retry-After.
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@coremail/core';
import {
  login,
  completeMfaLogin,
  loginOutcomeToHttp,
  rotateSession,
  revokeSessionByRefreshToken,
  tokenPairResponse,
  protocolDisabledBody,
  clientInfoOf,
  type LoginOutcome,
} from '@coremail/storage/auth';
import { finishWebAuthnAuthentication } from '../mfa/webauthn.js';

const log = createLogger('auth:router');

function sendOutcome(req: Request, res: Response, outcome: LoginOutcome): void {
  if (outcome.kind === 'tokens') {
    const r = tokenPairResponse(req, outcome.tokens);
    if (r.setCookie) res.append('Set-Cookie', r.setCookie);
    res.json(r.body);
    return;
  }
  const { status, body, headers } = loginOutcomeToHttp(outcome);
  if (headers) res.set(headers);
  res.status(status).json(body);
}

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(1024),
});

const MfaVerifySchema = z.object({
  challengeToken: z.string().min(1).max(128),
  /** 6-digit TOTP code or a backup code (XXXX-XXXX). */
  code: z.string().max(64).optional(),
  /** Deprecated alias for backup codes — use `code`. */
  backupCode: z.string().max(64).optional(),
  webauthnResponse: z.unknown().optional(),
});

const RefreshSchema = z.object({
  refreshToken: z.string().min(1).max(4096),
});

export const authRouter: RouterType = Router();

authRouter.post('/login', async (req: Request, res: Response) => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }
  try {
    sendOutcome(req, res, await login(parsed.data.email, parsed.data.password, clientInfoOf(req)));
  } catch (err) {
    log.error({ err }, 'Login error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

authRouter.post('/mfa/verify', async (req: Request, res: Response) => {
  const parsed = MfaVerifySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }
  const { challengeToken, code, backupCode, webauthnResponse } = parsed.data;
  try {
    const outcome = await completeMfaLogin(
      {
        challengeToken,
        ...(code !== undefined ? { code } : {}),
        ...(backupCode !== undefined ? { backupCode } : {}),
        ...(webauthnResponse !== undefined ? { webauthnResponse } : {}),
      },
      clientInfoOf(req),
      {
        verifyWebAuthn: (userId, response, token) => finishWebAuthnAuthentication(userId, response, token, req.ip),
      },
    );
    sendOutcome(req, res, outcome);
  } catch (err) {
    log.error({ err }, 'MFA verify error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

authRouter.post('/refresh', async (req: Request, res: Response) => {
  const parsed = RefreshSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }
  try {
    const r = await rotateSession(parsed.data.refreshToken, clientInfoOf(req));
    if (r.ok) { res.json(r.tokens); return; }
    if (r.status === 503) { res.status(503).json({ error: 'maintenance', message: r.message }); return; }
    if (r.status === 403) { res.status(403).json(protocolDisabledBody('webmail')); return; }
    res.status(401).json({ error: r.reason === 'expired' ? 'Session expired' : 'Invalid refresh token', code: `REFRESH_${r.reason.toUpperCase()}` });
  } catch (err) {
    log.error({ err }, 'Refresh error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

authRouter.post('/logout', async (req: Request, res: Response) => {
  const token = (req.body as { refreshToken?: unknown } | undefined)?.refreshToken;
  if (typeof token === 'string' && token.length > 0 && token.length <= 4096) {
    await revokeSessionByRefreshToken(token).catch((err) => log.error({ err }, 'Logout error'));
  }
  res.json({ ok: true });
});
