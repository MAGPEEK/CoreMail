/**
 * Auth routes in the api-gateway (used by MWA, BCP and the admin CLI).
 *
 * v7.0.0: login / refresh / logout / password reset all go through the single
 * login service in `@coremail/storage/auth` (shared with the auth-service):
 *   POST /auth/login          → { accessToken, refreshToken, expiresIn }
 *                               | { mfaRequired: true, challengeToken, method, methods }
 *                               | 401 invalid credentials | 429 ACCOUNT_LOCKED (v8.1, shared lockout)
 *                               | 503 { error: 'maintenance', message }
 *   POST /auth/refresh        → rotates: { accessToken, refreshToken, expiresIn } (old token invalid)
 *   POST /auth/logout         → { ok: true } — revokes the session of { refreshToken }
 *   POST /auth/mfa/verify     → proxied to the auth-service (same login service)
 *
 * v8.1 browser clients (`X-CoreMail-Client: web`): the refresh token travels
 * only in the HttpOnly cookie cm_rt (BCP: cm_rt_bcp, `X-CoreMail-App: bcp`),
 * never in a body; /auth/refresh and /auth/logout accept the cookie when the
 * body has no refreshToken and the request is same-origin (Origin/Referer).
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { createTransport } from 'nodemailer';
import { prisma } from '@coremail/storage';
import {
  login,
  loginOutcomeToHttp,
  rotateSession,
  revokeSessionByRefreshToken,
  createPasswordResetToken,
  redeemPasswordReset,
  isResetTokenValid,
  RESET_TOKEN_TTL,
  registerAuthenticator,
  tokenPairResponse,
  readRefreshCookie,
  isSameOriginCookieRequest,
  clearRefreshCookieHeader,
  isWebClient,
  type TokenPair,
} from '@coremail/storage/auth';
import { ldapAuthenticator } from '@coremail/auth-ldap';
import { createLogger, getRedisClient } from '@coremail/core';

const log = createLogger('api:auth');
export const authRouter: RouterType = Router();

// First-factor extension point (v6.1): real LDAP / AD step — only for accounts
// with authSource LDAP, unknown users of an LDAP domain (first-login
// provisioning) or LOCAL accounts with the admin opt-in `allowLocalTakeover`.
// OIDC SSO has its own redirect flow (routes/sso.ts).
registerAuthenticator(ldapAuthenticator());

// Password reset: rate limit in Redis (3 requests per IP/email per hour)
const RESET_RATE_PREFIX  = 'pwreset:rate:';
const RESET_RATE_LIMIT   = 3;
const RESET_RATE_WINDOW  = 3600; // 1 hour in seconds

function clientInfo(req: Request): { ip: string; userAgent: string } {
  return { ip: req.ip ?? 'unknown', userAgent: req.get('user-agent') ?? '' };
}

/** Sends an email via internal SMTP submission (localhost:587). */
async function sendResetEmail(to: string, resetUrl: string): Promise<void> {
  const settings = await prisma.serverSettings.findUnique({ where: { id: 'singleton' } });
  const fromAddr = settings?.adminEmail?.trim() || `noreply@${settings?.publicHostname || 'mail.local'}`;
  const orgName  = settings?.orgName || 'CoreMail';
  const minutes  = Math.round(RESET_TOKEN_TTL / 60);

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
    text: `Guten Tag,\n\njemand (oder Sie selbst) hat eine Passwort-Zurücksetzung für Ihr Konto angefordert.\n\nKlicken Sie auf den folgenden Link, um ein neues Passwort zu setzen (gültig für ${minutes} Minuten):\n\n${resetUrl}\n\nFalls Sie diese Anfrage nicht gestellt haben, können Sie diese E-Mail ignorieren.\nIhr Konto ist weiterhin sicher.\n\n– ${orgName}`,
    html: `<p>Guten Tag,</p><p>jemand (oder Sie selbst) hat eine Passwort-Zurücksetzung für Ihr Konto angefordert.</p><p><a href="${resetUrl}" style="display:inline-block;padding:10px 20px;background:#4f46e5;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold;">Passwort zurücksetzen</a></p><p style="font-size:12px;color:#6b7280;">Dieser Link ist ${minutes} Minuten gültig. Falls Sie diese Anfrage nicht gestellt haben, können Sie diese E-Mail ignorieren.</p><p>– ${orgName}</p>`,
  });
}

const LoginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1).max(1024),
});

const RefreshSchema = z.object({
  refreshToken: z.string().min(1).max(4096).optional(),
}).passthrough();

// v8.1: browser clients (`X-CoreMail-Client: web`) get the refresh token as an
// HttpOnly SameSite=Strict cookie on Path=/auth (cm_rt, BCP: cm_rt_bcp) instead
// of the JSON body — see @coremail/storage/auth refresh-cookie.ts. Other clients
// (admin CLI) keep the body tokens.
function sendTokens(req: Request, res: Response, tokens: TokenPair, viaCookie = false): void {
  const r = tokenPairResponse(req, tokens, { viaCookie });
  if (r.setCookie) res.append('Set-Cookie', r.setCookie);
  res.json(r.body);
}

/** Refresh token of a refresh/logout request: body first (CLI, migration), then the cookie. */
async function refreshTokenOf(req: Request, res: Response): Promise<{ token: string; viaCookie: boolean } | null | 'rejected'> {
  const body = (req.body ?? {}) as { refreshToken?: unknown };
  if (typeof body.refreshToken === 'string' && body.refreshToken.length > 0) {
    return { token: body.refreshToken, viaCookie: false };
  }
  const cookie = readRefreshCookie(req);
  if (!cookie) return null;
  // The cookie is an ambient credential — require a same-origin page (CSRF).
  if (!(await isSameOriginCookieRequest(req))) {
    log.warn({ ip: req.ip, origin: req.get('origin') ?? null, referer: req.get('referer') ?? null }, 'Cookie refresh/logout refused — cross-origin');
    res.status(403).json({ error: 'Cross-origin request refused', code: 'ORIGIN_MISMATCH' });
    return 'rejected';
  }
  return { token: cookie, viaCookie: true };
}

// ── POST /auth/login ──────────────────────────────────────────────────────────
authRouter.post('/login', async (req: Request, res: Response) => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }
  try {
    const outcome = await login(parsed.data.email, parsed.data.password, clientInfo(req));
    if (outcome.kind === 'tokens') { sendTokens(req, res, outcome.tokens); return; }
    const { status, body, headers } = loginOutcomeToHttp(outcome);
    if (headers) res.set(headers);
    res.status(status).json(body);
  } catch (err) {
    log.error({ err }, 'Login error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /auth/refresh ────────────────────────────────────────────────────────
// Rotates the refresh token. A rotated (old) token presented again revokes the
// whole session (token theft detection) — clients must store the new token and
// must not refresh concurrently with the same token.
// v8.1: token from the body (CLI; one-time migration of a browser's old
// localStorage token) or from the cm_rt cookie (same-origin check). Browser
// clients get the rotated token back as cookie only.
authRouter.post('/refresh', async (req: Request, res: Response) => {
  const parsed = RefreshSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }
  const src = await refreshTokenOf(req, res);
  if (src === 'rejected') return;
  if (!src) { res.status(401).json({ error: 'Invalid refresh token', code: 'REFRESH_MISSING' }); return; }
  try {
    const r = await rotateSession(src.token, clientInfo(req));
    if (r.ok) { sendTokens(req, res, r.tokens, src.viaCookie); return; }
    if (r.status === 503) { res.status(503).json({ error: 'maintenance', message: r.message }); return; }
    if (src.viaCookie) res.append('Set-Cookie', clearRefreshCookieHeader(req));
    const error = r.reason === 'expired' ? 'Session expired' : 'Invalid refresh token';
    res.status(401).json({ error, code: `REFRESH_${r.reason.toUpperCase()}` });
  } catch (err) {
    log.error({ err }, 'Refresh error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /auth/logout ─────────────────────────────────────────────────────────
// Revokes the session of { refreshToken } or (v8.1) of the refresh cookie and
// always deletes the cookie.
authRouter.post('/logout', async (req: Request, res: Response) => {
  const src = await refreshTokenOf(req, res);
  if (src === 'rejected') return;
  if (src && src.token.length <= 4096) {
    try {
      await revokeSessionByRefreshToken(src.token);
    } catch (err) {
      log.error({ err }, 'Logout error');
      res.status(500).json({ error: 'Internal server error' });
      return;
    }
  }
  if (src?.viaCookie || isWebClient(req.headers) || readRefreshCookie(req)) {
    res.append('Set-Cookie', clearRefreshCookieHeader(req));
  }
  res.json({ ok: true });
});

// ── POST /auth/forgot-password ────────────────────────────────────────────────
// Security principles:
//   1. No user enumeration: the response is always identical (200 OK)
//   2. Rate limit: max 3 requests per IP + email per hour (Redis)
//   3. Token: crypto.randomBytes(32) = 256 bit entropy, stored as SHA-256 hash
//   4. Earlier links stay valid until they expire (v7.0.0) — a reset request by
//      an attacker cannot invalidate the victim's link
//   5. Only active when ServerSettings.selfServicePasswordReset = true
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

    // 4. New token (earlier unexpired tokens remain valid)
    const rawToken = await createPasswordResetToken(user.id, ip);

    // 5. Build the reset URL
    const base = settings?.useHttps
      ? `https://${settings.publicHostname}`
      : `http://${settings?.publicHostname ?? 'localhost'}:${settings?.httpPort ?? 3000}`;
    const resetUrl = `${base}/reset-password?token=${rawToken}`;

    // 6. Send email (fire-and-forget — log errors, but do not expose to the user)
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
//   1. Token is SHA-256 hashed and checked against the DB; single use
//      (conditional update on usedAt IS NULL)
//   2. Minimum length from ServerSettings.minPasswordLength
//   3. All sessions AND app passwords of the user are revoked after the reset
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
  const ip = req.ip ?? 'unknown';
  try {
    const r = await redeemPasswordReset(parsed.data.token, parsed.data.newPassword, ip);
    if (r.ok) { res.json({ ok: true }); return; }
    if (r.reason === 'policy') { res.status(400).json({ error: r.message }); return; }
    if (r.reason === 'inactive') { res.status(400).json({ error: 'Dieses Konto ist deaktiviert.' }); return; }
    log.warn({ ip }, 'Password reset: invalid or expired token');
    res.status(400).json({ error: 'Der Link ist ungültig oder abgelaufen. Bitte fordern Sie einen neuen an.' });
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
    res.json({ valid: await isResetTokenValid(token) });
  } catch {
    res.status(500).json({ valid: false });
  }
});
