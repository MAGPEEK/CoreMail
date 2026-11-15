import type { Request, Response } from 'express';
import { createLogger, type AuthInvalidationEvent } from '@coremail/core';
import { getSseHub, startSseHub } from './lib/sse-hub.js';
import { registerSseConnection } from './lib/live-sse.js';
import type { ApiUser } from './middleware/auth.js';

const log = createLogger('api:sse');

const ADMIN_ROLES = ['ORGANIZATION_MANAGEMENT', 'SERVER_MANAGEMENT', 'HYGIENE_MANAGEMENT', 'COMPLIANCE_MANAGEMENT', 'VIEW_ONLY_ORG', 'RECIPIENT_MANAGEMENT', 'HELP_DESK'];

export interface SseDeps {
  start: () => void;
  addClient: (client: { userId: string; isAdmin: boolean; send: (event: string, data: unknown) => void }) => () => void;
  register: (user: ApiUser, terminate: (event: AuthInvalidationEvent) => void) => () => void;
  heartbeatMs?: number;
}

const defaultDeps: SseDeps = {
  start: () => { void startSseHub(); }, // idempotent — normally already started at boot
  addClient: (client) => getSseHub().add(client),
  register: registerSseConnection,
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

    const remove = deps.addClient({ userId, isAdmin: ADMIN_ROLES.includes(user.role), send });
    let closed = false;
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
