/**
 * MAPI/HTTP session store (v4.0.0)
 *
 * Redis-backed persistence for MAPI and NSPI sessions. Every Outlook connection
 * opens a session with a cookie via Connect/Bind. The server keeps state per
 * session (user identity, ROP handle table). Sessions expire automatically
 * (TTL); Outlook renews them on every call.
 *
 * Cookie format:
 *   Set-Cookie: MapiSession=<token>; HttpOnly; SameSite=Strict; Path=/mapi/
 *   Set-Cookie: NspiSession=<token>; HttpOnly; SameSite=Strict; Path=/mapi/nspi/
 *
 * Redis keys:
 *   mapi:session:<token>     → JSON state (TTL 600s, renewed on every access)
 *   mapi:nspi-session:<token> → likewise
 */

import { createLogger, getRedisClient } from '@coremail/core';
import { randomBytes } from 'node:crypto';

const log = createLogger('mapi:session');

const SESSION_TTL_SECONDS = 600;   // 10 minutes
const KEY_PREFIX_MAPI     = 'mapi:session:';
const KEY_PREFIX_NSPI     = 'mapi:nspi-session:';

export interface MapiSessionState {
  userId:        string;
  email:         string;
  displayName:   string;
  createdAt:     number;          // unix-ms
  lastSeen:      number;          // unix-ms
  /** ROP handle table: int32 (handle-id) → opaque object descriptor. */
  handleTable:   Record<number, unknown>;
  /** Next free handle (incrementing counter). */
  nextHandle:    number;
}

export interface NspiSessionState {
  userId:        string;
  email:         string;
  createdAt:     number;
  lastSeen:      number;
}

function genToken(): string {
  // 24 bytes = 192 bits of entropy → Base64URL (32 characters)
  return randomBytes(24).toString('base64url');
}

// ── MAPI session (emsmdb) ────────────────────────────────────────────────────

export async function createMapiSession(opts: {
  userId: string;
  email:  string;
  displayName: string;
}): Promise<{ token: string; state: MapiSessionState }> {
  const token = genToken();
  const state: MapiSessionState = {
    userId:      opts.userId,
    email:       opts.email,
    displayName: opts.displayName,
    createdAt:   Date.now(),
    lastSeen:    Date.now(),
    handleTable: {},
    nextHandle:  1,
  };
  const redis = getRedisClient();
  await redis.set(
    KEY_PREFIX_MAPI + token,
    JSON.stringify(state),
    'EX',
    SESSION_TTL_SECONDS,
  );
  log.debug({ token: token.slice(0, 8), userId: opts.userId }, 'MAPI session created');
  return { token, state };
}

export async function getMapiSession(token: string): Promise<MapiSessionState | null> {
  if (!token) return null;
  const redis = getRedisClient();
  const raw = await redis.get(KEY_PREFIX_MAPI + token);
  if (!raw) return null;
  try {
    const state = JSON.parse(raw) as MapiSessionState;
    // last-seen renewal + TTL refresh
    state.lastSeen = Date.now();
    await redis.set(
      KEY_PREFIX_MAPI + token,
      JSON.stringify(state),
      'EX',
      SESSION_TTL_SECONDS,
    );
    return state;
  } catch (err) {
    log.warn({ err, token: token.slice(0, 8) }, 'MAPI-Session JSON-parse failed');
    return null;
  }
}

export async function deleteMapiSession(token: string): Promise<void> {
  if (!token) return;
  await getRedisClient().del(KEY_PREFIX_MAPI + token);
  log.debug({ token: token.slice(0, 8) }, 'MAPI session deleted');
}

/**
 * Allocates a new ROP handle in the session. Stores the opaque object
 * under the new index and persists the updated state back to
 * Redis. Returns the new handle.
 */
export async function allocateRopHandle(
  token: string,
  object: unknown,
): Promise<number | null> {
  const redis = getRedisClient();
  const raw = await redis.get(KEY_PREFIX_MAPI + token);
  if (!raw) return null;
  const state = JSON.parse(raw) as MapiSessionState;
  const handle = state.nextHandle++;
  state.handleTable[handle] = object;
  state.lastSeen = Date.now();
  await redis.set(KEY_PREFIX_MAPI + token, JSON.stringify(state), 'EX', SESSION_TTL_SECONDS);
  return handle;
}

// ── NSPI session (nspi) ──────────────────────────────────────────────────────

export async function createNspiSession(opts: {
  userId: string;
  email:  string;
}): Promise<{ token: string; state: NspiSessionState }> {
  const token = genToken();
  const state: NspiSessionState = {
    userId:    opts.userId,
    email:     opts.email,
    createdAt: Date.now(),
    lastSeen:  Date.now(),
  };
  await getRedisClient().set(
    KEY_PREFIX_NSPI + token,
    JSON.stringify(state),
    'EX',
    SESSION_TTL_SECONDS,
  );
  return { token, state };
}

export async function getNspiSession(token: string): Promise<NspiSessionState | null> {
  if (!token) return null;
  const redis = getRedisClient();
  const raw = await redis.get(KEY_PREFIX_NSPI + token);
  if (!raw) return null;
  try {
    const state = JSON.parse(raw) as NspiSessionState;
    state.lastSeen = Date.now();
    await redis.set(KEY_PREFIX_NSPI + token, JSON.stringify(state), 'EX', SESSION_TTL_SECONDS);
    return state;
  } catch {
    return null;
  }
}

export async function deleteNspiSession(token: string): Promise<void> {
  if (!token) return;
  await getRedisClient().del(KEY_PREFIX_NSPI + token);
}

// ── Cookie parser ────────────────────────────────────────────────────────────

/** Parses a Cookie header and returns the first value for the requested cookie. */
export function getCookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}
