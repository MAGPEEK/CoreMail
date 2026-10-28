/**
 * Auth routes directly in the api-gateway — no HTTP proxy needed.
 * Login / refresh / logout / password reset without a detour via auth-service.
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createTransport } from 'nodemailer';
import { prisma } from '@coremail/storage';
import { signAccessToken, signRefreshToken, verifyRefreshToken, createLogger, getRedisClient, verifyPassword } from '@coremail/core';
import type { UserRole } from '@coremail/core/types';

const log = createLogger('api:auth');
export const authRouter: RouterType = Router();

const MFA_CHALLENGE_TTL    = 10 * 60; // 10 minutes
const MFA_CHALLENGE_PREFIX = 'auth:mfa:challenge:';

// Password reset: rate limit in Redis (3 requests per IP/email per hour)
const RESET_RATE_PREFIX  = 'pwreset:rate:';
const RESET_RATE_LIMIT   = 3;
const RESET_RATE_WINDOW  = 3600; // 1 hour in seconds
const RESET_TOKEN_TTL    = 15 * 60; // 15 minutes

/** SHA-256 hash of a token string. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Sends an email via internal SMTP submission (localhost:587). */
async function sendResetEmail(to: string, resetUrl: string): Promise<void> {
  const settings = await prisma.serverSettings.findUnique({ where: { id: 'singleton' } });
  const fromAddr = settings?.adminEmail?.trim() || `noreply@${settings?.publicHostname || 'mail.local'}`;
  const orgName  = settings?.orgName || 'CoreMail';

  const transport = createTransport({
    host: '127.0.0.1',
    port: 587,
    secure: false,
    ignoreTLS: true, // internal, no TLS needed
    tls: { rejectUnauthorized: false },
  });

  await transport.sendMail({
    from: `"${orgName}" <${fromAddr}>`,
    to,
    subject: `${orgName} — Passwort zurücksetzen`,
    text: `Guten Tag,\n\njemand (oder Sie selbst) hat eine Passwort-Zurücksetzung für Ihr Konto angefordert.\n\nKlicken Sie auf den folgenden Link, um ein neues Passwort zu setzen (gültig für 15 Minuten):\n\n${resetUrl}\n\nFalls Sie diese Anfrage nicht gestellt haben, können Sie diese E-Mail ignorieren.\nIhr Konto ist weiterhin sicher.\n\n– ${orgName}`,
    html: `<p>Guten Tag,</p><p>jemand (oder Sie selbst) hat eine Passwort-Zurücksetzung für Ihr Konto angefordert.</p><p><a href="${resetUrl}" style="display:inline-block;padding:10px 20px;background:#4f46e5;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold;">Passwort zurücksetzen</a></p><p style="font-size:12px;color:#6b7280;">Dieser Link ist 15 Minuten gültig. Falls Sie diese Anfrage nicht gestellt haben, können Sie diese E-Mail ignorieren.</p><p>– ${orgName}</p>`,
  });
}

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

    // verifyPassword uses sha256(password + PEPPER) → bcrypt — same logic as hashPassword
    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      log.warn({ email }, 'Login failed: wrong password');
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    // ── MFA check ──────────────────────────────────────────────────────────────
    const mfa = await prisma.userMfa.findUnique({ where: { userId: user.id } });
    const mfaEnabled = mfa?.totpEnabled === true ||
      (Array.isArray(mfa?.webAuthnCredentials) && (mfa?.webAuthnCredentials as unknown[]).length > 0);

    if (mfaEnabled) {
      const method = (Array.isArray(mfa?.webAuthnCredentials) && (mfa?.webAuthnCredentials as unknown[]).length > 0)
        ? 'webauthn' : 'totp';
      const challengeToken = randomBytes(32).toString('hex');
      const redis = getRedisClient();
      await redis.setex(
        `${MFA_CHALLENGE_PREFIX}${challengeToken}`,
        MFA_CHALLENGE_TTL,
        JSON.stringify({ userId: user.id, method }),
      );
      log.info({ userId: user.id, method }, 'MFA challenge issued');
      res.status(200).json({ mfaRequired: true, challengeToken, method });
      return;
    }

    // ── No MFA — issue tokens directly ─────────────────────────────────────────
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

// ── POST /auth/forgot-password ────────────────────────────────────────────────
// Security principles:
//   1. No user enumeration: the response is always identical (200 OK)
//   2. Rate limit: max 3 requests per IP + email per hour (Redis)
//   3. Token: crypto.randomBytes(32) = 256 bit entropy
//   4. Token in DB: SHA-256 hash (never plaintext)
//   5. Only active when GlobalSettings.selfServicePasswordReset = true
authRouter.post('/forgot-password', async (req: Request, res: Response) => {
  const parsed = z.object({ email: z.string().email() }).safeParse(req.body);
  if (!parsed.success) {
    // Same response — no fingerprinting
    res.json({ ok: true });
    return;
  }
  const { email } = parsed.data;
  const ip = req.ip ?? 'unknown';

  // Always return the same response — no user enumeration possible
  const ALWAYS_OK = () => res.json({ ok: true });

  try {
    // 1. Check feature flag
    const settings = await prisma.serverSettings.findUnique({ where: { id: 'singleton' } });
    if (settings?.selfServicePasswordReset === false) {
      log.info({ email, ip }, 'Password reset disabled by admin');
      ALWAYS_OK(); return;
    }

    // 2. Check rate limit (per IP + per email — both keys)
    const redis = getRedisClient();
    const rateKeyIp    = `${RESET_RATE_PREFIX}ip:${ip}`;
    const rateKeyEmail = `${RESET_RATE_PREFIX}email:${email.toLowerCase()}`;

    const [ipCount, emailCount] = await Promise.all([
      redis.incr(rateKeyIp),
      redis.incr(rateKeyEmail),
    ]);
    // Set TTL only on the first increment
    if (ipCount === 1) await redis.expire(rateKeyIp, RESET_RATE_WINDOW);
    if (emailCount === 1) await redis.expire(rateKeyEmail, RESET_RATE_WINDOW);

    if (ipCount > RESET_RATE_LIMIT || emailCount > RESET_RATE_LIMIT) {
      log.warn({ email, ip, ipCount, emailCount }, 'Password reset rate limit exceeded');
      ALWAYS_OK(); return; // No error response — no enumeration
    }

    // 3. Look up user (active LOCAL users only)
    const user = await prisma.user.findFirst({
      where: { email: email.toLowerCase(), active: true, authSource: 'LOCAL' },
      select: { id: true, email: true },
    });

    if (!user) {
      log.info({ email }, 'Password reset: user not found or not local — silently ignored');
      ALWAYS_OK(); return;
    }

    // 4. Delete old tokens (max 1 active token per user)
    await prisma.passwordResetToken.deleteMany({
      where: { userId: user.id, usedAt: null },
    });

    // 5. Generate and hash a new token
    const rawToken = randomBytes(32).toString('hex'); // 64-char hex, 256 bit
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL * 1000);

    await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash, expiresAt, ipAddress: ip },
    });

    // 6. Build the reset URL
    const base = settings?.useHttps
      ? `https://${settings.publicHostname}`
      : `http://${settings?.publicHostname ?? 'localhost'}:${settings?.httpPort ?? 3000}`;
    const resetUrl = `${base}/reset-password?token=${rawToken}`;

    // 7. Send email (fire-and-forget — log errors, but do not expose to the user)
    sendResetEmail(user.email, resetUrl).catch((err) => {
      log.error({ err, email: user.email }, 'Failed to send password reset email');
    });

    log.info({ userId: user.id, email: user.email }, 'Password reset token issued');
    ALWAYS_OK();
  } catch (err) {
    log.error({ err, email, ip }, 'forgot-password error');
    ALWAYS_OK(); // Even on error: leak no information
  }
});

// ── POST /auth/reset-password ─────────────────────────────────────────────────
// Takes the plaintext token + new password and sets the password.
// Security principles:
//   1. Token is SHA-256 hashed and checked against the DB
//   2. Token must not be expired and not already used
//   3. Password is hashed with bcrypt + pepper
//   4. All sessions of the user become invalid after the reset
const ResetPasswordSchema = z.object({
  token:       z.string().min(32).max(128),
  newPassword: z.string().min(1).max(128),
});

authRouter.post('/reset-password', async (req: Request, res: Response) => {
  const parsed = ResetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Ungültige Anfrage' });
    return;
  }
  const { token, newPassword } = parsed.data;
  const ip = req.ip ?? 'unknown';

  try {
    // 1. Hash token + look it up in the DB
    const tokenHash = hashToken(token);
    const resetToken = await prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      include: { user: { select: { id: true, email: true, active: true } } },
    });

    if (!resetToken || resetToken.usedAt !== null || resetToken.expiresAt < new Date()) {
      log.warn({ ip }, 'Password reset: invalid or expired token');
      res.status(400).json({ error: 'Der Link ist ungültig oder abgelaufen. Bitte fordern Sie einen neuen an.' });
      return;
    }

    if (!resetToken.user.active) {
      res.status(400).json({ error: 'Dieses Konto ist deaktiviert.' });
      return;
    }

    // 2. Check password policy
    const settings = await prisma.serverSettings.findUnique({ where: { id: 'singleton' } });
    const minLen = settings?.minPasswordLength ?? 8;
    if (newPassword.length < minLen) {
      res.status(400).json({ error: `Das Passwort muss mindestens ${minLen} Zeichen lang sein.` });
      return;
    }

    // 3. Hash new password — hashPassword uses sha256(password + PEPPER) → bcrypt
    const { hashPassword } = await import('@coremail/core');
    const passwordHash = await hashPassword(newPassword);

    // 4. Mark token as used + set password + delete all sessions (atomic via transaction)
    await prisma.$transaction([
      prisma.passwordResetToken.update({
        where: { id: resetToken.id },
        data: { usedAt: new Date() },
      }),
      prisma.user.update({
        where: { id: resetToken.user.id },
        data: { passwordHash },
      }),
      prisma.session.deleteMany({
        where: { userId: resetToken.user.id },
      }),
    ]);

    log.info({ userId: resetToken.user.id, email: resetToken.user.email, ip }, 'Password reset successful');
    res.json({ ok: true });
  } catch (err) {
    log.error({ err, ip }, 'reset-password error');
    res.status(500).json({ error: 'Interner Fehler. Bitte versuchen Sie es später erneut.' });
  }
});

// ── GET /auth/reset-password/verify ──────────────────────────────────────────
// Checks whether a token is still valid (for frontend feedback before the form)
authRouter.get('/reset-password/verify', async (req: Request, res: Response) => {
  const token = typeof req.query['token'] === 'string' ? req.query['token'] : '';
  if (!token || token.length < 32) {
    res.status(400).json({ valid: false });
    return;
  }
  try {
    const tokenHash = hashToken(token);
    const resetToken = await prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      select: { usedAt: true, expiresAt: true },
    });
    const valid = !!resetToken && resetToken.usedAt === null && resetToken.expiresAt > new Date();
    res.json({ valid });
  } catch {
    res.status(500).json({ valid: false });
  }
});
