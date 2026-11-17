/**
 * Branding state of this api-gateway process (9.3).
 *
 *  - `currentBranding()`: the public branding object, cached for 30 s (safety
 *    net) and dropped on `CHANNEL_SETTINGS_RELOAD` `{type:'branding'}` — published
 *    by the admin routes of ANY gateway instance — or on a local change.
 *  - `brandedIndexHtml(file)`: the injected index.html, cached per template
 *    (path + mtime) and branding version.
 *  - Both caches and the asset LRU (asset-cache.ts) are dropped on every change.
 * Database errors keep the last known branding (else the environment defaults).
 */
import { stat, readFile } from 'node:fs/promises';
import { getBranding, loadBrandingRow, toPublicBranding, type PublicBranding } from '@coremail/storage';
import { createLogger, getRedisClient, CHANNEL_SETTINGS_RELOAD } from '@coremail/core';
import { renderBrandedIndex } from './html.js';
import { brandingAssetCache } from './asset-cache.js';

const log = createLogger('branding');
const TTL_MS = 30_000;

let current: { value: PublicBranding; expires: number } | null = null;
let lastGood: PublicBranding | null = null;
const htmlCache = new Map<string, string>();
const templateCache = new Map<string, { mtimeMs: number; text: string }>();

export async function currentBranding(now = Date.now()): Promise<PublicBranding> {
  if (current && current.expires > now) return current.value;
  try {
    const value = toPublicBranding(await loadBrandingRow());
    current = { value, expires: now + TTL_MS };
    lastGood = value;
    return value;
  } catch (err) {
    log.warn({ err }, 'Branding could not be read — using the last known value');
    return lastGood ?? (await getBranding());
  }
}

/** Forget the cached branding (next request reads the database). */
export function invalidateBranding(): void {
  current = null;
  htmlCache.clear();
  brandingAssetCache.clear();
}

/** Local update after an admin change (this instance serves the new value at once). */
export function setCurrentBranding(value: PublicBranding): void {
  current = { value, expires: Date.now() + TTL_MS };
  lastGood = value;
  htmlCache.clear();
  brandingAssetCache.clear();
}

/** Branded index.html for the SPA bundle file, or null when the file does not exist. */
export async function brandedIndexHtml(file: string): Promise<string | null> {
  let st;
  try { st = await stat(file); } catch { return null; }
  let tpl = templateCache.get(file);
  if (!tpl || tpl.mtimeMs !== st.mtimeMs) {
    tpl = { mtimeMs: st.mtimeMs, text: await readFile(file, 'utf8') };
    templateCache.set(file, tpl);
  }
  const b = await currentBranding();
  const key = `${file}|${tpl.mtimeMs}|${b.version}`;
  const hit = htmlCache.get(key);
  if (hit !== undefined) return hit;
  const html = renderBrandedIndex(tpl.text, b);
  if (htmlCache.size > 32) htmlCache.clear();
  htmlCache.set(key, html);
  return html;
}

/** True for a CHANNEL_SETTINGS_RELOAD payload that concerns branding. */
export function isBrandingReload(message: string): boolean {
  try {
    return (JSON.parse(message) as { type?: unknown })?.type === 'branding';
  } catch {
    return false;
  }
}

/** Publishes the branding change to every gateway instance (best effort). */
export function publishBrandingReload(): void {
  // Test seam: tests record the payload instead of talking to Redis.
  const seam = (globalThis as { __brandingPublish?: (channel: string, message: string) => void }).__brandingPublish;
  if (seam) { seam(CHANNEL_SETTINGS_RELOAD, JSON.stringify({ type: 'branding' })); return; }
  try {
    void getRedisClient().publish(CHANNEL_SETTINGS_RELOAD, JSON.stringify({ type: 'branding' })).catch(() => undefined);
  } catch { /* Redis unavailable — the 30 s TTL still applies */ }
}

let subscribed = false;

/** Subscribes to CHANNEL_SETTINGS_RELOAD (idempotent). Call once at startup. */
export function startBrandingSubscriber(): void {
  if (subscribed) return;
  subscribed = true;
  try {
    const sub = getRedisClient().duplicate();
    sub.on('error', (err) => log.warn({ err }, 'Branding subscriber error'));
    sub.on('message', (_channel: string, message: string) => {
      if (isBrandingReload(message)) invalidateBranding();
    });
    void sub.subscribe(CHANNEL_SETTINGS_RELOAD).catch((err: unknown) => log.warn({ err }, 'Branding subscribe failed'));
  } catch (err) {
    log.warn({ err }, 'Branding subscriber not started — the 30 s cache TTL applies');
  }
}
