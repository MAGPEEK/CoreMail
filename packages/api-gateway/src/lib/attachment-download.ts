/**
 * GET /api/v1/mail/attachments/:id — attachment download for the web client.
 *
 * Access: the attachment's message must live in a mailbox the caller may read —
 * their own, a Shared Mailbox with FULL_ACCESS/READ_ONLY, or a delegated mailbox
 * with FULL_ACCESS/READ_ONLY — and must not be soft-deleted. Anything else is 404
 * (no existence oracle).
 *
 * Response hardening: the content comes from untrusted mail, so it is always sent
 * with `X-Content-Type-Options: nosniff` and a sandboxing CSP. It is only served
 * `inline` for raster image types (the web client embeds cid: images); everything
 * else — in particular text/html and image/svg+xml — is forced to download.
 */
import type { Request, Response } from 'express';

export const READ_PERMISSIONS = ['FULL_ACCESS', 'READ_ONLY'] as const;

/** Prisma `Mailbox` filter: mailboxes `userId` may read. */
export function readableMailboxWhere(userId: string) {
  return {
    OR: [
      { userId },
      { sharedBox: { active: true, permissions: { some: { userId, permission: { in: [...READ_PERMISSIONS] } } } } },
      { delegates: { some: { granteeId: userId, permission: { in: [...READ_PERMISSIONS] } } } },
    ],
  };
}

/** Raster image types that may be rendered inline (no script, no SVG). */
export const INLINE_SAFE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif']);

/** A syntactically valid, lower-cased media type, or application/octet-stream. */
export function safeContentType(mimeType: string | null | undefined): string {
  const t = (mimeType ?? '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(t) ? t : 'application/octet-stream';
}

/**
 * RFC 6266 Content-Disposition with an ASCII fallback `filename` and the full name
 * as RFC 5987 `filename*`. Control characters, quotes and path separators are removed.
 */
export function contentDisposition(type: 'inline' | 'attachment', filename: string | null | undefined): string {
  // eslint-disable-next-line no-control-regex
  const clean = (filename ?? '').replace(/[\u0000-\u001f\u007f-\u009f"\\/]/g, '').trim() || 'attachment';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_').replace(/[%;]/g, '_');
  const encoded = encodeURIComponent(clean).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export interface DownloadableAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  storagePath: string;
}

export interface AttachmentDownloadDeps {
  /** The attachment if `userId` may read it, else null. */
  findAttachment(id: string, userId: string): Promise<DownloadableAttachment | null>;
  openStream(storagePath: string): Promise<NodeJS.ReadableStream>;
  warn?(msg: string, err: unknown): void;
}

export function createAttachmentDownloadHandler(deps: AttachmentDownloadDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const userId = req.apiUser?.userId;
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
    const id = String(req.params['id'] ?? '');
    const att = id ? await deps.findAttachment(id, userId) : null;
    if (!att || !att.storagePath) { res.status(404).json({ error: 'Attachment not found' }); return; }

    let stream: NodeJS.ReadableStream;
    try {
      stream = await deps.openStream(att.storagePath);
    } catch (err) {
      deps.warn?.('attachment object not readable', err);
      res.status(404).json({ error: 'Attachment content not available' });
      return;
    }

    const contentType = safeContentType(att.mimeType);
    const wantsInline = req.query['disposition'] === 'inline' || req.query['inline'] === '1';
    const inline = wantsInline && INLINE_SAFE_TYPES.has(contentType);
    res.status(200);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', att.filename));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

    stream.on('error', (err) => {
      deps.warn?.('attachment stream failed', err);
      res.destroy(err instanceof Error ? err : new Error(String(err)));
    });
    stream.pipe(res);
  };
}
