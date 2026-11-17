/**
 * Branding store + hooks (9.3). KEEP IDENTICAL in web-client and admin-panel.
 *
 * Start value: the JSON the gateway injects into index.html
 * (<script id="cm-branding" type="application/json">), so the first render is
 * already branded; then GET /api/v1/branding (public, no auth) on start, when
 * the window regains focus / becomes visible, and every 10 minutes. The BCP
 * branding page pushes saved values in directly (setBranding).
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import {
  DEFAULT_BRANDING, documentTitle, faviconHref, parseBranding, parseInjectedBrandingText, sameBranding,
  type Branding,
} from '../lib/branding.js';

const ENDPOINT = '/api/v1/branding';
const MIN_REFETCH_MS = 15_000;
const POLL_MS = 10 * 60_000;

function readInjected(): Branding | null {
  if (typeof document === 'undefined') return null;
  return parseInjectedBrandingText(document.getElementById('cm-branding')?.textContent);
}

interface BrandingState {
  branding: Branding;
}

export const useBrandingStore = create<BrandingState>()(() => ({
  branding: readInjected() ?? DEFAULT_BRANDING,
}));

/** Replaces the current branding (no re-render when nothing changed). */
export function setBranding(next: Branding): void {
  if (!sameBranding(useBrandingStore.getState().branding, next)) useBrandingStore.setState({ branding: next });
}

let inflight: Promise<void> | null = null;
let lastFetch = 0;

/** Fetches the public branding; network/HTTP errors keep the current value. */
export function refreshBranding(force = false): Promise<void> {
  if (inflight) return inflight;
  if (!force && Date.now() - lastFetch < MIN_REFETCH_MS) return Promise.resolve();
  lastFetch = Date.now();
  inflight = fetch(ENDPOINT, { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } })
    .then(async (res) => {
      if (!res.ok) return;
      setBranding(parseBranding(await res.json()));
    })
    .catch(() => undefined)
    .finally(() => { inflight = null; });
  return inflight;
}

/** The current branding (productName, colours, assets …). */
export function useBranding(): Branding {
  return useBrandingStore((s) => s.branding);
}

function applyFavicon(href: string): void {
  let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  if (link.getAttribute('href') !== href) {
    // the type of an uploaded favicon may differ from the built-in SVG
    link.removeAttribute('type');
    link.setAttribute('href', href);
  }
}

/**
 * Mount once at the app root: keeps the branding fresh and applies the browser
 * title and the favicon. Colours are applied by the app's ThemeApplier.
 */
export function useBrandingSync(app: 'mwa' | 'bcp'): void {
  const branding = useBranding();

  useEffect(() => {
    void refreshBranding(true);
    const onFocus = () => { void refreshBranding(); };
    const onVisible = () => { if (document.visibilityState === 'visible') void refreshBranding(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(() => { void refreshBranding(); }, POLL_MS);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    document.title = documentTitle(branding.productName, app);
    applyFavicon(faviconHref(branding.assets));
  }, [branding.productName, branding.assets, app]);
}
