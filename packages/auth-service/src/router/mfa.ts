import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { verifyAccessToken, createLogger } from '@coremail/core';
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

function getAuthenticatedUserId(req: Request): string | null {
  const header = req.get('Authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const payload = verifyAccessToken(header.slice(7));
  return payload?.sub ?? null;
}

// Status — welche MFA-Methoden sind für den aktuellen User aktiv?
mfaRouter.get('/status', async (req: Request, res: Response) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const { prisma } = await import('@coremail/storage');
  const mfa = await prisma.userMfa.findUnique({ where: { userId } });

  res.json({
    totpEnabled:    mfa?.totpEnabled ?? false,
    webauthnCount:  Array.isArray(mfa?.webAuthnCredentials) ? (mfa?.webAuthnCredentials as unknown[]).length : 0,
    backupCodesCount: (mfa?.backupCodes?.length ?? 0) - (mfa?.backupCodesUsed ?? 0),
  });
});

// TOTP
mfaRouter.post('/totp/setup', async (req: Request, res: Response) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const result = await setupTotp(userId, 'CoreMail', req.body?.accountName ?? userId);
  res.json(result);
});

mfaRouter.post('/totp/confirm', async (req: Request, res: Response) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const schema = z.object({ code: z.string().length(6) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid code' }); return; }

  const ok = await confirmTotp(userId, parsed.data.code);
  if (!ok) { res.status(400).json({ error: 'Invalid TOTP code' }); return; }
  res.json({ ok: true });
});

mfaRouter.delete('/totp', async (req: Request, res: Response) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
  await disableTotp(userId);
  res.json({ ok: true });
});

// Backup codes
mfaRouter.post('/backup-codes/generate', async (req: Request, res: Response) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const codes = await generateBackupCodes(userId);
  res.json({ codes });
});

// WebAuthn registration
mfaRouter.post('/webauthn/register/start', async (req: Request, res: Response) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const schema = z.object({ email: z.string().email() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Email required' }); return; }

  const options = await startWebAuthnRegistration(userId, parsed.data.email);
  res.json(options);
});

mfaRouter.post('/webauthn/register/finish', async (req: Request, res: Response) => {
  const userId = getAuthenticatedUserId(req);
  if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const schema = z.object({ response: z.unknown(), name: z.string().min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }

  const ok = await finishWebAuthnRegistration(
    userId,
    parsed.data.response as Parameters<typeof finishWebAuthnRegistration>[1],
    parsed.data.name,
  );

  if (!ok) { res.status(400).json({ error: 'WebAuthn registration failed' }); return; }
  res.json({ ok: true });
});

// WebAuthn authentication start (for MFA flow)
mfaRouter.post('/webauthn/auth/start', async (req: Request, res: Response) => {
  const schema = z.object({ userId: z.string() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'userId required' }); return; }

  const options = await startWebAuthnAuthentication(parsed.data.userId);
  if (!options) { res.status(404).json({ error: 'No WebAuthn credentials found' }); return; }
  res.json(options);
});
