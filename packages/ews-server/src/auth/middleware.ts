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
  // v5.2.15: Auth-Scheme case-insensitive matchen (RFC 7235 §2.1).
  // Outlook-LTSC unter aktuellen Win11-Patches sendet manchmal `basic`
  // (lowercase) statt `Basic` — startsWith() ist case-sensitiv und würde
  // false-negativ zurückgeben → 401-Schleife.
  const authSchemeLower = authHeader.split(' ')[0]?.toLowerCase() ?? '';

  if (authSchemeLower === 'bearer') {
    const tokenStart = authHeader.indexOf(' ');
    const token = tokenStart !== -1 ? authHeader.slice(tokenStart + 1).trim() : '';
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

  // v5.2.2: Outlook 2019+/365 sendet bei "Negotiate, NTLM, Basic" zuerst
  // Negotiate (Kerberos/SPNEGO). Wir implementieren das nicht — explizit
  // 401 zurück mit nur Basic-Schema im Header, damit Outlook sofort auf
  // Basic-Auth wechselt statt auf Endlos-Negotiate-Loop.
  if (authSchemeLower === 'negotiate' || authSchemeLower === 'ntlm') {
    log.debug({ scheme: authSchemeLower }, 'EWS: rejecting Negotiate/NTLM → Basic only');
    res.set('WWW-Authenticate', 'Basic realm="CoreMail EWS"');
    res.status(401).send('Unauthorized');
    return;
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
  if (authSchemeLower === 'basic') {
    const tokenStart = authHeader.indexOf(' ');
    const b64 = tokenStart !== -1 ? authHeader.slice(tokenStart + 1).trim() : '';
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    const colonIdx = decoded.indexOf(':');
    if (colonIdx === -1) {
      log.warn({ ip: req.ip }, 'EWS: Basic-Auth ohne Doppelpunkt');
    } else {
      const rawUser = decoded.slice(0, colonIdx);
      const password = decoded.slice(colonIdx + 1);
      // Outlook LTSC sendet manchmal `DOMAIN\user` oder `user@domain` —
      // wir normalisieren auf E-Mail-Form.
      let email = normalizeUserName(rawUser);
      // v5.2.15: Bare-Username Fallback. Outlook sendet bei NTLM-Stil oft
      // nur `admin` ohne @domain. Wenn kein @ enthalten, mit primärer
      // Domain ergänzen.
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
          log.warn({ email, found: !!user, active: user?.active }, 'EWS Basic-Auth: User nicht gefunden/aktiv');
          await writeAuthFailureLog(req, email, !user ? 'USER_NOT_FOUND' : 'USER_INACTIVE');
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
          await writeAuthFailureLog(req, email, 'WRONG_PASSWORD', user.id);
        }
      } catch (err) {
        log.error({ err, email }, 'EWS Basic-Auth: DB-Fehler');
        await writeAuthFailureLog(req, email, 'DB_ERROR');
      }
    }
  }

  log.warn({ ip: req.ip, hasAuth: !!authHeader, authType: authHeader.split(' ')[0] }, 'EWS: unauthorized request');
  // SystemLog für „no auth"-Probe nur 1x pro Minute pro IP loggen — sonst
  // flutet Outlook das Log mit jeder Discovery-Probe. Wir nutzen einen
  // simplen In-Memory-Cache.
  if (!authHeader) {
    rateLimitedNoAuthLog(req);
  }
  // v5.2.2: Mehrere Auth-Schemes anbieten — moderne Outlook-Builds (2019+/365)
  // blockieren Basic wenn es das einzige Scheme ist. Mit Negotiate/NTLM in der
  // Liste fällt Outlook gracefully auf Basic zurück, wenn die anderen Schemes
  // fehlschlagen. Wir implementieren weder Negotiate noch NTLM — durch das
  // Listen wird Outlook lediglich davon überzeugt, dass das Senden von
  // Credentials erlaubt ist.
  res.set('WWW-Authenticate', 'Negotiate, NTLM, Basic realm="CoreMail EWS"');
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

/**
 * Schreibt einen MAPI/EWS-Auth-Failure-Eintrag in SystemLog (sichtbar im BCP).
 * Non-blocking via .catch() — falls DB nicht erreichbar wird nur pino-Log
 * geschrieben.
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
  }).catch((err: unknown) => log.error({ err }, 'SystemLog-Write für MAPI-Auth-Failure fehlgeschlagen'));
}

/**
 * Rate-Limited Log für „kein Auth-Header"-Probes (Outlook-Discovery).
 * Schreibt max 1 SystemLog-Eintrag pro IP+Path-Kombi pro 60s.
 */
const noAuthLogCache = new Map<string, number>();
function rateLimitedNoAuthLog(req: Request): void {
  const ip = req.ip ?? 'unknown';
  const url = req.originalUrl || req.url || '';
  const path = url.startsWith('/mapi') ? 'MAPI' : 'EWS';
  const cacheKey = `${ip}::${path}`;
  const now = Date.now();
  const last = noAuthLogCache.get(cacheKey) ?? 0;
  if (now - last < 60_000) return;  // unter 60s seit letztem Log → skip
  noAuthLogCache.set(cacheKey, now);

  // Cleanup: alte Einträge entfernen (älter als 5min)
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
