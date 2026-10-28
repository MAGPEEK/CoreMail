/**
 * Zustellung von JMAP-Push-Nachrichten (StateChange / PushVerification) an
 * PushSubscription-URLs: verschlüsselt per Web Push (RFC 8030/8291, VAPID
 * RFC 8292) wenn `keys` gesetzt sind, sonst als einfacher JSON-POST.
 */
import webPush from 'web-push';
import { createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage';
import { VAPID_PUBLIC_KEY } from '../capabilities.js';

const log = createLogger('jmap:webpush');
const VAPID_PRIVATE_KEY = process.env['VAPID_PRIVATE_KEY'] ?? '';
const VAPID_SUBJECT = process.env['VAPID_SUBJECT'] ?? 'mailto:admin@coremail.local';
let vapidReady = false;

function ensureVapid(): boolean {
  if (vapidReady) return true;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  vapidReady = true;
  return true;
}

export interface PushTarget { id: string; url: string; keysP256dh: string | null; keysAuth: string | null }

export async function sendPushMessage(target: PushTarget, payload: Record<string, unknown>, ttlSec = 3600): Promise<void> {
  const body = JSON.stringify(payload);
  try {
    if (target.keysP256dh && target.keysAuth) {
      const opts: webPush.RequestOptions = { TTL: ttlSec, contentEncoding: 'aes128gcm' };
      if (!ensureVapid()) log.debug('VAPID nicht konfiguriert — Web Push ohne VAPID-Signatur');
      await webPush.sendNotification({ endpoint: target.url, keys: { p256dh: target.keysP256dh, auth: target.keysAuth } }, body, opts);
    } else {
      const resp = await fetch(target.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', TTL: String(ttlSec) },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (resp.status === 404 || resp.status === 410) throw Object.assign(new Error(`HTTP ${resp.status}`), { statusCode: resp.status });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    }
  } catch (err: unknown) {
    const status = typeof err === 'object' && err && 'statusCode' in err ? (err as { statusCode: number }).statusCode : 0;
    if (status === 404 || status === 410) {
      await prisma.jmapPushSubscription.delete({ where: { id: target.id } }).catch(() => undefined);
      log.info({ id: target.id }, 'PushSubscription abgelaufen (410/404) — entfernt');
      return;
    }
    throw err;
  }
}
