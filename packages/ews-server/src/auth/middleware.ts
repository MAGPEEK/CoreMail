import type { Request, Response, NextFunction } from 'express';
import { verifyPassword, createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage';

const log = createLogger('ews:auth');

export interface EwsUser {
  userId: string;
  email: string;
  role: string;
}

declare module 'express' {
  interface Request {
    ewsUser?: EwsUser;
    targetMailbox?: string;
  }
}

export async function ewsAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Bearer token (Modern Auth)
  const authHeader = req.get('Authorization') ?? '';
  // v5.2.15: Match the auth scheme case-insensitively (RFC 7235 §2.1).
  // Outlook LTSC on current Win11 patches sometimes sends `basic`
  // (lowercase) instead of `Basic` — startsWith() is case-sensitive and would
  // return a false negative → 401 loop.
  const authSchemeLower = authHeader.split(' ')[0]?.toLowerCase() ?? '';

  // v5.6.0: Bearer branch removed entirely (OAuth2 gone). Basic auth only.
  if (authSchemeLower === 'bearer') {
    log.debug({ ip: req.ip }, 'EWS: Bearer token not supported — use Basic auth');
    res.set('WWW-Authenticate', 'Basic realm="CoreMail EWS"');
    res.status(401).send('Unauthorized');
    return;
  }

  // v5.2.2: With "Negotiate, NTLM, Basic" Outlook 2019+/365 sends Negotiate
  // (Kerberos/SPNEGO) first. We do not implement that — explicitly return
  // 401 with only the Basic scheme in the header so Outlook switches to
  // Basic auth immediately instead of an endless Negotiate loop.
  if (authSchemeLower === 'negotiate' || authSchemeLower === 'ntlm') {
    log.debug({ scheme: authSchemeLower }, 'EWS: rejecting Negotiate/NTLM → Basic only');
    res.set('WWW-Authenticate', 'Basic realm="CoreMail EWS"');
    res.status(401).send('Unauthorized');
    return;
  }

  // Basic Auth (Outlook MAPI/HTTP + EWS legacy)
  //
  // v5.2.1 BUGFIX: We bypass the auth-service /auth/login endpoint
  // (which returns mfaRequired instead of accessToken when MFA is active — Outlook
  // cannot answer an MFA challenge over Basic auth → endless prompt).
  // Instead we verify directly against User.passwordHash AND
  // AppPassword.hash — same logic as IMAP/SMTP/POP3.
  //
  // App passwords are the recommended path for Outlook when MFA is active.
  if (authSchemeLower === 'basic') {
    const tokenStart = authHeader.indexOf(' ');
    const b64 = tokenStart !== -1 ? authHeader.slice(tokenStart + 1).trim() : '';
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    const colonIdx = decoded.indexOf(':');
    if (colonIdx === -1) {
      log.warn({ ip: req.ip }, 'EWS: Basic auth without colon');
    } else {
      const rawUser = decoded.slice(0, colonIdx);
      const password = decoded.slice(colonIdx + 1);
      // Outlook LTSC sometimes sends `DOMAIN\user` or `user@domain` —
      // we normalize to e-mail form.
      let email = normalizeUserName(rawUser);
      // v5.2.15: Bare-username fallback. In NTLM style Outlook often sends
      // just `admin` without @domain. If no @ is present, append the primary
      // domain.
      if (!email.includes('@')) {
        const primaryDomain = await prisma.domain.findFirst({
          where:  { primary: true, active: true },
          select: { name: true },
        }).catch(() => null);
        if (primaryDomain) email = `${email}@${primaryDomain.name}`;
      }

      log.debug({ email, hasPassword: !!password, ip: req.ip }, 'EWS Basic-Auth attempt');

      try {
        const user = await prisma.user.findUnique({
          where: { email: email.toLowerCase() },
          select: { id: true, email: true, role: true, active: true, passwordHash: true },
        });

        if (!user || !user.active) {
          log.warn({ email, found: !!user, active: user?.active }, 'EWS Basic auth: user not found/inactive');
          await writeAuthFailureLog(req, email, !user ? 'USER_NOT_FOUND' : 'USER_INACTIVE');
        } else {
          // 1) Try the regular password hash
          let authenticated = false;
          if (user.passwordHash) {
            authenticated = await verifyPassword(password, user.passwordHash).catch(() => false);
            if (authenticated) {
              log.debug({ userId: user.id }, 'EWS Basic auth: user password OK');
            }
          }

          // 2) Fallback: app password (the only way for MFA accounts)
          if (!authenticated) {
            const appPasswords = await prisma.appPassword.findMany({
              where: { userId: user.id },
              select: { id: true, hash: true },
            }).catch(() => []);
            for (const ap of appPasswords) {
              if (await verifyPassword(password, ap.hash).catch(() => false)) {
                authenticated = true;
                // Update lastUsedAt (non-blocking)
                void prisma.appPassword.update({
                  where: { id: ap.id },
                  data: { lastUsedAt: new Date() },
                }).catch(() => { /* ignore */ });
                log.debug({ userId: user.id, appPasswordId: ap.id }, 'EWS Basic auth: app password OK');
                break;
              }
            }
          }

          if (authenticated) {
            req.ewsUser = { userId: user.id, email: user.email, role: user.role };
            const anchor = req.get('X-AnchorMailbox') ?? req.get('X-OpenTypeMailbox');
            if (anchor) req.targetMailbox = anchor.toLowerCase();
            next();
            return;
          }

          log.warn({ email, ip: req.ip }, 'EWS Basic auth: password + app password failed');
          await writeAuthFailureLog(req, email, 'WRONG_PASSWORD', user.id);
        }
      } catch (err) {
        log.error({ err, email }, 'EWS Basic auth: DB error');
        await writeAuthFailureLog(req, email, 'DB_ERROR');
      }
    }
  }

  log.warn({ ip: req.ip, hasAuth: !!authHeader, authType: authHeader.split(' ')[0] }, 'EWS: unauthorized request');
  // Log the SystemLog entry for a "no auth" probe only once per minute per IP —
  // otherwise Outlook floods the log with every discovery probe. We use a
  // simple in-memory cache.
  if (!authHeader) {
    rateLimitedNoAuthLog(req);
  }
  // v5.3.4 CORRECTION: Bearer removed from the WWW-Authenticate challenge!
  //
  // Background: v5.3.0 advertised `Bearer realm=... authorization_uri=...`
  // as the first option. Outlook 2024 LTSC sees Bearer as the first scheme
  // in the challenge and triggers Modern Auth — it goes straight to
  // login.microsoftonline.com (Microsoft's hard-coded default for
  // Modern Auth discovery), gets nothing there (our domain is not
  // registered in Entra ID) and abandons the auth flow WITHOUT ever
  // sending credentials to us.
  //
  // User symptom: "a Microsoft sign-in web page appears" —
  // that is exactly login.microsoftonline.com, NOT our ADFS login page.
  //
  // Fix: Only Basic in WWW-Authenticate. Outlook 2024 LTSC still supports
  // Basic-auth MAPI as "regular sign-in" — that is the working standard
  // path for non-Entra servers.
  //
  // v5.4.0/v5.6.0: ADFS emulation and the OAuth2 server were removed — only
  // Basic auth remains (password or app password).
  // v5.3.4: Basic only — no more Negotiate/NTLM (would tempt Outlook 2024
  // LTSC into trying Kerberos/SSO flows instead of going straight to Basic auth).
  res.set('WWW-Authenticate', 'Basic realm="CoreMail EWS"');
  res.status(401).send('Unauthorized');
}

/**
 * Normalizes Outlook username formats (DOMAIN\user, user@domain) to
 * e-mail form. CoreMail users identify themselves by e-mail address.
 */
function normalizeUserName(raw: string): string {
  // DOMAIN\user → user (Outlook NTLM style, we do not know the domain)
  const bsIdx = raw.lastIndexOf('\\');
  if (bsIdx !== -1) return raw.slice(bsIdx + 1).trim();
  return raw.trim();
}

/**
 * Writes a MAPI/EWS auth-failure entry to SystemLog (visible in the BCP).
 * Non-blocking via .catch() — if the DB is unreachable only the pino log
 * is written.
 *
 * Reasons: USER_NOT_FOUND | USER_INACTIVE | WRONG_PASSWORD | DB_ERROR
 */
async function writeAuthFailureLog(
  req: Request,
  email: string,
  reason: string,
  userId?: string,
): Promise<void> {
  const url = req.originalUrl || req.url || '';
  const path = url.startsWith('/mapi') ? 'MAPI' : 'EWS';
  const ip = req.ip ?? 'unknown';
  const userAgent = req.get('User-Agent') ?? '';

  void prisma.systemLog.create({
    data: {
      level: 'WARN',
      service: 'ews-server',
      category: 'MAPI_AUTH',
      message: `${path} Basic-Auth fehlgeschlagen: ${email} (${reason})`,
      ...(userId ? { userId } : {}),
      metadata: {
        protocol: path,
        email,
        reason,
        ip,
        userAgent,
        path: url,
      },
    },
  }).catch((err: unknown) => log.error({ err }, 'SystemLog write for MAPI auth failure failed'));
}

/**
 * Rate-limited log for "no auth header" probes (Outlook discovery).
 * Writes at most 1 SystemLog entry per IP+path combination per 60s.
 */
const noAuthLogCache = new Map<string, number>();
function rateLimitedNoAuthLog(req: Request): void {
  const ip = req.ip ?? 'unknown';
  const url = req.originalUrl || req.url || '';
  const path = url.startsWith('/mapi') ? 'MAPI' : 'EWS';
  const cacheKey = `${ip}::${path}`;
  const now = Date.now();
  const last = noAuthLogCache.get(cacheKey) ?? 0;
  if (now - last < 60_000) return;  // less than 60s since last log → skip
  noAuthLogCache.set(cacheKey, now);

  // Cleanup: remove old entries (older than 5min)
  if (noAuthLogCache.size > 100) {
    for (const [k, t] of noAuthLogCache.entries()) {
      if (now - t > 300_000) noAuthLogCache.delete(k);
    }
  }

  void prisma.systemLog.create({
    data: {
      level: 'INFO',
      service: 'ews-server',
      category: 'MAPI_AUTH',
      message: `${path}: Client-Probe ohne Auth-Header (Discovery)`,
      metadata: {
        protocol: path,
        ip,
        userAgent: req.get('User-Agent') ?? '',
        path: url,
        info: 'Outlook sendet zunächst Request ohne Auth, erwartet 401-Challenge',
      },
    },
  }).catch(() => { /* non-fatal */ });
}
