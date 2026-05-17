import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import type { JwtPayload } from '../types/index.js';

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
    sub: string;
    sessionId: string;
    type: string;
  };
  if (payload.type !== 'refresh') {
    throw new Error('Invalid token type');
  }
  return payload;
}

export function extractTokenFromHeader(authHeader: string | undefined): string {
  if (!authHeader?.startsWith('Bearer ')) {
    throw new Error('Missing or invalid Authorization header');
  }
  return authHeader.slice(7);
}

/**
 * Stellt ein OIDC ID Token aus (RFC 6749 / OIDC Core §3.1.3.3).
 * Signiert mit HS256 via JWT_SECRET.
 */
export function signIdToken(payload: {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  email?: string;
  name?: string;
  preferred_username?: string;
  nonce?: string;
  [key: string]: unknown;
}): string {
  return jwt.sign(payload, config.JWT_SECRET, { algorithm: 'HS256' });
}
