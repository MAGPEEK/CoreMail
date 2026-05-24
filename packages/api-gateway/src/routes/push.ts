/**
 * VAPID Push Notification API — Phase 10
 *
 * User-facing routes for managing push subscriptions.
 *
 *   GET    /api/v1/push/vapid-public-key           — get VAPID public key
 *   POST   /api/v1/push/subscribe                  — register a push subscription
 *   PUT    /api/v1/push/subscribe/:id/topics       — update subscribed topics
 *   DELETE /api/v1/push/subscribe/:id              — remove a push subscription
 *   GET    /api/v1/push/subscriptions              — list own subscriptions
 *   POST   /api/v1/push/test                       — send a test notification
 */

import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { prisma } from '@coremail/storage/prisma';
import { requireAuth } from '../middleware/auth.js';
import { sendPushToUser, getVapidPublicKey } from '../lib/push.js';

export const pushRouter: RouterType = Router();
pushRouter.use(requireAuth);

const VALID_TOPICS = ['mail.new', 'calendar.reminder', 'system.alert'];

/**
 * GET /api/v1/push/vapid-public-key
 * Returns the VAPID public key needed by the browser's PushManager.subscribe().
 */
pushRouter.get('/vapid-public-key', (_req: Request, res: Response) => {
  const key = getVapidPublicKey();
  if (!key) {
    res.status(503).json({ error: 'Push notifications not configured on this server' });
    return;
  }
  res.json({ publicKey: key });
});

/**
 * POST /api/v1/push/subscribe
 * Register a Web Push subscription.
 * Body: { endpoint, keys: { p256dh, auth }, topics?, userAgent? }
 */
pushRouter.post('/subscribe', async (req: Request, res: Response) => {
  const { endpoint, keys, topics, userAgent } = req.body as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
    topics?: string[];
    userAgent?: string;
  };

  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    res.status(400).json({ error: 'endpoint and keys (p256dh, auth) are required' });
    return;
  }

  const normalizedTopics = (topics ?? ['mail.new']).filter((t) => VALID_TOPICS.includes(t));

  const subscription = await prisma.pushSubscription.upsert({
    where: { endpoint },
    create: {
      userId: req.apiUser!.userId,
      endpoint,
      p256dhKey: keys.p256dh,
      authKey: keys.auth,
      topics: normalizedTopics,
      userAgent: userAgent ?? req.get('user-agent') ?? '',
    },
    update: {
      p256dhKey: keys.p256dh,
      authKey: keys.auth,
      topics: normalizedTopics,
    },
    select: { id: true, endpoint: true, topics: true, createdAt: true },
  });

  res.status(201).json(subscription);
});

/**
 * PUT /api/v1/push/subscribe/:id/topics
 * Update which topics a subscription is listening to.
 * Body: { topics: string[] }
 */
pushRouter.put('/subscribe/:id/topics', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const { topics } = req.body as { topics?: string[] };

  const sub = await prisma.pushSubscription.findFirst({
    where: { id, userId: req.apiUser!.userId },
  });
  if (!sub) { res.status(404).json({ error: 'Subscription not found' }); return; }

  const normalizedTopics = (topics ?? []).filter((t) => VALID_TOPICS.includes(t));
  const updated = await prisma.pushSubscription.update({
    where: { id },
    data: { topics: normalizedTopics },
    select: { id: true, topics: true },
  });
  res.json(updated);
});

/**
 * DELETE /api/v1/push/subscribe/:id
 * Remove a push subscription.
 */
pushRouter.delete('/subscribe/:id', async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const sub = await prisma.pushSubscription.findFirst({
    where: { id, userId: req.apiUser!.userId },
  });
  if (!sub) { res.status(404).json({ error: 'Subscription not found' }); return; }
  await prisma.pushSubscription.delete({ where: { id } });
  res.json({ ok: true });
});

/**
 * GET /api/v1/push/subscriptions
 * List all push subscriptions for the current user.
 */
pushRouter.get('/subscriptions', async (req: Request, res: Response) => {
  const subs = await prisma.pushSubscription.findMany({
    where: { userId: req.apiUser!.userId },
    select: { id: true, endpoint: true, topics: true, userAgent: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(subs);
});

/**
 * POST /api/v1/push/test
 * Send a test notification to all subscriptions of the current user.
 */
pushRouter.post('/test', async (req: Request, res: Response) => {
  const { topic } = req.body as { topic?: string };
  const t = topic && VALID_TOPICS.includes(topic) ? topic : 'mail.new';

  await sendPushToUser(req.apiUser!.userId, t, {
    title: 'CoreMail — Test Notification',
    body: 'Push notifications are working correctly! 🎉',
    tag: 'test',
    url: '/owa/',
  });

  res.json({ ok: true, topic: t });
});
