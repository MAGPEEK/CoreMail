/**
 * Admin MCP interface (10.3) — protocol sessions (`Mcp-Session-Id`).
 *
 * A session is created by `initialize` and bound to the MCP token that created
 * it: a request with the id of another token's session gets 404 like an
 * unknown id. Sessions live in this gateway process (idle timeout, per-token
 * and global caps) and are registered as live connections (protocol `mcp`,
 * credential `token`, sessionId `mcp:<tokenId>`): every "revoke all" of the
 * owner (role change, deactivation, password reset, sign out everywhere), the
 * deletion of the account and a revocation of the token end them at once
 * (LiveConnectionRegistry + publishUserAuthChange). Switching the interface
 * off ends all of them (settings.ts).
 *
 * Ending a session only drops protocol state — no long-lived HTTP stream is
 * held (every request is answered with one JSON response) and every request
 * verifies its bearer token again.
 */
import { randomBytes } from 'node:crypto';
import { LiveConnectionRegistry, createLogger } from '@coremail/core';

const log = createLogger('mcp:sessions');

export interface McpSession {
  readonly id: string;
  readonly tokenId: string;
  readonly userId: string;
  readonly protocolVersion: string;
  readonly createdAt: number;
  lastSeenAt: number;
  readonly clientName: string;
}

interface Entry { session: McpSession; unregister: () => void }

const sessions = new Map<string, Entry>();

/** Live MCP sessions — attachInvalidation() at gateway start (server.ts). */
export const mcpLiveConnections = new LiveConnectionRegistry('mcp');

const envInt = (name: string, fallback: number, min: number, max: number): number => {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
};

/** Idle timeout of a session (MCP_SESSION_IDLE_MINUTES, default 30). */
export const sessionIdleMs = (): number => envInt('MCP_SESSION_IDLE_MINUTES', 30, 1, 24 * 60) * 60_000;
export const MAX_SESSIONS_PER_TOKEN = 16;
export const MAX_SESSIONS = 1000;

/** The live-connection session id of a token's sessions (one revocation ends them all). */
export function mcpSessionKey(tokenId: string): string {
  return `mcp:${tokenId}`;
}

function remove(id: string, reason: string): boolean {
  const e = sessions.get(id);
  if (!e) return false;
  sessions.delete(id);
  try { e.unregister(); } catch { /* already gone */ }
  log.debug({ sessionId: id.slice(0, 8), tokenId: e.session.tokenId, reason }, 'MCP session ended');
  return true;
}

function oldestOf(filter: (s: McpSession) => boolean): string | null {
  let oldest: McpSession | null = null;
  for (const { session } of sessions.values()) {
    if (filter(session) && (!oldest || session.lastSeenAt < oldest.lastSeenAt)) oldest = session;
  }
  return oldest?.id ?? null;
}

let sweeper: NodeJS.Timeout | null = null;
function ensureSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => sweepIdleSessions(), 60_000);
  sweeper.unref();
}

/** Ends sessions idle for longer than the timeout. Returns their number. */
export function sweepIdleSessions(now = Date.now()): number {
  const cutoff = now - sessionIdleMs();
  let n = 0;
  for (const [id, e] of [...sessions]) if (e.session.lastSeenAt < cutoff && remove(id, 'idle')) n++;
  return n;
}

/**
 * Creates a session for a verified token. `authStartedAt` = when the token
 * check began: an invalidation event that arrived since then ends the session
 * right away (LiveConnectionRegistry.register).
 */
export function createSession(opts: {
  tokenId: string; userId: string; protocolVersion: string; clientName?: string; authStartedAt: number;
}): McpSession {
  ensureSweeper();
  // caps: oldest session of the token, then the oldest overall
  while ([...sessions.values()].filter((e) => e.session.tokenId === opts.tokenId).length >= MAX_SESSIONS_PER_TOKEN) {
    const victim = oldestOf((s) => s.tokenId === opts.tokenId);
    if (!victim) break;
    remove(victim, 'token-cap');
  }
  while (sessions.size >= MAX_SESSIONS) {
    const victim = oldestOf(() => true);
    if (!victim) break;
    remove(victim, 'global-cap');
  }
  const now = Date.now();
  const session: McpSession = {
    id: randomBytes(32).toString('base64url'),
    tokenId: opts.tokenId,
    userId: opts.userId,
    protocolVersion: opts.protocolVersion,
    createdAt: now,
    lastSeenAt: now,
    clientName: (opts.clientName ?? '').slice(0, 100),
  };
  const entry: Entry = { session, unregister: () => undefined };
  sessions.set(session.id, entry);
  entry.unregister = mcpLiveConnections.register({
    userId: opts.userId,
    credential: 'token',
    sessionId: mcpSessionKey(opts.tokenId),
    protocol: 'mcp',
    terminate: (event) => { remove(session.id, `auth:${String(event.reason)}`); },
  }, opts.authStartedAt);
  return session;
}

/**
 * The session `id` when it exists, is not idle-expired and belongs to `tokenId`
 * (anything else → null: the caller answers 404 like for an unknown id).
 */
export function getSession(id: string, tokenId: string, now = Date.now()): McpSession | null {
  const e = sessions.get(id);
  if (!e) return null;
  if (e.session.lastSeenAt < now - sessionIdleMs()) { remove(id, 'idle'); return null; }
  if (e.session.tokenId !== tokenId) return null;
  e.session.lastSeenAt = now;
  return e.session;
}

/** Ends one session of `tokenId` (DELETE /mcp). False when unknown / not the token's. */
export function endSession(id: string, tokenId: string): boolean {
  const e = sessions.get(id);
  if (!e || e.session.tokenId !== tokenId) return false;
  return remove(id, 'client');
}

/** Ends every session of a token (revocation, expiry). */
export function endSessionsOfToken(tokenId: string, reason: string): number {
  let n = 0;
  for (const [id, e] of [...sessions]) if (e.session.tokenId === tokenId && remove(id, reason)) n++;
  return n;
}

/** Ends every session (switch off). */
export function endAllSessions(reason: string): number {
  let n = 0;
  for (const id of [...sessions.keys()]) if (remove(id, reason)) n++;
  if (n > 0) log.info({ sessions: n, reason }, 'All MCP sessions ended');
  return n;
}

/** Number of open sessions (of one token, or in total). */
export function sessionCount(tokenId?: string): number {
  if (tokenId === undefined) return sessions.size;
  return [...sessions.values()].filter((e) => e.session.tokenId === tokenId).length;
}
