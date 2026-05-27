import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import type { JwtPayload } from '../types/index.js';

/**
 * v5.6.0: JWT zurück auf HS256 (HMAC) — RS256 + JWKS waren nur für OAuth2
 * Modern Auth nötig, und OAuth2/Modern Auth ist komplett aus dem Stack
 * entfernt. HS256 mit `JWT_SECRET` ist einfacher (keine Key-Generation,
 * keine DB-Persistenz, keine Public-Key-Verteilung) und ausreichend für
 * Session-Tokens innerhalb unseres Trust-Boundary.
 */

export function signAccessToken(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
  return jwt.sign(payload, config.JWT_SECRET, { expiresIn: config.JWT_ACCESS_TTL });
}

export function signRefreshToken(userId: string, sessionId: string): string {
  return jwt.sign({ sub: userId, sessionId, type: 'refresh' }, config.JWT_SECRET, {
    expiresIn: config.JWT_REFRESH_TTL,
  });
}

export function verifyAccessToken(token: string): JwtPayload {
  return jwt.verify(token, config.JWT_SECRET) as JwtPayload;
}

export function verifyRefreshToken(token: string): { sub: string; sessionId: string } {
  const payload = jwt.verify(token, config.JWT_SECRET) as {
    sub:       string;
    sessionId: string;
    type:      string;
  };
  if (payload.type !== 'refresh') {
    throw new Error('Invalid token type');
  }
  return payload;
}

export function extractTokenFromHeader(authHeader: string | undefined): string {
  // RFC 7235 §2.1 case-insensitive
  if (!authHeader) {
    throw new Error('Missing or invalid Authorization header');
  }
  const schemeEnd = authHeader.indexOf(' ');
  if (schemeEnd === -1) {
    throw new Error('Missing or invalid Authorization header');
  }
  const scheme = authHeader.slice(0, schemeEnd).toLowerCase();
  if (scheme !== 'bearer') {
    throw new Error('Missing or invalid Authorization header');
  }
  return authHeader.slice(schemeEnd + 1).trim();
}
