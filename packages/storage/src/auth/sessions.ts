/**
 * Web/API sessions (v7.0.0).
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
import {
  config, createLogger, issuedBeforeMark, onAuthInvalidation, signAccessToken, signRefreshToken, verifyRefreshToken,
  type RevokeBeforeMark,
} from '@coremail/core';
import type { UserRole } from '@coremail/core/types';
import { prisma } from '../prisma/index.js';
import { authRedis } from './redis.js';
import { publishUserAuthChange } from './invalidation.js';
import { maintenanceBlock } from './policy.js';
import { webLoginBlocked, type WebSurface } from './web-access.js';
import { sessionSurfaceOf } from './refresh-cookie.js';
import type { IncomingHttpHeaders } from 'node:http';
import { recordLastLogin } from './last-login.js';
import { revokeMcpTokensOfUser } from './mcp-tokens.js';
import { IP_VERIFIED_HEADER, normalizeIp } from '../mail-auth-core.js';

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
  /**
   * 9.4: the surface the session is asked for (the Webmail switch): the webmail
   * client gets no session while Webmail is off — not even an admin account,
   * which keeps the BCP and the admin CLI (`admin`, the default).
   */
  surface?: WebSurface | undefined;
  /**
   * 10.5 review: false when `ip` came from a forwarding header nobody verified
   * (TRUST_PROXY hop count / `true`) — the lockout counts it but never
   * escalates it or learns it as a known network. Default true.
   */
  ipTrusted?: boolean | undefined;
}

/**
 * 10.5 review: is `req.ip` trustworthy for escalation? The socket peer itself
 * always is; a forwarded address only with the gateway's mark
 * (IP_VERIFIED_HEADER — set by the api-gateway for the socket address or an
 * address from an explicit TRUST_PROXY allow-list; clients cannot send it).
 */
export function requestIpTrusted(req: { ip?: string | undefined; headers: IncomingHttpHeaders; socket?: { remoteAddress?: string | undefined } | undefined }): boolean {
  const ip = normalizeIp(req.ip);
  const peer = normalizeIp(req.socket?.remoteAddress);
  if (!ip || !peer || ip === peer) return true;
  const mark = req.headers[IP_VERIFIED_HEADER];
  return (Array.isArray(mark) ? mark[0] : mark) === '1';
}

/** The ClientInfo of an HTTP login / refresh / SSO request (Express request). */
export function clientInfoOf(req: { ip?: string | undefined; headers: IncomingHttpHeaders; socket?: { remoteAddress?: string | undefined } | undefined }): ClientInfo {
  const ua = req.headers['user-agent'];
  return { ip: req.ip ?? 'unknown', userAgent: ua ?? '', surface: sessionSurfaceOf(req.headers), ipTrusted: requestIpTrusted(req) };
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
  /** 10.6: `authMethod` 'passkey' for the usernameless passkey sign-in (default 'password'). */
  opts: ClientInfo & { mfaVerified: boolean; authMethod?: 'password' | 'passkey' | undefined },
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
      ...(opts.authMethod ? { authMethod: opts.authMethod } : {}),
      expiresAt: new Date(Date.now() + config.JWT_REFRESH_TTL * 1000),
    },
  });
  // 8.x: every web/API/SSO login ends here → User.lastLoginAt (throttled, fire-and-forget)
  void recordLastLogin(user.id);
  return { accessToken: accessToken(user, sessionId, opts.mfaVerified), refreshToken, expiresIn: config.JWT_ACCESS_TTL };
}

export type RefreshResult =
  | { ok: true; tokens: TokenPair }
  | { ok: false; status: 401; reason: 'invalid' | 'expired' | 'reused' | 'inactive' }
  | { ok: false; status: 503; reason: 'maintenance'; message: string }
  /** 9.4: Webmail is off for the account (no admin role) — the token is not rotated. */
  | { ok: false; status: 403; reason: 'protocol_disabled' };

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
        await markSessionsRevoked([payload.sessionId], payload.sub);
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
  if (await webLoginBlocked(user, client.surface)) return { ok: false, status: 403, reason: 'protocol_disabled' };

  const newRefresh = signRefreshToken(user.id, session.id);
  const swapped = await prisma.session.updateMany({
    where: { id: session.id, tokenHash: session.tokenHash },
    data: { tokenHash: hashRefreshToken(newRefresh), lastUsedAt: new Date(), ipAddress: client.ip },
  });
  if (swapped.count !== 1) {
    // Lost a race against another refresh with the same token → reuse.
    await prisma.session.deleteMany({ where: { id: session.id } });
    await markSessionsRevoked([session.id], user.id);
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
  let userId: string | undefined;
  try {
    const p = verifyRefreshToken(refreshToken);
    sessionId = p.sessionId;
    userId = p.sub;
    if (count === 0) count = (await prisma.session.deleteMany({ where: { id: p.sessionId, userId: p.sub } })).count;
  } catch {
    /* unsigned/expired token — only the hash match above applies */
  }
  if (count > 0 && sessionId) await markSessionsRevoked([sessionId], userId);
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

type UserMark = RevokeBeforeMark;
const userMarks = new Map<string, UserMark>();
const revokedSessions = new Map<string, number>(); // sessionId → expiry (ms)
export const REVOCATION_KEY_PREFIX = 'auth:revoked:';
export const REVOKED_SESSION_KEY_PREFIX = 'auth:revoked-session:';

function markTtlSeconds(): number {
  return config.JWT_ACCESS_TTL + 60;
}

function rememberRevokedSessions(sessionIds: string[], expires: number): void {
  const now = Date.now();
  if (revokedSessions.size > 10_000) {
    for (const [id, exp] of revokedSessions) if (exp < now) revokedSessions.delete(id);
  }
  for (const id of sessionIds) {
    if ((revokedSessions.get(id) ?? 0) < expires) revokedSessions.set(id, expires);
  }
}

/** Mark time in ms (marks of older publishers only have whole seconds). */
const markMs = (m: UserMark): number => m.beforeMs ?? m.before * 1000;

function rememberUserMark(userId: string, mark: UserMark): void {
  const cur = userMarks.get(userId);
  if (!cur || markMs(cur) <= markMs(mark) || cur.expires < Date.now()) userMarks.set(userId, mark);
}

// v7.1.0: revocations performed by another service (auth-service, LDAP sync,
// password reset) arrive via CHANNEL_AUTH_INVALIDATE and are applied to this
// process's in-memory maps — previously the api-gateway only knew revocations it
// had performed itself. Requires startAuthInvalidationSubscriber() at service start.
onAuthInvalidation((e) => {
  const now = Date.now();
  if (e.sessionIds?.length) rememberRevokedSessions(e.sessionIds, now + markTtlSeconds() * 1000);
  if (e.revokeBefore && e.revokeBefore.expires > now) rememberUserMark(e.userId, e.revokeBefore);
  // The Redis lookup cache must not hide a revocation that just happened.
  lastLocalRevocationAt = now;
  redisLookupCache.delete(`u:${e.userId}`);
  for (const id of e.sessionIds ?? []) redisLookupCache.delete(`s:${id}`);
});

/** Local + Redis session revocation markers (no event). */
async function storeSessionRevocations(sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return;
  rememberRevokedSessions(sessionIds, Date.now() + markTtlSeconds() * 1000);
  try {
    const r = authRedis();
    await Promise.all(sessionIds.map((id) => r.setex(`${REVOKED_SESSION_KEY_PREFIX}${id}`, markTtlSeconds(), '1')));
  } catch (err) {
    log.warn({ err }, 'Could not write session revocation markers to Redis');
  }
}

/**
 * Marks sessions as revoked for access-token checks (memory + Redis) and, when
 * the owner is known, publishes an invalidation event (other processes + caches).
 */
export async function markSessionsRevoked(sessionIds: string[], userId?: string): Promise<void> {
  if (sessionIds.length === 0) return;
  await storeSessionRevocations(sessionIds);
  if (userId) await publishUserAuthChange(userId, 'sessions-revoked', { sessionIds });
}

/**
 * 8.0.0: compares the token's millisecond issue time (`iatMs`) with the exact
 * revocation time (`beforeMs`) — whole seconds let a token minted earlier in the
 * same second as a revoke-all survive. See issuedBeforeMark() (@coremail/core).
 */
function userMarkRevokes(mark: UserMark | null | undefined, iat: number | undefined, sessionId: string | undefined, iatMs?: number): boolean {
  if (!mark) return false;
  if (mark.except && sessionId === mark.except) return false;
  return issuedBeforeMark(mark, iat ?? 0, iatMs);
}

/** In-process check only (memory maps, filled by this process and the auth bus). */
export function isAccessTokenRevoked(userId: string, iat: number | undefined, sessionId: string | undefined, iatMs?: number): boolean {
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
  return userMarkRevokes(mark, iat, sessionId, iatMs);
}

// 8.0.0: short local cache for the Redis markers, so a hot path (api-gateway
// requireAuth, every request) does not cost two Redis round trips. Revocation
// events drop the affected entries (above), and the in-process maps are always
// consulted first, so the cache only delays revocations whose event was lost —
// by at most REDIS_LOOKUP_TTL_MS.
const REDIS_LOOKUP_TTL_MS = 5_000;
const REDIS_LOOKUP_MAX = 20_000;
type RedisLookup = { kind: 'session'; revoked: boolean } | { kind: 'user'; mark: UserMark | null };
const redisLookupCache = new Map<string, { value: RedisLookup; expires: number }>();
let lastLocalRevocationAt = 0;

function cacheGet(key: string): RedisLookup | undefined {
  const hit = redisLookupCache.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) { redisLookupCache.delete(key); return undefined; }
  return hit.value;
}
function cacheSet(key: string, value: RedisLookup, startedAt: number): void {
  // A lookup that raced with a revocation event must not re-insert a stale result.
  if (startedAt <= lastLocalRevocationAt) return;
  if (redisLookupCache.size >= REDIS_LOOKUP_MAX) redisLookupCache.clear();
  redisLookupCache.set(key, { value, expires: Date.now() + REDIS_LOOKUP_TTL_MS });
}

/** Clears the Redis lookup cache (tests). */
export function resetRevocationLookupCache(): void {
  redisLookupCache.clear();
}

/**
 * Like isAccessTokenRevoked, but also consults the shared Redis markers, so a
 * restart of this process or a lost invalidation event cannot revive a revoked
 * token. Used by every service, including the api-gateway's requireAuth (8.0.0;
 * previously in-process only there). Redis results are cached for a few seconds
 * (`cache: false` bypasses the cache). Fails open on Redis errors (signature
 * and expiry were already verified, and the in-process maps still apply).
 */
export async function isAccessTokenRevokedShared(
  userId: string, iat: number | undefined, sessionId: string | undefined, iatMs?: number,
  opts: { cache?: boolean } = {},
): Promise<boolean> {
  if (isAccessTokenRevoked(userId, iat, sessionId, iatMs)) return true;
  const useCache = opts.cache !== false;
  const startedAt = Date.now();
  try {
    if (sessionId) {
      const key = `s:${sessionId}`;
      let hit = useCache ? cacheGet(key) : undefined;
      if (!hit) {
        const revoked = !!(await authRedis().get(`${REVOKED_SESSION_KEY_PREFIX}${sessionId}`));
        hit = { kind: 'session', revoked };
        if (useCache) cacheSet(key, hit, startedAt);
      }
      if (hit.kind === 'session' && hit.revoked) return true;
    }
    const key = `u:${userId}`;
    let hit = useCache ? cacheGet(key) : undefined;
    if (!hit) {
      const raw = await authRedis().get(`${REVOCATION_KEY_PREFIX}${userId}`);
      hit = { kind: 'user', mark: raw ? (JSON.parse(raw) as UserMark) : null };
      if (useCache) cacheSet(key, hit, startedAt);
    }
    return hit.kind === 'user' ? userMarkRevokes(hit.mark, iat, sessionId, iatMs) : false;
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

export async function revokeAllSessions(userId: string, opts: RevokeAllOptions): Promise<{ sessions: number; appPasswords: number; mcpTokens: number }> {
  const where = opts.exceptSessionId ? { userId, NOT: { id: opts.exceptSessionId } } : { userId };
  const ids = (await prisma.session.findMany({ where, select: { id: true } })).map((s) => s.id);
  const sessions = (await prisma.session.deleteMany({ where })).count;
  const appPasswords = opts.appPasswords
    ? (await prisma.appPassword.deleteMany({ where: { userId } })).count
    : 0;
  // 10.3: the user's admin MCP tokens end with every "revoke all" (role change,
  // deactivation, deletion, password reset / change, sign out everywhere).
  // Never throws; the api-gateway also rejects tokens older than the mark below.
  const mcpTokens = await revokeMcpTokensOfUser(userId, opts.reason);

  await storeSessionRevocations(ids);
  const now = Date.now();
  const mark: UserMark = {
    before: Math.floor(now / 1000),
    beforeMs: now,
    except: opts.exceptSessionId ?? null,
    expires: now + markTtlSeconds() * 1000,
  };
  rememberUserMark(userId, mark);
  try {
    await authRedis().setex(`${REVOCATION_KEY_PREFIX}${userId}`, markTtlSeconds(), JSON.stringify(mark));
  } catch (err) {
    log.warn({ err, userId }, 'Could not write the access-token revocation marker to Redis');
  }
  // v7.1.0: other processes apply the marks; credential caches drop the user.
  await publishUserAuthChange(userId, opts.reason, {
    ...(ids.length > 0 ? { sessionIds: ids } : {}),
    revokeBefore: mark,
    // v7.1.0: live mail connections authenticated with an app password end too.
    ...(opts.appPasswords ? { appPasswordsRevoked: true } : {}),
  });
  log.info({ userId, sessions, appPasswords, mcpTokens, reason: opts.reason }, 'All sessions revoked');
  return { sessions, appPasswords, mcpTokens };
}

