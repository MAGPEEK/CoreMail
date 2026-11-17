/**
 * Public branding endpoints (9.3) — no authentication (the login page needs them).
 *
 *   GET /api/v1/branding           public branding object (Cache-Control: no-cache)
 *   GET /branding/assets/<sha256>.<ext>   uploaded logo / favicon / login background
 *
 * Assets are content-addressed (immutable cache) and served with nosniff and a
 * sandboxing CSP, so an SVG opened directly can neither run script nor load
 * anything (it was sanitised on upload as well). Bodies are kept in a small
 * LRU keyed by the content hash (lib/branding/asset-cache.ts).
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { BRANDING_ASSET_FILE_RE, BRANDING_KEY_PREFIX, getObjectStore, isNotFound } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { currentBranding } from '../lib/branding/state.js';
import { EXT_CONTENT_TYPE } from '../lib/branding/image.js';
import { brandingAssetCache } from '../lib/branding/asset-cache.js';

const log = createLogger('branding');

export const ASSET_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

export const brandingApiRouter: RouterType = Router();

brandingApiRouter.get('/', async (_req: Request, res: Response) => {
  res.set('Cache-Control', 'no-cache');
  res.json(await currentBranding());
});

export const brandingAssetsRouter: RouterType = Router();

brandingAssetsRouter.get('/:file', async (req: Request, res: Response) => {
  const file = req.params['file'] ?? '';
  if (!BRANDING_ASSET_FILE_RE.test(file)) { res.status(404).json({ error: 'Not found' }); return; }
  let data = brandingAssetCache.get(file);
  if (!data) {
    try {
      data = await getObjectStore().get(`${BRANDING_KEY_PREFIX}${file}`);
    } catch (err) {
      if (isNotFound(err)) { res.status(404).json({ error: 'Not found' }); return; }
      log.warn({ err, file }, 'Branding asset could not be read');
      res.status(503).json({ error: 'Asset temporarily unavailable' });
      return;
    }
    brandingAssetCache.set(file, data);
  }
  const ext = file.slice(file.lastIndexOf('.') + 1);
  res.set({
    'Content-Type': EXT_CONTENT_TYPE[ext] ?? 'application/octet-stream',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': ASSET_CSP,
    'Content-Disposition': 'inline',
  });
  res.send(data);
});
