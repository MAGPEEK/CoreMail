import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getPrisma } from '@coremail/storage';
import { signAccessToken, signRefreshToken, verifyRefreshToken, createLogger } from '@coremail/core';
import { authenticateLocal } from '../local/index.js';
import { isMfaEnabled, createMfaChallenge, verifyMfaChallenge } from '../mfa/index.js';

const log = createLogger('auth:router');

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const MfaVerifySchema = z.object({
  challengeToken: z.string(),
  code: z.string().optional(),
  backupCode: z.string().optional(),
  webauthnResponse: z.unknown().optional(),
});

const RefreshSchema = z.object({
  refreshToken: z.string(),
});

export const authRouter = Router();

authRouter.post('/login', async (req: Request, res: Response) => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    return;
  }

  const { email, password } = parsed.data;
  const ip = req.ip ?? 'unknown';

  let result = await authenticateLocal(email, password);

  // Try LDAP if local fails
  if (!result) {
    try {
      const { authenticateLdap } = await import('@coremail/auth-ldap');
      result = await authenticateLdap(email, password);
    } catch {
      // auth-ldap not available or LDAP not configured
    }
  }

  if (!result) {
    log.warn({ email, ip }, 'Login failed');
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const mfaEnabled = await isMfaEnabled(result.userId);
  if (mfaEnabled) {
    const challenge = await createMfaChallenge(result.userId);
    log.info({ userId: result.userId, method: challenge.method }, 'MFA challenge issued');
    res.status(200).json({
      mfaRequired: true,
      challengeToken: challenge.challengeToken,
      method: challenge.method,
    });
    return;
  }

  const accessToken = signAccessToken({ userId: result.userId, role: result.role });
  const refreshToken = signRefreshToken({ userId: result.userId });

  // Persist session
  const prisma = getPrisma();
  await prisma.session.create({
    data: {
      userId: result.userId,
      token: refreshToken,
      ipAddress: ip,
      userAgent: req.get('user-agent') ?? '',
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });

  log.info({ userId: result.userId, source: result.source }, 'Login successful');
  res.json({ accessToken, refreshToken, expiresIn: 900 });
});

authRouter.post('/mfa/verify', async (req: Request, res: Response) => {
  const parsed = MfaVerifySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }

  const userId = await verifyMfaChallenge(parsed.data.challengeToken, {
    code: parsed.data.code,
    backupCode: parsed.data.backupCode,
    webauthnResponse: parsed.data.webauthnResponse,
  });

  if (!userId) {
    log.warn({ challengeToken: parsed.data.challengeToken }, 'MFA verification failed');
    res.status(401).json({ error: 'MFA verification failed' });
    return;
  }

  const prisma = getPrisma();
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    res.status(401).json({ error: 'User not found' });
    return;
  }

  const accessToken = signAccessToken({ userId: user.id, role: user.role });
  const refreshToken = signRefreshToken({ userId: user.id });

  await prisma.session.create({
    data: {
      userId: user.id,
      token: refreshToken,
      ipAddress: req.ip ?? 'unknown',
      userAgent: req.get('user-agent') ?? '',
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });

  log.info({ userId }, 'MFA verified — login complete');
  res.json({ accessToken, refreshToken, expiresIn: 900 });
});

authRouter.post('/refresh', async (req: Request, res: Response) => {
  const parsed = RefreshSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }

  const payload = verifyRefreshToken(parsed.data.refreshToken);
  if (!payload) {
    res.status(401).json({ error: 'Invalid refresh token' });
    return;
  }

  const prisma = getPrisma();
  const session = await prisma.session.findUnique({
    where: { token: parsed.data.refreshToken },
    include: { user: true },
  });

  if (!session || session.expiresAt < new Date()) {
    res.status(401).json({ error: 'Session expired' });
    return;
  }

  const accessToken = signAccessToken({ userId: session.userId, role: session.user.role });
  res.json({ accessToken, expiresIn: 900 });
});

authRouter.post('/logout', async (req: Request, res: Response) => {
  const token = req.body?.refreshToken as string | undefined;
  if (token) {
    const prisma = getPrisma();
    await prisma.session.deleteMany({ where: { token } });
  }
  res.json({ ok: true });
});
