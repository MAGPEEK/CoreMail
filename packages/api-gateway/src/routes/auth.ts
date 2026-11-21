/**
 * Auth routes in the api-gateway (used by MWA, BCP and the admin CLI).
 *
 * v7.0.0: login / refresh / logout / password reset all go through the single
 * login service in `@coremail/storage/auth` (shared with the auth-service):
 *   POST /auth/login          → { accessToken, refreshToken, expiresIn }
 *                               | { mfaRequired: true, challengeToken, method, methods }
 *                               | 401 invalid credentials | 429 ACCOUNT_LOCKED (v8.1, shared lockout)
 *                               | 403 PROTOCOL_DISABLED (9.4: Webmail off, account without admin role)
 *                               | 503 { error: 'maintenance', message }
 *   POST /auth/refresh        → rotates: { accessToken, refreshToken, expiresIn } (old token invalid)
 *   POST /auth/logout         → { ok: true } — revokes the session of { refreshToken }
 *   POST /auth/mfa/verify     → proxied to the auth-service (same login service)
 *
 * 10.6 self-service password reset (docs/password-reset.md):
 *   POST /auth/forgot-password          → always 200 { ok: true } (work runs after the answer)
 *   GET  /auth/password-reset/available → { enabled } (login page link)
 *   POST /auth/reset-password/verify    → { valid, mfaRequired?, methods? }
 *   POST /auth/reset-password           → { ok } | 400 INVALID_TOKEN / PASSWORD_POLICY / MFA_REQUIRED / MFA_INVALID | 429 MFA_LOCKED / RATE_LIMITED
 *   POST /auth/recovery-email/confirm   → { ok } | 400 INVALID_TOKEN / HOSTED_ADDRESS
 *
 * v8.1 browser clients (`X-CoreMail-Client: web`): the refresh token travels
 * only in the HttpOnly cookie cm_rt (BCP: cm_rt_bcp, `X-CoreMail-App: bcp`),
 * never in a body; /auth/refresh and /auth/logout accept the cookie when the
 * body has no refreshToken and the request is same-origin (Origin/Referer).
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { recordSecurityEvent } from '@coremail/storage';
import {
  login,
  loginOutcomeToHttp,
  rotateSession,
  revokeSessionByRefreshToken,
  redeemPasswordReset,
  inspectResetToken,
  loadSsprPolicy,
  ssprAvailable,
  confirmRecoveryEmail,
  registerAuthenticator,
  tokenPairResponse,
  readRefreshCookie,
  isSameOriginCookieRequest,
  clearRefreshCookieHeader,
  isWebClient,
  protocolDisabledBody,
  clientInfoOf,
  sessionSurfaceOf,
  readTrustedDeviceCookie,
  type TokenPair,
} from '@coremail/storage/auth';
import { emptyTrashAfterLogout } from '../lib/empty-folder.js';
import { audit } from '../lib/audit.js';
import { requestPasswordReset, notifyPasswordResetDone, notifyRecoveryChange, maskAddress } from '../lib/password-reset.js';
import { ldapAuthenticator } from '@coremail/auth-ldap';
import { createLogger, verifyRefreshToken } from '@coremail/core';

const log = createLogger('api:auth');
export const authRouter: RouterType = Router();

// First-factor extension point (v6.1): real LDAP / AD step — only for accounts
// with authSource LDAP, unknown users of an LDAP domain (first-login
// provisioning) or LOCAL accounts with the admin opt-in `allowLocalTakeover`.
// OIDC SSO has its own redirect flow (routes/sso.ts).
registerAuthenticator(ldapAuthenticator());


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
    // 10.6: a remembered browser (cm_mfa_dev / cm_mfa_dev_bcp) may skip the MFA step
    const outcome = await login(parsed.data.email, parsed.data.password, clientInfoOf(req),
      { trustedDeviceToken: readTrustedDeviceCookie(req) });
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
    const r = await rotateSession(src.token, clientInfoOf(req));
    if (r.ok) { sendTokens(req, res, r.tokens, src.viaCookie); return; }
    if (r.status === 503) { res.status(503).json({ error: 'maintenance', message: r.message }); return; }
    if (src.viaCookie) res.append('Set-Cookie', clearRefreshCookieHeader(req));
    // 9.4: Webmail switched off for the account
    if (r.status === 403) { res.status(403).json(protocolDisabledBody('webmail')); return; }
    const error = r.reason === 'expired' ? 'Session expired' : 'Invalid refresh token';
    res.status(401).json({ error, code: `REFRESH_${r.reason.toUpperCase()}` });
  } catch (err) {
    log.error({ err }, 'Refresh error');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** User id of a valid refresh token, or null (expired / unsigned tokens only revoke by hash). */
function refreshTokenOwner(token: string): string | null {
  try { return verifyRefreshToken(token).sub; } catch { return null; }
}

// ── POST /auth/logout ─────────────────────────────────────────────────────────
// Revokes the session of { refreshToken } or (v8.1) of the refresh cookie and
// always deletes the cookie.
authRouter.post('/logout', async (req: Request, res: Response) => {
  const src = await refreshTokenOf(req, res);
  if (src === 'rejected') return;
  if (src && src.token.length <= 4096) {
    try {
      const owner = refreshTokenOwner(src.token);
      const ended = await revokeSessionByRefreshToken(src.token);
      // 9.4: "empty Deleted Items on logout" (webmail setting) — never blocks the logout
      if (ended > 0 && owner && sessionSurfaceOf(req.headers) === 'webmail') void emptyTrashAfterLogout(owner);
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
// Security principles (10.6, docs/password-reset.md):
//   1. No user enumeration: the answer is always `200 { ok: true }`, sent BEFORE
//      any lookup — neither body nor timing depends on the account; the work runs
//      afterwards (lib/password-reset.ts requestPasswordReset)
//   2. Rate limit: max 3 requests per IP and per e-mail per hour (Redis); hits are
//      security events; blocked / locked client IPs are ignored silently
//   3. Token: 256 bit, stored as SHA-256, 15 minutes, single use
//   4. Earlier links stay valid until they expire (v7.0.0) — a reset request by
//      an attacker cannot invalidate the victim's link
//   5. Policy (storage auth/sspr.ts): switch + methods (confirmed recovery address,
//      own mailbox only while nobody else can read it), admins only when allowed,
//      LOCAL accounts only
const pendingResetWork = new Set<Promise<unknown>>();

/** Tests: resolves once every forgot-password request answered so far has been processed. */
export async function settleForgotPasswordWork(): Promise<void> {
  while (pendingResetWork.size > 0) await Promise.all([...pendingResetWork]);
}

authRouter.post('/forgot-password', (req: Request, res: Response) => {
  // Always the same answer — no fingerprinting, no enumeration.
  res.json({ ok: true });
  const parsed = z.object({ email: z.string().email().max(320) }).safeParse(req.body);
  if (!parsed.success) return;
  const work = requestPasswordReset(parsed.data.email, req.ip ?? 'unknown', req.get('user-agent') ?? '');
  pendingResetWork.add(work);
  void work.finally(() => pendingResetWork.delete(work));
});

// ── GET /auth/password-reset/available ───────────────────────────────────────
// 10.6: public — whether the login page offers "Passwort vergessen?" (the switch
// is on and at least one method is enabled). A boolean only, nothing per account.
authRouter.get('/password-reset/available', async (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.json({ enabled: ssprAvailable(await loadSsprPolicy()) });
  } catch {
    res.json({ enabled: false });
  }
});

// ── POST /auth/reset-password ─────────────────────────────────────────────────
// Takes the plaintext token + new password (+ 10.6 `mfaCode` for accounts with a
// second factor: TOTP or backup code) and sets the password.
//   1. Token is SHA-256 hashed and checked against the DB; single use
//      (conditional update on usedAt IS NULL); the SSPR policy is checked again
//   2. Password policy (minimum length etc.) before the second factor
//   3. Missing / wrong code → 400 MFA_REQUIRED / MFA_INVALID, the link stays
//      usable; after 5 wrong codes it is burnt (429 MFA_LOCKED)
//   4. All sessions AND app passwords are revoked; MFA stays; notices go to the
//      own mailbox and the confirmed recovery address
const ResetPasswordSchema = z.object({
  token:       z.string().min(32).max(128),
  newPassword: z.string().min(1).max(128),
  mfaCode:     z.string().max(32).optional(),
});

const INVALID_LINK = 'Der Link ist ungültig oder abgelaufen. Bitte fordern Sie einen neuen an.';

authRouter.post('/reset-password', async (req: Request, res: Response) => {
  const parsed = ResetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Ungültige Anfrage' });
    return;
  }
  const ip = req.ip ?? 'unknown';
  const userAgent = req.get('user-agent') ?? '';
  try {
    const r = await redeemPasswordReset(parsed.data.token, parsed.data.newPassword, ip,
      parsed.data.mfaCode !== undefined ? { mfaCode: parsed.data.mfaCode } : {});
    if (r.ok) {
      audit({ action: 'auth.password-reset.complete', targetType: 'user', targetId: r.userId, actorId: r.userId, ipAddress: ip, userAgent });
      void notifyPasswordResetDone(r.userId, ip);
      res.json({ ok: true });
      return;
    }
    switch (r.reason) {
      case 'policy':
        res.status(400).json({ error: r.message, code: 'PASSWORD_POLICY' });
        return;
      case 'inactive':
        res.status(400).json({ error: 'Dieses Konto ist deaktiviert.' });
        return;
      case 'mfa_rate_limited':
        res.status(429).json({ error: 'Zu viele falsche Codes von dieser Adresse. Bitte versuchen Sie es später erneut.', code: 'RATE_LIMITED' });
        return;
      case 'mfa_required':
        res.status(400).json({ error: 'Bitte geben Sie einen Code Ihrer Zwei-Faktor-Anmeldung ein.', code: 'MFA_REQUIRED' });
        return;
      case 'mfa_invalid':
      case 'mfa_locked': {
        const locked = r.reason === 'mfa_locked';
        recordSecurityEvent({ type: 'PASSWORD_RESET_MFA_FAILED', ip, protocol: 'web', detail: { locked } });
        audit({
          action: 'auth.password-reset.mfa-failed', targetType: 'user', targetId: r.userId,
          success: false, errorMsg: r.reason, ipAddress: ip, userAgent,
        });
        if (locked) {
          res.status(429).json({ error: 'Zu viele falsche Codes. Bitte fordern Sie einen neuen Link an.', code: 'MFA_LOCKED' });
        } else {
          res.status(400).json({ error: 'Der Code ist falsch.', code: 'MFA_INVALID' });
        }
        return;
      }
      default:
        log.warn({ ip }, 'Password reset: invalid or expired token');
        recordSecurityEvent({ type: 'PASSWORD_RESET_INVALID_TOKEN', ip, protocol: 'web' });
        res.status(400).json({ error: INVALID_LINK, code: 'INVALID_TOKEN' });
    }
  } catch (err) {
    log.error({ err, ip }, 'reset-password error');
    res.status(500).json({ error: 'Interner Fehler. Bitte versuchen Sie es später erneut.' });
  }
});

// ── POST /auth/reset-password/verify ─────────────────────────────────────────
// Checks whether a token is still valid (for frontend feedback before the form).
// 10.6: also `mfaRequired` + `methods` (['totp', 'backup_code']) so the page can
// ask for the second proof — only for the holder of a valid link.
// v8.1: the token travels in the JSON body `{ token }` so it does not end up in
// proxy/access logs. GET ?token= is kept for one release (deprecated).
async function verifyResetToken(token: string, res: Response): Promise<void> {
  if (!token || token.length < 32 || token.length > 128) {
    res.status(400).json({ valid: false });
    return;
  }
  try {
    const info = await inspectResetToken(token);
    res.json(info.valid ? info : { valid: false });
  } catch {
    res.status(500).json({ valid: false });
  }
}

authRouter.post('/reset-password/verify', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { token?: unknown };
  await verifyResetToken(typeof body.token === 'string' ? body.token : '', res);
});

/** @deprecated since 8.1 — use POST /auth/reset-password/verify `{ token }`; removed in the next release. */
authRouter.get('/reset-password/verify', async (req: Request, res: Response) => {
  res.setHeader('Deprecation', 'true');
  res.setHeader('Link', '</auth/reset-password/verify>; rel="successor-version"');
  await verifyResetToken(typeof req.query['token'] === 'string' ? req.query['token'] : '', res);
});

// ── POST /auth/recovery-email/confirm ────────────────────────────────────────
// 10.6: confirms a recovery address with the link mailed to it (public — the
// link is opened wherever that mailbox is read). Single use, 24 h. The confirmed
// address replaces the previous one; notices to the own mailbox + old address.
authRouter.post('/recovery-email/confirm', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { token?: unknown };
  const token = typeof body.token === 'string' ? body.token : '';
  const ip = req.ip ?? 'unknown';
  try {
    const r = await confirmRecoveryEmail(token);
    if (!r.ok) {
      recordSecurityEvent({ type: 'RECOVERY_EMAIL_INVALID_TOKEN', ip, protocol: 'web' });
      res.status(400).json({ error: 'Der Bestätigungslink ist ungültig oder abgelaufen.', code: r.reason === 'hosted_address' ? 'HOSTED_ADDRESS' : 'INVALID_TOKEN' });
      return;
    }
    audit({
      action: 'auth.recovery-email.confirm', targetType: 'user', targetId: r.userId, actorId: r.userId,
      changes: { address: { from: maskAddress(r.previous), to: maskAddress(r.address) } },
      ipAddress: ip, userAgent: req.get('user-agent') ?? '',
    });
    void notifyRecoveryChange(r.userId, 'confirmed', r.previous, r.address);
    res.json({ ok: true });
  } catch (err) {
    log.error({ err, ip }, 'recovery-email confirm error');
    res.status(500).json({ error: 'Interner Fehler. Bitte versuchen Sie es später erneut.' });
  }
});
