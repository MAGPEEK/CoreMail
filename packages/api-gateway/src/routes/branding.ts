/**
 * Public branding endpoints (9.3) — no authentication (the login page needs them).
 *
 *   GET /api/v1/branding           public branding object (Cache-Control: no-cache)
 *   GET /branding/assets/<sha256>.<ext>   uploaded logo / favicon / login background
 *   GET /branding/app-icons/<sha256>-<192|512>.png   9.4: app icons scaled from the favicon
 *   GET /branding/favicons/<sha256>-<64|180>.png     favicon / apple-touch-icon derived
 *                                    from a PNG light logo (no own favicon; lib/branding/favicon.ts)
 *   GET /manifest.webmanifest       9.4: web app manifest of the webmail
 *
 * Assets are content-addressed (immutable cache) and served with nosniff and a
 * sandboxing CSP, so an SVG opened directly can neither run script nor load
 * anything (it was sanitised on upload as well). Bodies are kept in a small
 * LRU keyed by the content hash (lib/branding/asset-cache.ts).
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { BRANDING_ASSET_FILE_RE, isNotFound } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { currentBranding } from '../lib/branding/state.js';
import { EXT_CONTENT_TYPE } from '../lib/branding/image.js';
import { webManifest } from '../lib/branding/manifest.js';
import { APP_ICON_FILE_RE, appIconSha, loadBrandingAsset, renderAppIcon } from '../lib/branding/app-icons.js';
import { PngUnsupportedError } from '../lib/branding/png.js';
import { DERIVED_FAVICON_FILE_RE } from '../lib/branding/favicon.js';
import { renderDerivedFavicon } from '../lib/branding/favicon-render.js';

const log = createLogger('branding');

export const ASSET_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

export const brandingApiRouter: RouterType = Router();

brandingApiRouter.get('/', async (_req: Request, res: Response) => {
  res.set('Cache-Control', 'no-cache');
  res.json(await currentBranding());
});

/** 9.4: GET /manifest.webmanifest — installable webmail, named and coloured by the branding. */
export async function webManifestHandler(_req: Request, res: Response): Promise<void> {
  const branding = await currentBranding();
  res.set('Cache-Control', 'no-cache');
  res.type('application/manifest+json').send(JSON.stringify(webManifest(branding, await appIconSha(branding))));
}

/** Headers of every public branding image (content-addressed → immutable). */
function setImageHeaders(res: Response, contentType: string): void {
  res.set({
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': ASSET_CSP,
    'Content-Disposition': 'inline',
  });
}

export const brandingAssetsRouter: RouterType = Router();

brandingAssetsRouter.get('/:file', async (req: Request, res: Response) => {
  const file = req.params['file'] ?? '';
  if (!BRANDING_ASSET_FILE_RE.test(file)) { res.status(404).json({ error: 'Not found' }); return; }
  let data: Buffer;
  try {
    data = await loadBrandingAsset(file);
  } catch (err) {
    if (isNotFound(err)) { res.status(404).json({ error: 'Not found' }); return; }
    log.warn({ err, file }, 'Branding asset could not be read');
    res.status(503).json({ error: 'Asset temporarily unavailable' });
    return;
  }
  const ext = file.slice(file.lastIndexOf('.') + 1);
  setImageHeaders(res, EXT_CONTENT_TYPE[ext] ?? 'application/octet-stream');
  res.send(data);
});

/** 9.4: app icons scaled from the current favicon (lib/branding/app-icons.ts). */
export const brandingAppIconsRouter: RouterType = Router();

brandingAppIconsRouter.get('/:file', async (req: Request, res: Response) => {
  const file = req.params['file'] ?? '';
  if (!APP_ICON_FILE_RE.test(file)) { res.status(404).json({ error: 'Not found' }); return; }
  let icon: Buffer | null;
  try {
    icon = await renderAppIcon(file, await currentBranding());
  } catch (err) {
    if (isNotFound(err) || err instanceof PngUnsupportedError) { res.status(404).json({ error: 'Not found' }); return; }
    log.warn({ err, file }, 'App icon could not be rendered');
    res.status(503).json({ error: 'Icon temporarily unavailable' });
    return;
  }
  if (!icon) { res.status(404).json({ error: 'Not found' }); return; }
  setImageHeaders(res, 'image/png');
  res.send(icon);
});

/** Favicon / apple-touch-icon derived from the current PNG light logo (lib/branding/favicon.ts). */
export const brandingFaviconsRouter: RouterType = Router();

brandingFaviconsRouter.get('/:file', async (req: Request, res: Response) => {
  const file = req.params['file'] ?? '';
  if (!DERIVED_FAVICON_FILE_RE.test(file)) { res.status(404).json({ error: 'Not found' }); return; }
  let icon: Buffer | null;
  try {
    icon = await renderDerivedFavicon(file, await currentBranding());
  } catch (err) {
    if (isNotFound(err)) { res.status(404).json({ error: 'Not found' }); return; }
    log.warn({ err, file }, 'Favicon could not be derived from the logo');
    res.status(503).json({ error: 'Icon temporarily unavailable' });
    return;
  }
  if (!icon) { res.status(404).json({ error: 'Not found' }); return; }
  setImageHeaders(res, 'image/png');
  res.send(icon);
});
