/**
 * MAPI/HTTP Session-Store (v4.0.0)
 *
 * Redis-backed Persistenz für MAPI- und NSPI-Sessions. Jede Outlook-Verbindung
 * öffnet via Connect/Bind eine Session mit Cookie. Der Server hält pro Session
 * einen State (User-Identity, ROP-Handle-Table). Sessions laufen automatisch
 * ab (TTL); Outlook erneuert sie bei jedem Call.
 *
 * Cookie-Format:
 *   Set-Cookie: MapiSession=<token>; HttpOnly; SameSite=Strict; Path=/mapi/
 *   Set-Cookie: NspiSession=<token>; HttpOnly; SameSite=Strict; Path=/mapi/nspi/
 *
 * Redis-Keys:
 *   mapi:session:<token>     → JSON state (TTL 600s, renew bei jedem Access)
 *   mapi:nspi-session:<token> → analog
 */

import { createLogger, getRedisClient } from '@coremail/core';
import { randomBytes } from 'node:crypto';

const log = createLogger('mapi:session');

const SESSION_TTL_SECONDS = 600;   // 10 Minuten
const KEY_PREFIX_MAPI     = 'mapi:session:';
const KEY_PREFIX_NSPI     = 'mapi:nspi-session:';

export interface MapiSessionState {
  userId:        string;
  email:         string;
  displayName:   string;
  createdAt:     number;          // unix-ms
  lastSeen:      number;          // unix-ms
  /** ROP-Handle-Table: int32 (handle-id) → opaque object descriptor. */
  handleTable:   Record<number, unknown>;
  /** Nächstes freies Handle (incrementing counter). */
  nextHandle:    number;
}

export interface NspiSessionState {
  userId:        string;
  email:         string;
  createdAt:     number;
  lastSeen:      number;
}

function genToken(): string {
  // 24 Bytes = 192 Bit Entropie → Base64URL (32 Zeichen)
  return randomBytes(24).toString('base64url');
}

// ── MAPI-Session (emsmdb) ────────────────────────────────────────────────────

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
  log.debug({ token: token.slice(0, 8), userId: opts.userId }, 'MAPI-Session erstellt');
  return { token, state };
}

export async function getMapiSession(token: string): Promise<MapiSessionState | null> {
  if (!token) return null;
  const redis = getRedisClient();
  const raw = await redis.get(KEY_PREFIX_MAPI + token);
  if (!raw) return null;
  try {
    const state = JSON.parse(raw) as MapiSessionState;
    // last-seen-Renewal + TTL-Refresh
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
  log.debug({ token: token.slice(0, 8) }, 'MAPI-Session gelöscht');
}

/**
 * Allokiert ein neues ROP-Handle in der Session. Speichert das opaque Object
 * unter dem neuen Index und persistiert die aktualisierte State zurück nach
 * Redis. Liefert das neue Handle.
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

// ── NSPI-Session (nspi) ──────────────────────────────────────────────────────

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

// ── Cookie-Parser ────────────────────────────────────────────────────────────

/** Parst einen Cookie-Header und gibt den ersten Wert für den gewünschten Cookie zurück. */
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
