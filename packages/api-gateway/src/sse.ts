import type { Request, Response } from 'express';
import { createLogger, type AuthInvalidationEvent } from '@coremail/core';
import { getSseHub, startSseHub } from './lib/sse-hub.js';
import { registerSseConnection } from './lib/live-sse.js';
import { currentAdminState, type ApiUser } from './middleware/auth.js';
import { isScoped } from './lib/admin-scope.js';

const log = createLogger('api:sse');

const ADMIN_ROLES = ['ORGANIZATION_MANAGEMENT', 'SERVER_MANAGEMENT', 'HYGIENE_MANAGEMENT', 'COMPLIANCE_MANAGEMENT', 'VIEW_ONLY_ORG', 'RECIPIENT_MANAGEMENT', 'HELP_DESK'];

export interface SseDeps {
  start: () => void;
  addClient: (client: { userId: string; isAdmin: boolean; send: (event: string, data: unknown) => void }) => () => void;
  register: (user: ApiUser, terminate: (event: AuthInvalidationEvent) => void) => () => void;
  /** Does the stream get the organisation-wide admin events (security:attack)? */
  adminFeed?: (user: ApiUser) => Promise<boolean>;
  heartbeatMs?: number;
}

/**
 * Admin events are server-wide: admin roles only, and (9.5) not for admins
 * limited to domains. Role and scope come from the database like on every admin
 * route (middleware/auth.ts currentAdminState — not the token role alone, which
 * may predate a demotion). A failed lookup gives no admin events (fail closed).
 */
async function defaultAdminFeed(user: ApiUser): Promise<boolean> {
  if (!ADMIN_ROLES.includes(user.role)) return false;
  try {
    const { role, scope } = await currentAdminState(user.userId);
    return role !== null && ADMIN_ROLES.includes(role) && !isScoped(scope);
  } catch (err) {
    log.warn({ err, userId: user.userId }, 'Admin scope lookup failed — no admin events on this stream');
    return false;
  }
}

const defaultDeps: SseDeps = {
  start: () => { void startSseHub(); }, // idempotent — normally already started at boot
  addClient: (client) => getSseHub().add(client),
  register: registerSseConnection,
  adminFeed: defaultAdminFeed,
};

/**
 * GET /api/v1/events — Server-Sent Events for live updates.
 * Events come from the process-wide hub (lib/sse-hub.ts): one Redis
 * subscriber per process, per-user routing, Web Push sent there once per event.
 * v7.1.0: the stream is a live connection (lib/live-sse.ts) — a credential
 * change / session revocation ends it with `event: session-ended`; the
 * browser's automatic reconnect then fails with 401 (token revoked).
 */
export function createSseHandler(deps: SseDeps = defaultDeps) {
  return async function sseHandler(req: Request, res: Response): Promise<void> {
    const user = req.apiUser!;
    const userId = user.userId;
    deps.start();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
    res.flushHeaders();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('connected', { userId, timestamp: new Date().toISOString() });

    // Heartbeat every 25s to keep connection alive through proxies
    const heartbeat = setInterval(() => {
      res.write(':heartbeat\n\n');
    }, deps.heartbeatMs ?? 25_000);

    // 9.5: joins the admin feed only once confirmed (fail closed: an admin limited
    // to domains, or a failed lookup, never gets the organisation-wide events)
    let closed = false;
    let remove = deps.addClient({ userId, isAdmin: false, send });
    void (deps.adminFeed ?? defaultAdminFeed)(user).then((admin) => {
      if (!admin || closed) return;
      remove();
      remove = deps.addClient({ userId, isAdmin: true, send });
    });
    const cleanup = () => {
      if (closed) return false;
      closed = true;
      clearInterval(heartbeat);
      remove();
      unregister();
      return true;
    };

    const unregister = deps.register(user, (event) => {
      if (!cleanup()) return;
      try {
        send('session-ended', { reason: 'credentials-changed' });
        res.end();
      } catch { /* socket already gone */ }
      log.info({ userId, reason: event.reason }, 'SSE stream ended after a credential change');
    });

    req.on('close', () => {
      if (cleanup()) log.debug({ userId }, 'SSE client disconnected');
    });
  };
}

export const sseHandler = createSseHandler();
