import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, verifyPassword, createLogger } from '@coremail/core';
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

  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const payload = verifyAccessToken(token);
    if (payload) {
      // Phase 10: Check OAuth2 token revocation status in DB
      const oauthToken = await prisma.oAuthToken.findUnique({
        where: { accessToken: token },
        select: { revoked: true, expiresAt: true },
      }).catch(() => null);

      // If found in oauth_tokens table, must not be revoked/expired
      if (oauthToken && (oauthToken.revoked || oauthToken.expiresAt < new Date())) {
        log.warn({ userId: payload.sub }, 'EWS: OAuth2 token revoked or expired');
        res.set('WWW-Authenticate', 'Bearer realm="CoreMail EWS", error="invalid_token"');
        res.status(401).send('Unauthorized');
        return;
      }

      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, email: true, role: true, active: true },
      });
      if (user?.active) {
        req.ewsUser = { userId: user.id, email: user.email, role: user.role };
        // EWS Shared Mailbox delegation header
        const anchor = req.get('X-AnchorMailbox') ?? req.get('X-OpenTypeMailbox');
        if (anchor) req.targetMailbox = anchor.toLowerCase();
        next();
        return;
      }
    }
  }

  // Basic Auth (Outlook MAPI/HTTP + EWS legacy)
  //
  // v5.2.1 BUGFIX: Wir umgehen den /auth/login-Endpoint des auth-service
  // (der mfaRequired statt accessToken liefert wenn MFA aktiv ist — Outlook
  // kann mit Basic-Auth keine MFA-Challenge beantworten → Endlos-Prompt).
  // Stattdessen verifizieren wir direkt gegen User.passwordHash UND
  // AppPassword.hash — gleiche Logik wie IMAP/SMTP/POP3.
  //
  // App-Passwörter sind der empfohlene Weg für Outlook bei aktivem MFA.
  if (authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
    const colonIdx = decoded.indexOf(':');
    if (colonIdx === -1) {
      log.warn({ ip: req.ip }, 'EWS: Basic-Auth ohne Doppelpunkt');
    } else {
      const rawUser = decoded.slice(0, colonIdx);
      const password = decoded.slice(colonIdx + 1);
      // Outlook LTSC sendet manchmal `DOMAIN\user` oder `user@domain` —
      // wir normalisieren auf E-Mail-Form.
      const email = normalizeUserName(rawUser);

      log.debug({ email, hasPassword: !!password, ip: req.ip }, 'EWS Basic-Auth attempt');

      try {
        const user = await prisma.user.findUnique({
          where: { email: email.toLowerCase() },
          select: { id: true, email: true, role: true, active: true, passwordHash: true },
        });

        if (!user || !user.active) {
          log.warn({ email, found: !!user, active: user?.active }, 'EWS Basic-Auth: User nicht gefunden/aktiv');
        } else {
          // 1) Versuche regulärer Passwort-Hash
          let authenticated = false;
          if (user.passwordHash) {
            authenticated = await verifyPassword(password, user.passwordHash).catch(() => false);
            if (authenticated) {
              log.debug({ userId: user.id }, 'EWS Basic-Auth: User-Passwort OK');
            }
          }

          // 2) Fallback: App-Passwort (für MFA-Accounts der einzige Weg)
          if (!authenticated) {
            const appPasswords = await prisma.appPassword.findMany({
              where: { userId: user.id },
              select: { id: true, hash: true },
            }).catch(() => []);
            for (const ap of appPasswords) {
              if (await verifyPassword(password, ap.hash).catch(() => false)) {
                authenticated = true;
                // lastUsedAt aktualisieren (non-blocking)
                void prisma.appPassword.update({
                  where: { id: ap.id },
                  data: { lastUsedAt: new Date() },
                }).catch(() => { /* ignore */ });
                log.debug({ userId: user.id, appPasswordId: ap.id }, 'EWS Basic-Auth: App-Passwort OK');
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

          log.warn({ email, ip: req.ip }, 'EWS Basic-Auth: Passwort + App-Passwort fehlgeschlagen');
        }
      } catch (err) {
        log.error({ err, email }, 'EWS Basic-Auth: DB-Fehler');
      }
    }
  }

  log.warn({ ip: req.ip, hasAuth: !!authHeader, authType: authHeader.split(' ')[0] }, 'EWS: unauthorized request');
  res.set('WWW-Authenticate', 'Basic realm="CoreMail EWS"');
  res.status(401).send('Unauthorized');
}

/**
 * Normalisiert Outlook-Username-Formate (DOMAIN\user, user@domain) auf
 * E-Mail-Form. CoreMail-User identifizieren sich per E-Mail-Adresse.
 */
function normalizeUserName(raw: string): string {
  // DOMAIN\user → user (Outlook NTLM-Stil, wir kennen die Domain nicht)
  const bsIdx = raw.lastIndexOf('\\');
  if (bsIdx !== -1) return raw.slice(bsIdx + 1).trim();
  return raw.trim();
}
