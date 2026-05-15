/**
 * Auth-Routen direkt im api-gateway — kein HTTP-Proxy nötig.
 * Login / Refresh / Logout ohne Umweg über auth-service.
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import { prisma } from '@coremail/storage';
import { signAccessToken, signRefreshToken, verifyRefreshToken, createLogger } from '@coremail/core';
import type { UserRole } from '@coremail/core/types';

const log = createLogger('api:auth');
export const authRouter: RouterType = Router();

const LoginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
});

const RefreshSchema = z.object({
  refreshToken: z.string(),
});

// ── POST /auth/login ──────────────────────────────────────────────────────────
authRouter.post('/login', async (req: Request, res: Response) => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }

  const { email, password } = parsed.data;

  try {
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      include: { domain: true },
    });

    if (!user || !user.active || !user.passwordHash) {
      log.warn({ email }, 'Login failed: user not found or inactive');
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const pepper = process.env['PEPPER'] ?? '';
    const valid = await bcrypt.compare(password + pepper, user.passwordHash);
    if (!valid) {
      log.warn({ email }, 'Login failed: wrong password');
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const sessionId = randomUUID();
    const accessToken = signAccessToken({
      sub:        user.id,
      email:      user.email,
      role:       user.role as UserRole,
      domainId:   user.domainId,
      sessionId,
      mfaVerified: false,
    });
    const refreshToken = signRefreshToken(user.id, sessionId);

    await prisma.session.create({
      data: {
        userId:    user.id,
        tokenHash: refreshToken,
        ipAddress: req.ip ?? 'unknown',
        userAgent: req.get('user-agent') ?? '',
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    log.info({ userId: user.id }, 'Login successful');
    res.json({ accessToken, refreshToken, expiresIn: 900 });
  } catch (err) {
    log.error({ err }, 'Login error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /auth/refresh ────────────────────────────────────────────────────────
authRouter.post('/refresh', async (req: Request, res: Response) => {
  const parsed = RefreshSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }

  try {
    const payload = verifyRefreshToken(parsed.data.refreshToken);
    const session = await prisma.session.findUnique({
      where: { tokenHash: parsed.data.refreshToken },
    });

    if (!session || session.expiresAt < new Date()) {
      res.status(401).json({ error: 'Session expired' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { id: true, email: true, role: true, domainId: true },
    });
    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }

    const accessToken = signAccessToken({
      sub:        user.id,
      email:      user.email,
      role:       user.role as UserRole,
      domainId:   user.domainId,
      sessionId:  payload.sessionId,
      mfaVerified: false,
    });
    res.json({ accessToken, expiresIn: 900 });
  } catch {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// ── POST /auth/logout ─────────────────────────────────────────────────────────
authRouter.post('/logout', async (req: Request, res: Response) => {
  const token = (req.body as { refreshToken?: string })?.refreshToken;
  if (token) {
    await prisma.session.deleteMany({ where: { tokenHash: token } }).catch(() => null);
  }
  res.json({ ok: true });
});
