import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, createLogger } from '@coremail/core';
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

  // Basic Auth (Outlook legacy)
  if (authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
    const colonIdx = decoded.indexOf(':');
    if (colonIdx !== -1) {
      const email = decoded.slice(0, colonIdx);
      const password = decoded.slice(colonIdx + 1);

      try {
        // Validate via auth-service REST call (internal)
        const authUrl = `http://auth-service:3001/auth/login`;
        const resp = await fetch(authUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
          signal: AbortSignal.timeout(5000),
        });

        if (resp.ok) {
          const data = await resp.json() as { accessToken?: string; mfaRequired?: boolean };
          if (data.accessToken) {
            const payload = verifyAccessToken(data.accessToken);
            if (payload) {
              
              const user = await prisma.user.findUnique({
                where: { id: payload.sub },
                select: { id: true, email: true, role: true },
              });
              if (user) {
                req.ewsUser = { userId: user.id, email: user.email, role: user.role };
                const anchor = req.get('X-AnchorMailbox');
                if (anchor) req.targetMailbox = anchor.toLowerCase();
                next();
                return;
              }
            }
          }
        }
      } catch (err) {
        log.error({ err }, 'Auth service call failed');
      }
    }
  }

  log.warn({ ip: req.ip }, 'EWS: unauthorized request');
  res.set('WWW-Authenticate', 'Basic realm="CoreMail EWS"');
  res.status(401).send('Unauthorized');
}
