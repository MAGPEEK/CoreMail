/**
 * Sends a stored per-user image — the profile photo (9.5, GET /api/v1/users/:id/photo
 * and the admin view) and the own webmail background (10.1). Strong ETag = the
 * image's content hash; `private, no-cache` lets the browser keep the image but
 * revalidate it (304) on every use, so a changed or removed image shows up at
 * once. Served like the branding assets: nosniff and a sandboxing CSP.
 */
import type { Request, Response } from 'express';
import { createLogger } from '@coremail/core';
import {
  loadProfilePhoto, profilePhotoEtag, isNotFound, PROFILE_PHOTO_CONTENT_TYPE,
  loadUserBackground, userBackgroundEtag, USER_BACKGROUND_CONTENT_TYPE,
} from '@coremail/storage';
import { ASSET_CSP } from '../../routes/branding.js';

const log = createLogger('user-image');

/** How one kind of stored image is addressed. */
export interface StoredImageKind {
  etag: (key: string | null | undefined) => string | null;
  load: (key: string) => Promise<Buffer>;
  contentType: string;
  label: string;
}

export const PROFILE_PHOTO_IMAGE: StoredImageKind = {
  etag: profilePhotoEtag, load: loadProfilePhoto, contentType: PROFILE_PHOTO_CONTENT_TYPE, label: 'Photo',
};
export const USER_BACKGROUND_IMAGE: StoredImageKind = {
  etag: userBackgroundEtag, load: loadUserBackground, contentType: USER_BACKGROUND_CONTENT_TYPE, label: 'Background',
};

export async function sendStoredImage(req: Request, res: Response, key: string | null, kind: StoredImageKind): Promise<void> {
  const etag = kind.etag(key);
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
    data = await kind.load(key);
  } catch (err) {
    if (isNotFound(err)) { res.status(404).json({ error: 'Not found' }); return; }
    log.warn({ err, key }, `${kind.label} could not be read`);
    res.status(503).json({ error: `${kind.label} temporarily unavailable` });
    return;
  }
  res.type(kind.contentType).send(data);
}

export async function sendPhoto(req: Request, res: Response, key: string | null): Promise<void> {
  await sendStoredImage(req, res, key, PROFILE_PHOTO_IMAGE);
}
