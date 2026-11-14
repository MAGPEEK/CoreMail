import type { Request, Response } from 'express';
import { createLogger } from '@coremail/core';
import { getSseHub, startSseHub } from './lib/sse-hub.js';

const log = createLogger('api:sse');

const ADMIN_ROLES = ['ORGANIZATION_MANAGEMENT', 'SERVER_MANAGEMENT', 'HYGIENE_MANAGEMENT', 'COMPLIANCE_MANAGEMENT', 'VIEW_ONLY_ORG', 'RECIPIENT_MANAGEMENT', 'HELP_DESK'];

// GET /api/v1/events — Server-Sent Events for live updates.
// Events come from the process-wide hub (lib/sse-hub.ts): one Redis
// subscriber per process, per-user routing, Web Push sent there once per event.
export async function sseHandler(req: Request, res: Response): Promise<void> {
  const userId = req.apiUser!.userId;
  void startSseHub(); // idempotent — normally already started at boot

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
  }, 25_000);

  const remove = getSseHub().add({ userId, isAdmin: ADMIN_ROLES.includes(req.apiUser!.role), send });

  req.on('close', () => {
    clearInterval(heartbeat);
    remove();
    log.debug({ userId }, 'SSE client disconnected');
  });
}
