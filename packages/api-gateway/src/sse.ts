import type { Request, Response } from 'express';
import {
  getRedisClient,
  CHANNEL_MAIL_NEW,
  CHANNEL_MAIL_UPDATE,
  CHANNEL_ADMIN_ATTACK,
  CHANNEL_CALENDAR_SHARES,
  createLogger,
} from '@coremail/core';
import { sendPushToUser } from './lib/push.js';

const log = createLogger('api:sse');

// GET /api/v1/events — Server-Sent Events for live updates
export async function sseHandler(req: Request, res: Response): Promise<void> {
  const userId = req.apiUser!.userId;

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

  const isAdmin = ['ORGANIZATION_MANAGEMENT', 'SERVER_MANAGEMENT', 'HYGIENE_MANAGEMENT', 'COMPLIANCE_MANAGEMENT', 'VIEW_ONLY_ORG', 'RECIPIENT_MANAGEMENT', 'HELP_DESK'].includes(req.apiUser!.role);

  const subscriber = getRedisClient().duplicate();
  const channels: string[] = [
    CHANNEL_MAIL_NEW,
    CHANNEL_MAIL_UPDATE,
    CHANNEL_CALENDAR_SHARES,
    `user:${userId}:events`,
  ];
  if (isAdmin) channels.push(CHANNEL_ADMIN_ATTACK);
  await subscriber.subscribe(...channels);

  subscriber.on('message', (channel: string, message: string) => {
    try {
      const payload = JSON.parse(message) as { userId?: string; [key: string]: unknown };

      if (channel === CHANNEL_ADMIN_ATTACK) {
        // Attack events werden nur an Admin-SSE-Verbindungen weitergeleitet
        send('security:attack', payload);
        return;
      }

      if (channel === CHANNEL_CALENDAR_SHARES) {
        // v3.18.17: Share-Lifecycle-Events kommen mit affectedUserIds[] —
        // an alle in dieser Liste pushen (Owner + Grantee).
        const affected = (payload as { affectedUserIds?: unknown }).affectedUserIds;
        if (Array.isArray(affected) && affected.includes(userId)) {
          send('calendar:shares', payload);
        }
        return;
      }

      // Only forward events for this user
      if (payload.userId && payload.userId !== userId) return;

      if (channel === CHANNEL_MAIL_NEW) {
        send('mail:new', payload);
        // Phase 10: Also push notification to subscribed devices (fire-and-forget)
        if (payload.userId) {
          sendPushToUser(String(payload.userId), 'mail.new', {
            title: `New message from ${String(payload['fromName'] ?? payload['fromAddr'] ?? 'Unknown')}`,
            body: String(payload['subject'] ?? '(No subject)'),
            tag: `mail-${String(payload['messageId'] ?? '')}`,
            url: '/owa/',
          }).catch(() => undefined);
        }
      } else if (channel === CHANNEL_MAIL_UPDATE) {
        send('mail:update', payload);
      } else {
        send('notification', payload);
      }
    } catch (err) {
      log.warn({ err, channel }, 'SSE message parse error');
    }
  });

  req.on('close', () => {
    clearInterval(heartbeat);
    subscriber.unsubscribe().catch(() => undefined);
    subscriber.quit().catch(() => undefined);
    log.debug({ userId }, 'SSE client disconnected');
  });
}
