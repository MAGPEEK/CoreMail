/**
 * Body parser of image uploads (profile photo 9.5, webmail background 10.1):
 * the raw request body or one multipart file field, read into `req.body` as a
 * Buffer, at most `maxBytes`. A larger upload ends with 413 `{ code: 'SIZE' }`
 * (and `Connection: close`) before more is read.
 */
import express, { type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import multer from 'multer';

export interface ImageUploadOptions {
  maxBytes: number;
  /** Multipart field name. */
  field: string;
  /** German message of the 413 answer. */
  tooLargeMessage: string;
}

export function imageUploadBody({ maxBytes, field, tooLargeMessage }: ImageUploadOptions): RequestHandler {
  const tooLarge = (res: Response): void => {
    res.setHeader('Connection', 'close');
    res.status(413).json({ error: tooLargeMessage, code: 'SIZE' });
  };
  const rawBody = express.raw({ type: () => true, limit: maxBytes });
  const multipartBody = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 5, parts: 6 },
  }).single(field);

  return (req: Request, res: Response, next: NextFunction): void => {
    const declared = Number(req.get('content-length') ?? 'NaN');
    // multipart framing adds a little; the file itself is checked by multer
    if (Number.isFinite(declared) && declared > maxBytes + 64 * 1024) { tooLarge(res); return; }
    const multipart = /^multipart\/form-data/i.test(req.get('content-type') ?? '');
    const parse = multipart ? multipartBody : rawBody;
    parse(req, res, (err?: unknown) => {
      if (err) {
        const e = err as { type?: string; code?: string };
        if (e.type === 'entity.too.large' || e.code === 'LIMIT_FILE_SIZE') { tooLarge(res); return; }
        res.status(400).json({ error: 'Upload fehlgeschlagen', code: 'TYPE' });
        return;
      }
      if (multipart) req.body = (req as Request & { file?: { buffer: Buffer } }).file?.buffer ?? Buffer.alloc(0);
      next();
    });
  };
}
