import { getRedis, CHANNEL_MAIL_NEW, CHANNEL_MAIL_UPDATE } from '@coremail/core';
import { soapEnvelope, errorResponse } from '../soap/response.js';
import type { EwsUser } from '../auth/middleware.js';
import type { Response } from 'express';
import { randomBytes } from 'node:crypto';
import { createLogger } from '@coremail/core';

const log = createLogger('ews:subscription');

const activeStreams = new Map<string, Response>();

export async function subscribe(
  request: Record<string, unknown>,
  user: EwsUser,
): Promise<string> {
  const subscriptionType = request['StreamingSubscriptionRequest'] ? 'Streaming' : 'Push';
  const subscriptionId = randomBytes(16).toString('hex');

  // Store subscription in Redis (30 min TTL)
  const redis = getRedis();
  await redis.setex(
    `ews:subscription:${subscriptionId}`,
    30 * 60,
    JSON.stringify({ userId: user.userId, type: subscriptionType }),
  );

  return soapEnvelope((body) => {
    body
      .ele('m:SubscribeResponse')
      .ele('m:ResponseMessages')
      .ele('m:SubscribeResponseMessage', { ResponseClass: 'Success' })
      .ele('m:ResponseCode').txt('NoError').up()
      .ele('m:SubscriptionId').txt(subscriptionId).up()
      .ele('m:Watermark').txt('0');
  });
}

export async function unsubscribe(
  request: Record<string, unknown>,
  _user: EwsUser,
): Promise<string> {
  const subscriptionId = String(request['SubscriptionId'] ?? '');
  const redis = getRedis();
  await redis.del(`ews:subscription:${subscriptionId}`);

  const stream = activeStreams.get(subscriptionId);
  if (stream) {
    stream.end();
    activeStreams.delete(subscriptionId);
  }

  return soapEnvelope((body) => {
    body
      .ele('m:UnsubscribeResponse')
      .ele('m:ResponseMessages')
      .ele('m:UnsubscribeResponseMessage', { ResponseClass: 'Success' })
      .ele('m:ResponseCode').txt('NoError');
  });
}

// Streaming subscription — long-poll SSE-like endpoint for Outlook push
export async function getStreamingEvents(
  request: Record<string, unknown>,
  user: EwsUser,
  res: Response,
): Promise<void> {
  const subscriptionIdRaw = request['SubscriptionIds'] as Record<string, unknown> | undefined;
  const subscriptionId = String(subscriptionIdRaw?.['SubscriptionId'] ?? '');

  const connectionTimeout = parseInt(String(request['ConnectionTimeout'] ?? '30'), 10) * 60 * 1000;

  res.set({
    'Content-Type': 'text/xml; charset=utf-8',
    'Transfer-Encoding': 'chunked',
    Connection: 'keep-alive',
  });

  activeStreams.set(subscriptionId, res);

  const redis = getRedis();
  const subscriber = redis.duplicate();
  await subscriber.subscribe(CHANNEL_MAIL_NEW, CHANNEL_MAIL_UPDATE);

  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    activeStreams.delete(subscriptionId);
    subscriber.unsubscribe().catch(() => undefined);
    subscriber.quit().catch(() => undefined);
  };

  res.on('close', cleanup);
  res.on('error', cleanup);

  // Send initial "connection established" response
  res.write(soapEnvelope((body) => {
    body
      .ele('m:GetStreamingEventsResponse')
      .ele('m:ResponseMessages')
      .ele('m:GetStreamingEventsResponseMessage', { ResponseClass: 'Success' })
      .ele('m:ResponseCode').txt('NoError').up()
      .ele('m:ConnectionStatus').txt('OK');
  }));

  subscriber.on('message', (_channel: string, message: string) => {
    if (closed) return;
    try {
      const event = JSON.parse(message) as { userId?: string };
      if (event.userId !== user.userId) return;

      const eventXml = soapEnvelope((body) => {
        body
          .ele('m:GetStreamingEventsResponse')
          .ele('m:ResponseMessages')
          .ele('m:GetStreamingEventsResponseMessage', { ResponseClass: 'Success' })
          .ele('m:ResponseCode').txt('NoError').up()
          .ele('m:ConnectionStatus').txt('OK').up()
          .ele('m:Notifications')
          .ele('m:Notification')
          .ele('t:SubscriptionId').txt(subscriptionId).up()
          .ele('t:NewMailEvent')
          .ele('t:TimeStamp').txt(new Date().toISOString());
      });

      res.write(eventXml);
    } catch {
      // ignore malformed messages
    }
  });

  setTimeout(() => {
    if (!closed) {
      cleanup();
      res.end();
    }
  }, connectionTimeout);
}
