/**
 * Own webmail background (10.1) — Einstellungen → Darstellung → Hintergrund →
 * "Eigenes Bild hochladen…". Only the signed-in user ever reads or changes it;
 * there is no route that takes another user's id. See docs/user-settings.md.
 *
 *   GET    /api/v1/user/background/info  → { background: { version, updatedAt } | null }
 *   GET    /api/v1/user/background       image/jpeg, strong ETag (If-None-Match → 304),
 *                                         Cache-Control private, no-cache; 404 without one
 *   PUT    /api/v1/user/background       raw PNG/JPEG body, or multipart field `background`
 *                                         (max. 5 MB) → decoded, scaled to at most 2560 px,
 *                                         re-encoded as JPEG without metadata
 *                                         → { background: { version, updatedAt } }
 *   DELETE /api/v1/user/background       → { removed }
 *
 * Which background is shown (none / built-in / the uploaded one) is the roaming
 * preference `appearance.background`. Upload errors: 413 SIZE, 415 TYPE /
 * UNSUPPORTED, 422 DIMENSIONS / CORRUPT (`{ error, code }`), 429 RATE_LIMITED.
 * A change announces the user event `settings` / `preferences` (other tabs reload).
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { createLogger } from '@coremail/core';
import { prisma, saveUserBackground, removeUserBackground, userBackgroundInfo } from '@coremail/storage';
import { requireAuth } from '../middleware/auth.js';
import { announceOnWrite } from '../lib/realtime.js';
import { createUserRateLimiter, envInt } from '../lib/user-rate-limit.js';
import { processBackgroundImage, PhotoError, PHOTO_ERROR_STATUS, MAX_BACKGROUND_BYTES } from '../lib/profile-photo/image.js';
import { sendStoredImage, USER_BACKGROUND_IMAGE } from '../lib/profile-photo/serve.js';
import { imageUploadBody } from '../lib/profile-photo/upload-body.js';

const log = createLogger('user-background');

/** Per-user upload limit (decoding is CPU work): default 10 uploads / 10 min, 0 disables. */
export const backgroundUploadRateLimiter = createUserRateLimiter({
  scope: 'user-background',
  limit: envInt('USER_BACKGROUND_UPLOAD_LIMIT', 10),
  windowSec: Math.max(1, envInt('USER_BACKGROUND_UPLOAD_WINDOW_SEC', 600)),
});

const backgroundBody = imageUploadBody({
  maxBytes: MAX_BACKGROUND_BYTES,
  field: 'background',
  tooLargeMessage: `Bild darf höchstens ${MAX_BACKGROUND_BYTES / 1024 / 1024} MB groß sein`,
});

async function ownBackground(userId: string): Promise<{ key: string | null; updatedAt: Date | null }> {
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { backgroundKey: true, backgroundUpdatedAt: true } });
  return { key: row?.backgroundKey ?? null, updatedAt: row?.backgroundUpdatedAt ?? null };
}

export const userBackgroundRouter: RouterType = Router();
userBackgroundRouter.use(requireAuth);
userBackgroundRouter.use(announceOnWrite({ type: 'settings', section: 'preferences' }));

userBackgroundRouter.get('/info', async (req: Request, res: Response) => {
  const own = await ownBackground(req.apiUser!.userId);
  res.set('Cache-Control', 'no-store');
  res.json({ background: userBackgroundInfo(own.key, own.updatedAt) });
});

userBackgroundRouter.get('/', async (req: Request, res: Response) => {
  await sendStoredImage(req, res, (await ownBackground(req.apiUser!.userId)).key, USER_BACKGROUND_IMAGE);
});

userBackgroundRouter.put('/', backgroundUploadRateLimiter.middleware, backgroundBody, async (req: Request, res: Response) => {
  const userId = req.apiUser!.userId;
  let jpeg: Buffer;
  try {
    jpeg = processBackgroundImage(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
  } catch (err) {
    if (err instanceof PhotoError) { res.status(PHOTO_ERROR_STATUS[err.code]).json({ error: err.message, code: err.code }); return; }
    throw err;
  }
  const saved = await saveUserBackground(userId, jpeg);
  if (!saved) { res.status(404).json({ error: 'User not found' }); return; }
  log.info({ userId, version: saved.version }, 'Webmail background updated');
  res.json({ background: userBackgroundInfo(saved.key, saved.updatedAt) });
});

userBackgroundRouter.delete('/', async (req: Request, res: Response) => {
  res.json({ removed: await removeUserBackground(req.apiUser!.userId) });
});
