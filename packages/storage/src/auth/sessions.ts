/**
 * Web/API sessions (v6.0.0).
 *
 * - `Session.id` is the JWT `sessionId` claim of both access and refresh token.
 * - `Session.tokenHash` = sha256(current refresh token). The raw token is never stored.
 * - Every /auth/refresh rotates the refresh token (conditional update on the old
 *   hash). Presenting a validly signed refresh token whose hash is no longer
 *   current (= an already rotated token) is treated as token theft: the whole
 *   session (the token family) is revoked.
 * - Legacy rows (pre-v6, raw refresh JWT in tokenHash) are accepted exactly once
 *   by raw match and migrated to the hash on that refresh.
 * - revokeAllSessions() deletes the rows and additionally marks access tokens
 *   issued before now as revoked (in-process check in the api-gateway's
 *   requireAuth + a Redis marker other services may consult).
 */
import { createHash, randomUUID } from 'node:crypto';
import { config, createLogger, signAccessToken, signRefreshToken, verifyRefreshToken } from '@coremail/core';
import type { UserRole } from '@coremail/core/types';
import { prisma } from '../prisma/index.js';
import { authRedis } from './redis.js';
import { maintenanceBlock } from './policy.js';

const log = createLogger('auth:sessions');

export interface SessionUser {
  id: string;
  email: string;
  role: string;
  domainId: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface ClientInfo {
  ip: string;
  userAgent: string;
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function accessToken(user: SessionUser, sessionId: string, mfaVerified: boolean): string {
  return signAccessToken({
    sub: user.id,
    email: user.email,
    role: user.role as UserRole,
    domainId: user.domainId,
    sessionId,
    mfaVerified,
  });
}

/** Creates a session row and returns a fresh token pair. */
export async function issueSession(
  user: SessionUser,
  opts: ClientInfo & { mfaVerified: boolean },
): Promise<TokenPair> {
  const sessionId = randomUUID();
  const refreshToken = signRefreshToken(user.id, sessionId);
  await prisma.session.create({
    data: {
      id: sessionId,
      userId: user.id,
      tokenHash: hashRefreshToken(refreshToken),
      ipAddress: opts.ip,
      userAgent: opts.userAgent,
      mfaVerified: opts.mfaVerified,
      expiresAt: new Date(Date.now() + config.JWT_REFRESH_TTL * 1000),
    },
  });
  return { accessToken: accessToken(user, sessionId, opts.mfaVerified), refreshToken, expiresIn: config.JWT_ACCESS_TTL };
}

export type RefreshResult =
  | { ok: true; tokens: TokenPair }
  | { ok: false; status: 401; reason: 'invalid' | 'expired' | 'reused' | 'inactive' }
  | { ok: false; status: 503; reason: 'maintenance'; message: string };

/** Validates and rotates a refresh token. */
export async function rotateSession(refreshToken: string, client: ClientInfo): Promise<RefreshResult> {
  let payload: { sub: string; sessionId: string };
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    return { ok: false, status: 401, reason: 'invalid' };
  }

  const hash = hashRefreshToken(refreshToken);
  let session = await prisma.session.findUnique({ where: { tokenHash: hash } });
  if (!session) {
    // Pre-v6 row: raw token stored. Accepted once, migrated below.
    session = await prisma.session.findUnique({ where: { tokenHash: refreshToken } });
  }

  if (!session) {
    // Validly signed but not current → rotated token replayed: revoke the family.
    if (payload.sessionId) {
      const revoked = await prisma.session.deleteMany({ where: { id: payload.sessionId, userId: payload.sub } });
      if (revoked.count > 0) {
        await markSessionsRevoked([payload.sessionId]);
        log.warn({ userId: payload.sub, sessionId: payload.sessionId, ip: client.ip },
          'Refresh token reuse detected — session revoked');
        return { ok: false, status: 401, reason: 'reused' };
      }
    }
    return { ok: false, status: 401, reason: 'invalid' };
  }

  if (session.userId !== payload.sub) return { ok: false, status: 401, reason: 'invalid' };

  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.session.deleteMany({ where: { id: session.id } });
    return { ok: false, status: 401, reason: 'expired' };
  }

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { id: true, email: true, role: true, domainId: true, active: true },
  });
  if (!user || !user.active) {
    await prisma.session.deleteMany({ where: { userId: session.userId } });
    return { ok: false, status: 401, reason: 'inactive' };
  }

  const blocked = await maintenanceBlock(user.role);
  if (blocked) return { ok: false, status: 503, reason: 'maintenance', message: blocked };

  const newRefresh = signRefreshToken(user.id, session.id);
  const swapped = await prisma.session.updateMany({
    where: { id: session.id, tokenHash: session.tokenHash },
    data: { tokenHash: hashRefreshToken(newRefresh), lastUsedAt: new Date(), ipAddress: client.ip },
  });
  if (swapped.count !== 1) {
    // Lost a race against another refresh with the same token → reuse.
    await prisma.session.deleteMany({ where: { id: session.id } });
    await markSessionsRevoked([session.id]);
    log.warn({ userId: user.id, sessionId: session.id }, 'Concurrent refresh with the same token — session revoked');
    return { ok: false, status: 401, reason: 'reused' };
  }

  return {
    ok: true,
    tokens: {
      accessToken: accessToken(user, session.id, session.mfaVerified),
      refreshToken: newRefresh,
      expiresIn: config.JWT_ACCESS_TTL,
    },
  };
}

/** Logout: revokes the session the refresh token belongs to (current, rotated or legacy). */
export async function revokeSessionByRefreshToken(refreshToken: string): Promise<number> {
  let count = (await prisma.session.deleteMany({
    where: { OR: [{ tokenHash: hashRefreshToken(refreshToken) }, { tokenHash: refreshToken }] },
  })).count;
  let sessionId: string | null = null;
  try {
    const p = verifyRefreshToken(refreshToken);
    sessionId = p.sessionId;
    if (count === 0) count = (await prisma.session.deleteMany({ where: { id: p.sessionId, userId: p.sub } })).count;
  } catch {
    /* unsigned/expired token — only the hash match above applies */
  }
  if (count > 0 && sessionId) await markSessionsRevoked([sessionId]);
  return count;
}

// ── Access-token revocation ───────────────────────────────────────────────────
//
// Access tokens are stateless JWTs (15 min). When sessions are revoked, their
// ids are remembered for the access-token lifetime so tokens of those sessions
// are rejected immediately: in-process (the api-gateway performs the
// revocations itself) and via Redis keys for other services
// (isAccessTokenRevokedShared). A per-user "issued before" mark additionally
// covers access tokens whose sessionId is not a session row (pre-v6 tokens).

interface UserMark { before: number; except: string | null; expires: number }
const userMarks = new Map<string, UserMark>();
const revokedSessions = new Map<string, number>(); // sessionId → expiry (ms)
export const REVOCATION_KEY_PREFIX = 'auth:revoked:';
export const REVOKED_SESSION_KEY_PREFIX = 'auth:revoked-session:';

function markTtlSeconds(): number {
  return config.JWT_ACCESS_TTL + 60;
}

/** Marks sessions as revoked for access-token checks (memory + Redis). */
export async function markSessionsRevoked(sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return;
  const now = Date.now();
  if (revokedSessions.size > 10_000) {
    for (const [id, exp] of revokedSessions) if (exp < now) revokedSessions.delete(id);
  }
  for (const id of sessionIds) revokedSessions.set(id, now + markTtlSeconds() * 1000);
  try {
    const r = authRedis();
    await Promise.all(sessionIds.map((id) => r.setex(`${REVOKED_SESSION_KEY_PREFIX}${id}`, markTtlSeconds(), '1')));
  } catch (err) {
    log.warn({ err }, 'Could not write session revocation markers to Redis');
  }
}

function userMarkRevokes(mark: UserMark | null | undefined, iat: number | undefined, sessionId: string | undefined): boolean {
  if (!mark) return false;
  if (mark.except && sessionId === mark.except) return false;
  return (iat ?? 0) < mark.before;
}

/** In-process check (api-gateway requireAuth). */
export function isAccessTokenRevoked(userId: string, iat: number | undefined, sessionId: string | undefined): boolean {
  const now = Date.now();
  if (sessionId) {
    const exp = revokedSessions.get(sessionId);
    if (exp !== undefined) {
      if (exp >= now) return true;
      revokedSessions.delete(sessionId);
    }
  }
  const mark = userMarks.get(userId);
  if (mark && mark.expires < now) { userMarks.delete(userId); return false; }
  return userMarkRevokes(mark, iat, sessionId);
}

/**
 * Like isAccessTokenRevoked, but also consults the Redis markers — for services
 * other than the api-gateway (e.g. the auth-service). Fails open on Redis errors
 * (signature and expiry were already verified).
 */
export async function isAccessTokenRevokedShared(userId: string, iat: number | undefined, sessionId: string | undefined): Promise<boolean> {
  if (isAccessTokenRevoked(userId, iat, sessionId)) return true;
  try {
    const r = authRedis();
    if (sessionId && (await r.get(`${REVOKED_SESSION_KEY_PREFIX}${sessionId}`))) return true;
    const raw = await r.get(`${REVOCATION_KEY_PREFIX}${userId}`);
    return raw ? userMarkRevokes(JSON.parse(raw) as UserMark, iat, sessionId) : false;
  } catch {
    return false;
  }
}

export interface RevokeAllOptions {
  /** Keep this session (e.g. the one changing its own password). */
  exceptSessionId?: string;
  /** Also delete all app passwords (password reset by mail). */
  appPasswords?: boolean;
  reason: string;
}

export async function revokeAllSessions(userId: string, opts: RevokeAllOptions): Promise<{ sessions: number; appPasswords: number }> {
  const where = opts.exceptSessionId ? { userId, NOT: { id: opts.exceptSessionId } } : { userId };
  const ids = (await prisma.session.findMany({ where, select: { id: true } })).map((s) => s.id);
  const sessions = (await prisma.session.deleteMany({ where })).count;
  const appPasswords = opts.appPasswords
    ? (await prisma.appPassword.deleteMany({ where: { userId } })).count
    : 0;

  await markSessionsRevoked(ids);
  const mark: UserMark = {
    before: Math.floor(Date.now() / 1000),
    except: opts.exceptSessionId ?? null,
    expires: Date.now() + markTtlSeconds() * 1000,
  };
  userMarks.set(userId, mark);
  try {
    await authRedis().setex(`${REVOCATION_KEY_PREFIX}${userId}`, markTtlSeconds(), JSON.stringify(mark));
  } catch (err) {
    log.warn({ err, userId }, 'Could not write the access-token revocation marker to Redis');
  }
  log.info({ userId, sessions, appPasswords, reason: opts.reason }, 'All sessions revoked');
  return { sessions, appPasswords };
}

