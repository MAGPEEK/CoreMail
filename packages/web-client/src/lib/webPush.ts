/**
 * 9.4 Web Push in the webmail — pure helpers (no imports, unit-tested with
 * `node --test`). The browser side lives in hooks/useWebPush.ts, the service
 * worker in public/sw.js + public/sw-logic.js, the server side in the gateway
 * (routes/push.ts, lib/mail-notification.ts).
 */

/** Message the service worker posts to a webmail window on a notification click. */
export const SW_OPEN_MESSAGE_TYPE = 'coremail:open';

export type PushAvailability =
  | 'unsupported'      // no service worker / Push API / Notification API
  | 'insecure'         // not a secure context (http:// other than localhost)
  | 'denied'           // the user blocked notifications for this site
  | 'available';

export interface PushEnvironment {
  serviceWorker: boolean;
  pushManager: boolean;
  notification: boolean;
  secureContext: boolean;
  permission: 'default' | 'granted' | 'denied';
}

export function pushAvailability(env: PushEnvironment): PushAvailability {
  if (!env.serviceWorker || !env.pushManager || !env.notification) return 'unsupported';
  if (!env.secureContext) return 'insecure';
  if (env.permission === 'denied') return 'denied';
  return 'available';
}

/** German explanation of a state in which push cannot be switched on (null = it can). */
export function availabilityHint(a: PushAvailability): string | null {
  switch (a) {
    case 'unsupported': return 'Dieser Browser unterstützt keine Push-Benachrichtigungen.';
    case 'insecure': return 'Push-Benachrichtigungen sind nur über eine sichere Verbindung (HTTPS) möglich.';
    case 'denied': return 'Benachrichtigungen sind für diese Seite im Browser blockiert. Erlauben Sie sie in den Website-Einstellungen des Browsers.';
    default: return null;
  }
}

/** VAPID public key (base64url) → the bytes PushManager.subscribe() expects. */
export function urlBase64ToUint8Array(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export interface SubscriptionJson {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
}

/** Body of POST /api/v1/push/subscribe for a browser subscription (null when incomplete). */
export function subscribeBody(sub: SubscriptionJson, showPreview: boolean): Record<string, unknown> | null {
  const { endpoint, keys } = sub;
  if (!endpoint || !keys?.p256dh || !keys.auth) return null;
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, topics: ['mail.new'], showPreview };
}

/**
 * Webmail path a service-worker "open" message asks for, or null for anything
 * else (only same-origin paths below /mail are followed).
 */
export function openMessageTarget(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const m = data as { type?: unknown; url?: unknown };
  if (m.type !== SW_OPEN_MESSAGE_TYPE || typeof m.url !== 'string') return null;
  return /^\/mail(?:[/?#]|$)/.test(m.url) ? m.url : null;
}

/** Folder + message of a /mail?folder=…&message=… deep link (notification click). */
export function mailDeepLinkTarget(params: URLSearchParams): { folderId: string; messageId: string } | null {
  const folderId = params.get('folder');
  const messageId = params.get('message');
  const id = /^[A-Za-z0-9_-]{1,64}$/;
  return folderId && messageId && id.test(folderId) && id.test(messageId) ? { folderId, messageId } : null;
}
