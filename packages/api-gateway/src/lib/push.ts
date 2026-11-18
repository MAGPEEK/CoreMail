/**
 * VAPID Push Notification Service — Phase 10
 *
 * Sends Web Push notifications (RFC 8030) to subscribed browsers/devices.
 * Uses the VAPID (Voluntary Application Server Identification) protocol.
 *
 * VAPID keys are generated once and stored in ENV:
 *   VAPID_PUBLIC_KEY  — base64url encoded public key (sent to clients)
 *   VAPID_PRIVATE_KEY — base64url encoded private key (server secret)
 *   VAPID_SUBJECT     — mailto: or https: contact URL for push services
 *
 * Topics:
 *   mail.new       — new mail received
 *   calendar.reminder — upcoming calendar event reminder
 *   system.alert   — admin system alert
 */

import webPush from 'web-push';
import { prisma } from '@coremail/storage/prisma';
import https from 'node:https';
import { createLogger, assertPublicHttpsUrl, safeLookup } from '@coremail/core';
import { isNotifiable, mailNotification } from './mail-notification.js';
import { currentBranding } from './branding/state.js';

const log = createLogger('push');

// Configure VAPID once at module load
const VAPID_PUBLIC_KEY  = process.env['VAPID_PUBLIC_KEY']  ?? '';
const VAPID_PRIVATE_KEY = process.env['VAPID_PRIVATE_KEY'] ?? '';
const VAPID_SUBJECT     = process.env['VAPID_SUBJECT']     ?? 'mailto:admin@coremail.local';

let vapidConfigured = false;

/**
 * SSRF guard: push endpoints are user-supplied URLs. https only, every
 * resolved address must be public, and the agent re-checks the address at
 * connect time (DNS rebinding). web-push does not follow redirects.
 */
const pushAgent = new https.Agent({ lookup: safeLookup as never, keepAlive: true });


function ensureVapidConfigured(): void {
  if (vapidConfigured) return;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    log.warn('VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — push notifications disabled');
    return;
  }
  webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  vapidConfigured = true;
}

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  tag?: string;       // notification deduplication key
  data?: Record<string, unknown>;
  url?: string;       // click-action URL
}

/** Per-device payload: the subscription decides (e.g. its preview opt-in). */
export type PushPayloadFor = PushPayload | ((sub: { showPreview: boolean }) => PushPayload);

/**
 * Send a push notification to all subscriptions of a user for the given topic.
 */
export async function sendPushToUser(
  userId: string,
  topic: string,
  payload: PushPayloadFor,
): Promise<void> {
  ensureVapidConfigured();
  if (!vapidConfigured) return;

  const subscriptions = await prisma.pushSubscription.findMany({
    where: { userId, topics: { has: topic } },
  });

  if (subscriptions.length === 0) return;

  const payloadOf = (sub: { showPreview: boolean }): string =>
    JSON.stringify(typeof payload === 'function' ? payload(sub) : payload);
  const staleIds: string[] = [];

  await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        try {
          await assertPublicHttpsUrl(sub.endpoint);
        } catch (e) {
          log.warn({ userId, endpoint: sub.endpoint.slice(0, 40), err: (e as Error).message }, 'Push endpoint refused (SSRF guard) — removing subscription');
          staleIds.push(sub.id);
          return;
        }
        await webPush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dhKey, auth: sub.authKey },
          },
          payloadOf(sub),
          { TTL: 86400, agent: pushAgent }, // 24h TTL
        );
        log.debug({ userId, topic, endpoint: sub.endpoint.slice(0, 40) }, 'Push sent');
      } catch (err: unknown) {
        // 410 Gone = subscription expired, remove it
        if (typeof err === 'object' && err !== null && 'statusCode' in err) {
          const statusCode = (err as { statusCode: number }).statusCode;
          if (statusCode === 410 || statusCode === 404) {
            staleIds.push(sub.id);
          }
        }
        log.warn({ err, userId, endpoint: sub.endpoint.slice(0, 40) }, 'Push delivery failed');
      }
    }),
  );

  // Clean up stale subscriptions
  if (staleIds.length > 0) {
    await prisma.pushSubscription.deleteMany({ where: { id: { in: staleIds } } });
    log.info({ count: staleIds.length }, 'Removed stale push subscriptions');
  }
}

/**
 * 9.4: new-mail notification for a `mail:new` event — generic text unless the
 * device opted into previews (sender + subject), click opens the message.
 */
export async function sendMailNotification(userId: string, event: Record<string, unknown>): Promise<void> {
  if (!isNotifiable(event)) return;
  const { productName } = await currentBranding();
  await sendPushToUser(userId, 'mail.new', (sub) => mailNotification(event, { preview: sub.showPreview, productName }));
}

/**
 * Broadcast a push notification to all users subscribed to the given topic.
 * Used for system-wide alerts.
 */
export async function broadcastPush(topic: string, payload: PushPayload): Promise<void> {
  ensureVapidConfigured();
  if (!vapidConfigured) return;

  const subscriptions = await prisma.pushSubscription.findMany({
    where: { topics: { has: topic } },
    select: { userId: true },
    distinct: ['userId'],
  });

  for (const { userId } of subscriptions) {
    await sendPushToUser(userId, topic, payload).catch(() => undefined);
  }
}

/** Return the VAPID public key for the client to use in push subscription. */
export function getVapidPublicKey(): string {
  return VAPID_PUBLIC_KEY;
}
