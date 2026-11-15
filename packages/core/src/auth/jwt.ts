import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { config } from '../config/index.js';
import type { JwtPayload } from '../types/index.js';

/**
 * v5.6.0: JWT back to HS256 (HMAC) — RS256 + JWKS were only needed for OAuth2
 * Modern Auth, and OAuth2/Modern Auth has been completely removed from the
 * stack. HS256 with `JWT_SECRET` is simpler (no key generation,
 * no DB persistence, no public key distribution) and sufficient for
 * session tokens within our trust boundary.
 */

export function signAccessToken(payload: Omit<JwtPayload, 'iat' | 'iatMs' | 'exp'>): string {
  // iatMs: millisecond issue time for revocation marks (see JwtPayload.iatMs).
  return jwt.sign({ ...payload, iatMs: Date.now() }, config.JWT_SECRET, { expiresIn: config.JWT_ACCESS_TTL });
}

export function signRefreshToken(userId: string, sessionId: string): string {
  // A random jti makes every refresh token unique, even two issued for the same
  // session within one second — required for refresh-token rotation (v7.0.0).
  return jwt.sign({ sub: userId, sessionId, type: 'refresh', jti: randomUUID() }, config.JWT_SECRET, {
    expiresIn: config.JWT_REFRESH_TTL,
  });
}

/**
 * Returns the payload of a valid access token, or null for anything else
 * (bad signature, expired, malformed, or a refresh token). Never throws, so
 * callers in async Express handlers cannot crash the process with a bad token.
 */
export function verifyAccessToken(token: string): JwtPayload | null {
  try {
    const payload = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] });
    if (typeof payload !== 'object' || payload === null) return null;
    if ((payload as { type?: unknown }).type === 'refresh') return null;
    if (typeof payload.sub !== 'string' || payload.sub === '') return null;
    return payload as JwtPayload;
  } catch {
    return null;
  }
}

export function verifyRefreshToken(token: string): { sub: string; sessionId: string } {
  const payload = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] }) as {
    sub:       string;
    sessionId: string;
    type:      string;
  };
  if (payload.type !== 'refresh') {
    throw new Error('Invalid token type');
  }
  return payload;
}
