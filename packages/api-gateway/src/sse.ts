import type { Request, Response } from 'express';
import { getRedisClient, CHANNEL_MAIL_NEW, CHANNEL_MAIL_UPDATE, createLogger } from '@coremail/core';

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

  const subscriber = getRedisClient().duplicate();
  await subscriber.subscribe(CHANNEL_MAIL_NEW, CHANNEL_MAIL_UPDATE, `user:${userId}:events`);

  subscriber.on('message', (channel: string, message: string) => {
    try {
      const payload = JSON.parse(message) as { userId?: string; [key: string]: unknown };
      // Only forward events for this user
      if (payload.userId && payload.userId !== userId) return;

      if (channel === CHANNEL_MAIL_NEW) {
        send('mail:new', payload);
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
