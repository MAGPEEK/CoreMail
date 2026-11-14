/**
 * Delivery of JMAP push messages (StateChange / PushVerification) to
 * PushSubscription URLs: encrypted via Web Push (RFC 8030/8291, VAPID
 * RFC 8292) when `keys` are set, otherwise as a plain JSON POST.
 *
 * SSRF guard: the URL is client-supplied. It must be https, every resolved
 * address must be public (checked before sending and again at connect time
 * via `safeLookup`, so DNS rebinding cannot redirect to internal hosts), and
 * redirects are never followed.
 */
import https from 'node:https';
import webPush from 'web-push';
import { createLogger, assertPublicHttpsUrl, safeLookup } from '@coremail/core';
import { prisma } from '@coremail/storage';
import { VAPID_PUBLIC_KEY } from '../capabilities.js';

const log = createLogger('jmap:webpush');
const VAPID_PRIVATE_KEY = process.env['VAPID_PRIVATE_KEY'] ?? '';
const VAPID_SUBJECT = process.env['VAPID_SUBJECT'] ?? 'mailto:admin@coremail.local';
let vapidReady = false;

const pushAgent = new https.Agent({ lookup: safeLookup as never, keepAlive: true });

function ensureVapid(): boolean {
  if (vapidReady) return true;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  vapidReady = true;
  return true;
}

export interface PushTarget { id: string; url: string; keysP256dh: string | null; keysAuth: string | null }

/** Plain JSON POST without redirects, through the SSRF-safe agent. Resolves with the status code. */
export function postJson(url: string, body: string, ttlSec: number, agent: https.Agent = pushAgent): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      agent,
      headers: { 'Content-Type': 'application/json', TTL: String(ttlSec), 'Content-Length': Buffer.byteLength(body) },
      timeout: 10_000,
    }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('timeout', () => req.destroy(new Error('push request timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

export async function sendPushMessage(target: PushTarget, payload: Record<string, unknown>, ttlSec = 3600): Promise<void> {
  const body = JSON.stringify(payload);
  try {
    await assertPublicHttpsUrl(target.url);
  } catch (err) {
    log.warn({ id: target.id, err: (err as Error).message }, 'PushSubscription URL refused (SSRF guard)');
    throw err;
  }
  try {
    if (target.keysP256dh && target.keysAuth) {
      const opts: webPush.RequestOptions = { TTL: ttlSec, contentEncoding: 'aes128gcm', agent: pushAgent };
      if (!ensureVapid()) log.debug('VAPID not configured — Web Push without VAPID signature');
      await webPush.sendNotification({ endpoint: target.url, keys: { p256dh: target.keysP256dh, auth: target.keysAuth } }, body, opts);
    } else {
      const status = await postJson(target.url, body, ttlSec);
      if (status === 404 || status === 410) throw Object.assign(new Error(`HTTP ${status}`), { statusCode: status });
      if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`); // 3xx = redirect, deliberately not followed
    }
  } catch (err: unknown) {
    const status = typeof err === 'object' && err && 'statusCode' in err ? (err as { statusCode: number }).statusCode : 0;
    if (status === 404 || status === 410) {
      await prisma.jmapPushSubscription.delete({ where: { id: target.id } }).catch(() => undefined);
      log.info({ id: target.id }, 'PushSubscription expired (410/404) — removed');
      return;
    }
    throw err;
  }
}
