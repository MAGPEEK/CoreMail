/**
 * 9.4 Web Push + service worker of the webmail (pure parts: lib/webPush.ts).
 *
 *   registerServiceWorker()       once at start-up (main.tsx): /sw.js, no caching
 *   useServiceWorkerNavigation()  a notification click routes an open window
 *   useWebPush()                  opt-in state for Settings → Benachrichtigungen
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, apiFetch } from '../api/client.js';
import {
  openMessageTarget, pushAvailability, subscribeBody, urlBase64ToUint8Array, type PushAvailability,
} from '../lib/webPush.js';

const SW_URL = '/sw.js';

function hasServiceWorker(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

/** Registers the service worker (installable app, Web Push). Failures are not fatal. */
export function registerServiceWorker(): void {
  if (!hasServiceWorker() || !window.isSecureContext) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(SW_URL).catch(() => undefined);
  }, { once: true });
}

/** A click on a new-mail notification opens the message in this window. */
export function useServiceWorkerNavigation(): void {
  const navigate = useNavigate();
  useEffect(() => {
    if (!hasServiceWorker()) return;
    const onMessage = (ev: MessageEvent) => {
      const target = openMessageTarget(ev.data);
      if (target) navigate(target);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [navigate]);
}

function currentAvailability(): PushAvailability {
  const notification = typeof Notification !== 'undefined';
  return pushAvailability({
    serviceWorker: hasServiceWorker(),
    pushManager: typeof window !== 'undefined' && 'PushManager' in window,
    notification,
    secureContext: typeof window !== 'undefined' && window.isSecureContext,
    permission: notification ? Notification.permission : 'default',
  });
}

async function browserSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration(SW_URL) ?? await navigator.serviceWorker.register(SW_URL);
  return reg.pushManager.getSubscription();
}

async function vapidKey(): Promise<string> {
  const res = await apiFetch('/api/v1/push/vapid-public-key');
  if (res.status === 503) throw new Error('Der Server ist nicht für Push-Benachrichtigungen eingerichtet.');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { publicKey } = await res.json() as { publicKey?: unknown };
  if (typeof publicKey !== 'string' || !publicKey) throw new Error('Der Server ist nicht für Push-Benachrichtigungen eingerichtet.');
  return publicKey;
}

async function register(sub: PushSubscription, showPreview: boolean): Promise<void> {
  const body = subscribeBody(sub.toJSON(), showPreview);
  if (!body) throw new Error('Das Abonnement des Browsers ist unvollständig.');
  await api.post('/push/subscribe', body);
}

export interface WebPushState {
  availability: PushAvailability;
  /** null while the browser state is being read. */
  enabled: boolean | null;
  showPreview: boolean;
  busy: boolean;
  enable(): Promise<void>;
  disable(): Promise<void>;
  setShowPreview(value: boolean): Promise<void>;
}

/** Push opt-in of THIS browser (the subscription belongs to the device). */
export function useWebPush(): WebPushState {
  const [availability, setAvailability] = useState<PushAvailability>(currentAvailability);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [showPreview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (availability === 'unsupported' || availability === 'insecure') { setEnabled(false); return; }
    let alive = true;
    void (async () => {
      const sub = await browserSubscription().catch(() => null);
      if (!alive) return;
      setEnabled(!!sub);
      if (!sub) return;
      const rows = await api.get<Array<{ endpoint: string; showPreview?: boolean }>>('/push/subscriptions').catch(() => []);
      if (alive) setPreview(!!rows.find((r) => r.endpoint === sub.endpoint)?.showPreview);
    })();
    return () => { alive = false; };
  }, [availability]);

  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); setAvailability(currentAvailability()); }
  }, []);

  const enable = useCallback(() => run(async () => {
    if (await Notification.requestPermission() !== 'granted') return;
    const reg = await navigator.serviceWorker.register(SW_URL);
    await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription()
      ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(await vapidKey()) });
    await register(sub, showPreview);
    setEnabled(true);
  }), [run, showPreview]);

  const disable = useCallback(() => run(async () => {
    const sub = await browserSubscription();
    if (sub) {
      await api.post('/push/unsubscribe', { endpoint: sub.endpoint });
      await sub.unsubscribe();
    }
    setEnabled(false);
  }), [run]);

  const setShowPreview = useCallback((value: boolean) => run(async () => {
    const sub = await browserSubscription();
    if (sub) await register(sub, value);
    setPreview(value);
  }), [run]);

  return { availability, enabled, showPreview, busy, enable, disable, setShowPreview };
}
