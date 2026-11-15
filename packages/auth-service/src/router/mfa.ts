/**
 * MFA management (/auth/mfa/*).
 *
 * v7.0.0: every change of the second factor requires re-authentication in the
 * request body — `currentPassword` or `mfaCode` (TOTP or backup code):
 *   POST   /totp/setup                { currentPassword | mfaCode }   (409 while TOTP is enabled)
 *   POST   /totp/confirm              { code }                         (code of the NEW secret)
 *   DELETE /totp                      { currentPassword | mfaCode }
 *   POST   /backup-codes/generate     { currentPassword | mfaCode }
 *   POST   /webauthn/register/start   { email, currentPassword | mfaCode }
 *   POST   /webauthn/register/finish  { response, name }               (needs the start challenge)
 *   POST   /webauthn/auth/start       { challengeToken }               (pending MFA login challenge)
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { verifyAccessToken, createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage';
import { verifyReauth, reauthErrorBody, getMfaChallenge, isAccessTokenRevokedShared } from '@coremail/storage/auth';
import {
  setupTotp,
  confirmTotp,
  disableTotp,
  generateBackupCodes,
  startWebAuthnRegistration,
  finishWebAuthnRegistration,
  startWebAuthnAuthentication,
} from '../mfa/index.js';

const log = createLogger('auth:mfa-router');

export const mfaRouter: RouterType = Router();

async function getAuthenticatedUserId(req: Request): Promise<string | null> {
  const header = req.get('Authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const payload = verifyAccessToken(header.slice(7));
  if (!payload || await isAccessTokenRevokedShared(payload.sub, payload.iat, payload.sessionId)) return null;
  return payload.sub;
}

/** Runs the re-auth check; sends the error response and returns false on failure. */
async function requireReauth(req: Request, res: Response, userId: string): Promise<boolean> {
  const body = (req.body ?? {}) as { currentPassword?: unknown; mfaCode?: unknown };
  const r = await verifyReauth(userId, { currentPassword: body.currentPassword, mfaCode: body.mfaCode });
  if (r === 'ok') return true;
  const { status, body: err } = reauthErrorBody(r);
  log.warn({ userId, path: req.path, result: r }, 'MFA change rejected — re-authentication failed');
  res.status(status).json(err);
  return false;
}

type Handler = (req: Request, res: Response, userId: string) => Promise<void>;
/** Bearer auth + error handling for the authenticated MFA routes. */
function authed(fn: Handler) {
  return async (req: Request, res: Response): Promise<void> => {
    const userId = await getAuthenticatedUserId(req);
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
    try {
      await fn(req, res, userId);
    } catch (err) {
      log.error({ err, userId, path: req.path }, 'MFA route error');
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    }
  };
}

// Status — which MFA methods are active for the current user?
mfaRouter.get('/status', authed(async (_req, res, userId) => {
  const mfa = await prisma.userMfa.findUnique({ where: { userId } });
  res.json({
    totpEnabled:      mfa?.totpEnabled ?? false,
    webauthnCount:    Array.isArray(mfa?.webAuthnCredentials) ? (mfa.webAuthnCredentials as unknown[]).length : 0,
    // Used codes are removed from the array — the array length is what is left.
    backupCodesCount: mfa?.backupCodes?.length ?? 0,
  });
}));

// TOTP
mfaRouter.post('/totp/setup', authed(async (req, res, userId) => {
  const existing = await prisma.userMfa.findUnique({ where: { userId }, select: { totpEnabled: true } });
  if (existing?.totpEnabled) {
    res.status(409).json({ error: 'TOTP is already enabled — disable it first', code: 'TOTP_ALREADY_ENABLED' });
    return;
  }
  if (!(await requireReauth(req, res, userId))) return;
  const accountName = typeof req.body?.accountName === 'string' && req.body.accountName ? req.body.accountName : userId;
  res.json(await setupTotp(userId, 'CoreMail', accountName));
}));

mfaRouter.post('/totp/confirm', authed(async (req, res, userId) => {
  const parsed = z.object({ code: z.string().regex(/^\d{6}$/) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid code' }); return; }
  const ok = await confirmTotp(userId, parsed.data.code);
  if (!ok) { res.status(400).json({ error: 'Invalid TOTP code' }); return; }
  res.json({ ok: true });
}));

mfaRouter.delete('/totp', authed(async (req, res, userId) => {
  if (!(await requireReauth(req, res, userId))) return;
  await disableTotp(userId);
  log.info({ userId }, 'TOTP disabled');
  res.json({ ok: true });
}));

// Backup codes
mfaRouter.post('/backup-codes/generate', authed(async (req, res, userId) => {
  if (!(await requireReauth(req, res, userId))) return;
  const codes = await generateBackupCodes(userId);
  log.info({ userId }, 'Backup codes regenerated');
  res.json({ codes });
}));

// WebAuthn registration
mfaRouter.post('/webauthn/register/start', authed(async (req, res, userId) => {
  const parsed = z.object({ email: z.string().email() }).passthrough().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Email required' }); return; }
  if (!(await requireReauth(req, res, userId))) return;
  res.json(await startWebAuthnRegistration(userId, parsed.data.email));
}));

mfaRouter.post('/webauthn/register/finish', authed(async (req, res, userId) => {
  const parsed = z.object({ response: z.unknown(), name: z.string().min(1).max(100) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }
  const ok = await finishWebAuthnRegistration(
    userId,
    parsed.data.response as Parameters<typeof finishWebAuthnRegistration>[1],
    parsed.data.name,
  );
  if (!ok) { res.status(400).json({ error: 'WebAuthn registration failed' }); return; }
  res.json({ ok: true });
}));

// WebAuthn authentication start (second factor of a pending login).
// v7.0.0: requires the MFA challengeToken from /auth/login — no longer any userId.
mfaRouter.post('/webauthn/auth/start', async (req: Request, res: Response) => {
  const parsed = z.object({ challengeToken: z.string().min(1).max(128) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'challengeToken required' }); return; }
  try {
    const challenge = await getMfaChallenge(parsed.data.challengeToken);
    if (!challenge || !challenge.methods.includes('webauthn')) {
      res.status(401).json({ error: 'MFA challenge expired or invalid' });
      return;
    }
    const options = await startWebAuthnAuthentication(challenge.userId, parsed.data.challengeToken);
    if (!options) { res.status(404).json({ error: 'No WebAuthn credentials found' }); return; }
    res.json(options);
  } catch (err) {
    log.error({ err }, 'WebAuthn auth start error');
    res.status(500).json({ error: 'Internal server error' });
  }
});
