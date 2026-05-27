import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import type { JwtPayload } from '../types/index.js';
import { getJwtKeys } from './jwt-keys.js';

/**
 * v5.3.0 — JWT-Signing umgestellt von HS256 (HMAC, symmetrisch) auf
 * RS256 (RSA, asymmetrisch). Outlook 2024 LTSC + andere Modern-Auth-Clients
 * verifizieren JWT-Signaturen selbständig via JWKS-Public-Key —
 * HS256 erlaubt keinen Public-Key-Export → JWKS bliebe leer → Outlook
 * weigert sich, das Konto zu verbinden.
 *
 * VORAUSSETZUNG: `initJwtKeys(prisma)` muss vor jedem Sign/Verify-Call
 * gelaufen sein (geschieht beim Service-Boot in jedem Package).
 *
 * Backward-Compat: alte HS256-Tokens werden bei Verify als invalid
 * abgelehnt — User muss sich neu anmelden. Token-Lifetime ist 15min/30d
 * (Access/Refresh), daher unproblematisch.
 */

export function signAccessToken(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
  const { privateKeyPem, keyId } = getJwtKeys();
  return jwt.sign(payload, privateKeyPem, {
    algorithm: 'RS256',
    expiresIn: config.JWT_ACCESS_TTL,
    keyid:     keyId,
  });
}

export function signRefreshToken(userId: string, sessionId: string): string {
  const { privateKeyPem, keyId } = getJwtKeys();
  return jwt.sign({ sub: userId, sessionId, type: 'refresh' }, privateKeyPem, {
    algorithm: 'RS256',
    expiresIn: config.JWT_REFRESH_TTL,
    keyid:     keyId,
  });
}

export function verifyAccessToken(token: string): JwtPayload {
  const { publicKeyPem } = getJwtKeys();
  return jwt.verify(token, publicKeyPem, { algorithms: ['RS256'] }) as JwtPayload;
}

export function verifyRefreshToken(token: string): { sub: string; sessionId: string } {
  const { publicKeyPem } = getJwtKeys();
  const payload = jwt.verify(token, publicKeyPem, { algorithms: ['RS256'] }) as {
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
  // v5.2.15: case-insensitive Bearer (RFC 7235 §2.1)
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

/**
 * Stellt ein OIDC ID Token aus (RFC 6749 / OIDC Core §3.1.3.3).
 * Jetzt RS256-signiert — Outlook & andere Clients verifizieren das via
 * JWKS-Public-Key am `/.well-known/jwks.json`-Endpoint.
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
  const { privateKeyPem, keyId } = getJwtKeys();
  return jwt.sign(payload, privateKeyPem, {
    algorithm: 'RS256',
    keyid:     keyId,
  });
}
