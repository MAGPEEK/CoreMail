import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage';

const log = createLogger('api:auth');

export interface ApiUser {
  userId: string;
  email: string;
  role: string;
}

declare module 'express' {
  interface Request {
    apiUser?: ApiUser;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authorization required' });
    return;
  }
  try {
    const payload = verifyAccessToken(header.slice(7));
    if (!payload) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }
    req.apiUser = { userId: payload.sub, role: payload.role, email: payload.email };
    next();
  } catch (err) {
    // jwt.verify() wirft TokenExpiredError, JsonWebTokenError, NotBeforeError etc.
    // → immer 401 zurückgeben, nie als unhandled error propagieren
    const message = err instanceof Error && err.name === 'TokenExpiredError'
      ? 'Token expired'
      : 'Invalid or expired token';
    log.warn({ err }, 'JWT verification failed');
    res.status(401).json({ error: message });
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    const adminRoles = ['ADMIN', 'ORGANIZATION_MANAGEMENT', 'SERVER_MANAGEMENT'];
    if (!req.apiUser || !adminRoles.includes(req.apiUser.role)) {
      res.status(403).json({ error: 'Admin role required' });
      return;
    }
    next();
  });
}
