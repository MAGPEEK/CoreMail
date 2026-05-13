import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage';

const log = createLogger('caldav:auth');

export interface DavUser {
  userId: string;
  email: string;
}

declare module 'express' {
  interface Request {
    davUser?: DavUser;
  }
}

export async function davAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.get('Authorization') ?? '';

  if (authHeader.startsWith('Bearer ')) {
    const payload = verifyAccessToken(authHeader.slice(7));
    if (payload) {
      
      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, email: true, active: true },
      });
      if (user?.active) {
        req.davUser = { userId: user.id, email: user.email };
        next();
        return;
      }
    }
  }

  if (authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
    const colonIdx = decoded.indexOf(':');
    if (colonIdx !== -1) {
      const email = decoded.slice(0, colonIdx);
      const password = decoded.slice(colonIdx + 1);
      try {
        const resp = await fetch('http://auth-service:3003/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
          signal: AbortSignal.timeout(5000),
        });
        if (resp.ok) {
          const data = await resp.json() as { accessToken?: string };
          if (data.accessToken) {
            const payload = verifyAccessToken(data.accessToken);
            if (payload) {
              
              const user = await prisma.user.findUnique({
                where: { id: payload.sub },
                select: { id: true, email: true },
              });
              if (user) {
                req.davUser = { userId: user.id, email: user.email };
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

  res.set('WWW-Authenticate', 'Basic realm="CoreMail CalDAV"');
  res.status(401).send('Unauthorized');
}
