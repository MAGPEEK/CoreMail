/**
 * Sends a stored profile photo (9.5) — shared by GET /api/v1/users/:id/photo and
 * the admin view. Strong ETag = the photo's content hash; `private, no-cache`
 * lets the browser keep the photo but revalidate it (304) on every use, so a
 * changed or removed photo shows up at once. Served like the branding assets:
 * nosniff and a sandboxing CSP.
 */
import type { Request, Response } from 'express';
import { createLogger } from '@coremail/core';
import { loadProfilePhoto, profilePhotoEtag, isNotFound, PROFILE_PHOTO_CONTENT_TYPE } from '@coremail/storage';
import { ASSET_CSP } from '../../routes/branding.js';

const log = createLogger('profile-photo');

export async function sendPhoto(req: Request, res: Response, key: string | null): Promise<void> {
  const etag = profilePhotoEtag(key);
  if (!key || !etag) { res.status(404).json({ error: 'Not found' }); return; }
  res.set({
    ETag: etag,
    'Cache-Control': 'private, no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': ASSET_CSP,
    'Content-Disposition': 'inline',
  });
  if (req.fresh) { res.status(304).end(); return; }
  let data: Buffer;
  try {
    data = await loadProfilePhoto(key);
  } catch (err) {
    if (isNotFound(err)) { res.status(404).json({ error: 'Not found' }); return; }
    log.warn({ err, key }, 'Profile photo could not be read');
    res.status(503).json({ error: 'Photo temporarily unavailable' });
    return;
  }
  res.type(PROFILE_PHOTO_CONTENT_TYPE).send(data);
}
