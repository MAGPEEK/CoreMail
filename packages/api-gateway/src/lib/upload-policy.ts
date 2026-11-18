/**
 * 9.4 webmail policy: max. size of one uploaded attachment (compose / drafts).
 * Runs after multer; the message size limit (lib/send-limits.ts) still caps
 * the whole request. Over the limit → 413 ATTACHMENT_TOO_LARGE.
 */
import type { Request, Response, NextFunction } from 'express';
import { effectiveWebmailPolicy, maxUploadBytes } from '@coremail/storage';
import { protocolSubject } from '../middleware/auth.js';

interface UploadedFile { originalname: string; size: number }

/** The first file over `maxBytes` (pure; null = all fit or no limit). */
export function oversizedUpload(files: readonly UploadedFile[], maxBytes: number | null): UploadedFile | null {
  if (maxBytes === null) return null;
  return files.find((f) => f.size > maxBytes) ?? null;
}

function uploadedFiles(req: Request): UploadedFile[] {
  const files = (req as Request & { files?: unknown }).files;
  return Array.isArray(files) ? files as UploadedFile[] : [];
}

export function enforceUploadPolicy(req: Request, res: Response, next: NextFunction): void {
  const files = uploadedFiles(req);
  if (files.length === 0 || !req.apiUser) { next(); return; }
  effectiveWebmailPolicy(protocolSubject(req.apiUser)).then((policy) => {
    const max = maxUploadBytes(policy.content);
    const tooLarge = oversizedUpload(files, max);
    if (!tooLarge) { next(); return; }
    res.status(413).json({
      error: 'Anhang zu groß', code: 'ATTACHMENT_TOO_LARGE', maxBytes: max, filename: tooLarge.originalname,
    });
  }, next);
}
