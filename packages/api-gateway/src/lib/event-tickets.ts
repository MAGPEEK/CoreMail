/**
 * Single-use tickets for the SSE stream (8.0.x).
 *
 * EventSource cannot send an Authorization header, so the web clients used to
 * put the ACCESS TOKEN into the URL (`/api/v1/events?token=…`), where it lands
 * in access logs and browser history. Instead:
 *
 *   POST /api/v1/events/ticket   (Authorization: Bearer <access token>)
 *     → 200 { "ticket": "<43 chars base64url>", "expiresIn": 60 }
 *   GET  /api/v1/events?ticket=<ticket>
 *
 * A ticket is valid for 60 s and exactly one redemption, and carries the
 * claims of the access token it was issued for (user, role, session, iat), so
 * the usual revocation checks (session revoked / all sessions revoked) apply
 * when it is redeemed. Only its SHA-256 is stored (Redis `auth:sse-ticket:<hash>`).
 *
 * Test seam: `globalThis.__ticketRedis` replaces the Redis client.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { getRedisClient } from '@coremail/core';
import type { AuthClaims, ApiUser } from '../middleware/auth.js';

export const EVENT_TICKET_TTL_SEC = 60;

export interface TicketStore {
  setex(key: string, seconds: number, value: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  getdel?(key: string): Promise<string | null>;
}

function store(): TicketStore {
  const seam = (globalThis as Record<string, unknown>)['__ticketRedis'] as TicketStore | undefined;
  return seam ?? (getRedisClient() as unknown as TicketStore);
}

const keyFor = (ticket: string): string => `auth:sse-ticket:${createHash('sha256').update(ticket).digest('hex')}`;

export async function issueEventTicket(user: ApiUser): Promise<{ ticket: string; expiresIn: number }> {
  const ticket = randomBytes(32).toString('base64url');
  const claims: AuthClaims = {
    sub: user.userId,
    role: user.role,
    email: user.email,
    ...(user.sessionId !== undefined ? { sessionId: user.sessionId } : {}),
    mfaVerified: user.mfaVerified === true,
    ...(user.issuedAt !== undefined ? { iat: user.issuedAt } : {}),
    ...(user.issuedAtMs !== undefined ? { iatMs: user.issuedAtMs } : {}),
  };
  await store().setex(keyFor(ticket), EVENT_TICKET_TTL_SEC, JSON.stringify(claims));
  return { ticket, expiresIn: EVENT_TICKET_TTL_SEC };
}

/** POST /api/v1/events/ticket (after requireAuth). */
export async function eventTicketHandler(req: Request, res: Response): Promise<void> {
  const user = req.apiUser;
  if (!user) { res.status(401).json({ error: 'Authorization required' }); return; }
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await issueEventTicket(user));
  } catch {
    res.status(503).json({ error: 'Ticket service temporarily unavailable' });
  }
}

/** Claims of a valid, unused ticket (consumed now), or null. */
export async function redeemEventTicket(ticket: string): Promise<AuthClaims | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) return null;
  const s = store();
  const key = keyFor(ticket);
  let raw: string | null;
  if (typeof s.getdel === 'function') {
    raw = await s.getdel(key);
  } else {
    raw = await s.get(key);
    // single use even without GETDEL: only the redemption that deleted the key wins
    if (raw !== null && (await s.del(key)) !== 1) raw = null;
  }
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as AuthClaims;
    return typeof c.sub === 'string' && typeof c.role === 'string' && typeof c.email === 'string' ? c : null;
  } catch {
    return null;
  }
}
