/**
 * Profile photos (9.5) — see docs/user-settings.md.
 *
 * Own photo (/api/v1/user/photo, webmail module `profilePhoto` for PUT):
 *   PUT    /api/v1/user/photo      raw PNG/JPEG body, or multipart field `photo`
 *                                  (max. 5 MB) → decoded, centre-cropped, re-encoded
 *                                  as a 512×512 JPEG without metadata
 *                                  → { photo: { userId, version, updatedAt } }
 *   DELETE /api/v1/user/photo      → { removed } (allowed while the module is off:
 *                                  removing the own photo is always possible)
 * Directory (/api/v1/users):
 *   POST   /api/v1/users/photos/lookup   { addresses: string[] } (max. 100)
 *                                  → { photos: { <address>: { userId, version } } }
 *   GET    /api/v1/users/:id/photo  image/jpeg, strong ETag (If-None-Match → 304),
 *                                  Cache-Control private, no-cache; 404 when there is
 *                                  none or the caller may not see it
 *                                  (lib/profile-photo/directory.ts).
 *
 * Errors of an upload: 413 SIZE, 415 TYPE / UNSUPPORTED, 422 DIMENSIONS / CORRUPT
 * (`{ error, code }`), 429 RATE_LIMITED. The own change announces the user event
 * `settings` / `profile`; other users pick a new photo up through the version in
 * the lookup and the ETag.
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { createLogger } from '@coremail/core';
import { saveProfilePhoto, removeProfilePhoto, profilePhotoInfo } from '@coremail/storage';
import { requireAuth } from '../middleware/auth.js';
import { announceOnWrite } from '../lib/realtime.js';
import { createUserRateLimiter, envInt } from '../lib/user-rate-limit.js';
import { processProfilePhoto, PhotoError, PHOTO_ERROR_STATUS, MAX_PHOTO_BYTES } from '../lib/profile-photo/image.js';
import { lookupAddresses, lookupPhotos, visiblePhotoKey, MAX_LOOKUP_ADDRESSES } from '../lib/profile-photo/directory.js';
import { sendPhoto } from '../lib/profile-photo/serve.js';
import { imageUploadBody } from '../lib/profile-photo/upload-body.js';

const log = createLogger('profile-photo');

/** Per-user upload limit (decoding is CPU work): default 20 uploads / 10 min, 0 disables. */
export const photoUploadRateLimiter = createUserRateLimiter({
  scope: 'profile-photo',
  limit: envInt('PROFILE_PHOTO_UPLOAD_LIMIT', 20),
  windowSec: Math.max(1, envInt('PROFILE_PHOTO_UPLOAD_WINDOW_SEC', 600)),
});

/** Reads the upload (raw body or multipart field `photo`) into `req.body` as a Buffer. */
const photoBody = imageUploadBody({
  maxBytes: MAX_PHOTO_BYTES, field: 'photo', tooLargeMessage: `Foto darf höchstens ${MAX_PHOTO_BYTES / 1024 / 1024} MB groß sein`,
});

// ── Own photo ─────────────────────────────────────────────────────────────────

export const ownPhotoRouter: RouterType = Router();
ownPhotoRouter.use(requireAuth);
ownPhotoRouter.use(announceOnWrite({ type: 'settings', section: 'profile' }));

ownPhotoRouter.put('/', photoUploadRateLimiter.middleware, photoBody, async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;
  let jpeg: Buffer;
  try {
    jpeg = processProfilePhoto(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
  } catch (err) {
    if (err instanceof PhotoError) { res.status(PHOTO_ERROR_STATUS[err.code]).json({ error: err.message, code: err.code }); return; }
    throw err;
  }
  const saved = await saveProfilePhoto(userId, jpeg);
  if (!saved) { res.status(404).json({ error: 'User not found' }); return; }
  log.info({ userId, version: saved.version }, 'Profile photo updated');
  res.json({ photo: profilePhotoInfo(userId, saved.key, saved.updatedAt) });
});

ownPhotoRouter.delete('/', async (req: Request, res: Response) => {
  const removed = await removeProfilePhoto(req.apiUser!.userId);
  res.json({ removed });
});

// ── Directory ─────────────────────────────────────────────────────────────────

export const usersPhotoRouter: RouterType = Router();
usersPhotoRouter.use(requireAuth);

usersPhotoRouter.post('/photos/lookup', async (req: Request, res: Response) => {
  const addresses = lookupAddresses((req.body as { addresses?: unknown } | undefined)?.addresses);
  if (!addresses) {
    res.status(400).json({ error: `addresses: list of at most ${MAX_LOOKUP_ADDRESSES} addresses expected` });
    return;
  }
  res.json({ photos: await lookupPhotos(req.apiUser!, addresses) });
});

usersPhotoRouter.get('/:id/photo', async (req: Request, res: Response) => {
  await sendPhoto(req, res, await visiblePhotoKey(req.apiUser!, req.params['id'] ?? ''));
});
