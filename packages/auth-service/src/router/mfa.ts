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
import { createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage';
import { verifyReauth, reauthErrorBody, getMfaChallenge, getAuthFactors } from '@coremail/storage/auth';
import {
  setupTotp,
  confirmTotp,
  disableTotp,
  generateBackupCodes,
  startWebAuthnRegistration,
  finishWebAuthnRegistration,
  startWebAuthnAuthentication,
} from '../mfa/index.js';
import { requireBearerUser } from './bearer.js';

const log = createLogger('auth:mfa-router');

export const mfaRouter: RouterType = Router();

/** Runs the re-auth check; sends the error response and returns false on failure. */
export async function requireReauth(req: Request, res: Response, userId: string): Promise<boolean> {
  const body = (req.body ?? {}) as { currentPassword?: unknown; mfaCode?: unknown; webauthnFlowId?: unknown; webauthnResponse?: unknown };
  // 10.6: a passkey assertion (webauthnFlowId + webauthnResponse) is accepted as well
  const r = await verifyReauth(userId, {
    currentPassword: body.currentPassword, mfaCode: body.mfaCode,
    webauthnFlowId: body.webauthnFlowId, webauthnResponse: body.webauthnResponse,
  });
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
    const userId = await requireBearerUser(req, res);
    if (!userId) return;
    try {
      await fn(req, res, userId);
    } catch (err) {
      log.error({ err, userId, path: req.path }, 'MFA route error');
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    }
  };
}

// Status — which MFA methods are active for the current user?
// 10.6: from the central factor helper; webauthnCount = security keys + passkeys.
mfaRouter.get('/status', authed(async (_req, res, userId) => {
  const f = await getAuthFactors(userId);
  res.json({
    totpEnabled:      f.totp,
    webauthnCount:    f.webauthn,
    passkeyCount:     f.passkeys,
    securityKeyCount: f.securityKeys,
    // Used codes are removed from the array — the array length is what is left.
    backupCodesCount: f.backupCodes,
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

// WebAuthn registration — DEPRECATED (10.6, removed with the next MAJOR): registers a
// second-factor-only security key into the WebAuthnCredential table (kind
// security_key). New clients use /auth/passkeys/registration/*.
mfaRouter.post('/webauthn/register/start', authed(async (req, res, userId) => {
  res.set('Deprecation', 'true');
  const parsed = z.object({ email: z.string().email() }).passthrough().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Email required' }); return; }
  if (!(await requireReauth(req, res, userId))) return;
  // The account's own address, never the one in the body (it only names the key in the authenticator UI).
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, displayName: true } });
  res.json(await startWebAuthnRegistration(userId, user?.email ?? parsed.data.email, user?.displayName ?? undefined));
}));

mfaRouter.post('/webauthn/register/finish', authed(async (req, res, userId) => {
  res.set('Deprecation', 'true');
  const parsed = z.object({ response: z.unknown(), name: z.string().min(1).max(100) }).passthrough().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }
  const r = await finishWebAuthnRegistration(userId, parsed.data.response, parsed.data.name, req.ip);
  if (!r.ok) { res.status(r.code === 'PASSKEY_DUPLICATE' ? 409 : 400).json({ error: 'WebAuthn registration failed', code: r.code }); return; }
  res.json({ ok: true, credential: r.credential });
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
