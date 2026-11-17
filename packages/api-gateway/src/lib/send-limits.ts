/**
 * Limits for POST /api/v1/mail/send (8.0.x).
 *
 *  - request size: at most the configured max. message size (storage
 *    message-size-limit.ts, shared with JMAP and ActiveSync), enforced on Content-Length AND on the
 *    bytes actually streamed (chunked uploads), so multer's memory storage
 *    never holds more than one message worth of data per request
 *  - recipients: at most MAIL_SEND_MAX_RECIPIENTS (default 500) in to+cc+bcc,
 *    each a syntactically valid address (`a@b.c` or `Name <a@b.c>`), no CR/LF
 */
import type { Request, Response, NextFunction } from 'express';
import { maxOutgoingMessageBytes } from '@coremail/storage';
import { envInt } from './user-rate-limit.js';

/** Attachments per message (was 20). */
export const MAX_SEND_FILES = 10;

/** Max. size of one outgoing message in bytes — the shared storage helper (9.4, 60 s cache). */
export const maxMessageBytes = (): Promise<number> => maxOutgoingMessageBytes();

export class BodyTooLargeError extends Error {
  readonly code = 'BODY_TOO_LARGE';
  constructor(readonly limit: number) { super('Request body too large'); this.name = 'BodyTooLargeError'; }
}

/**
 * Rejects a request whose Content-Length exceeds `limit` (returns false after
 * answering 413) and otherwise counts streamed bytes: once `limit` is
 * exceeded the request emits a BodyTooLargeError, which makes multer stop
 * parsing, drop the buffered files and call back with that error.
 * Must be called in the same tick in which the body consumer is attached.
 */
export function guardBodySize(req: Request, res: Response, limit: number): boolean {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    res.setHeader('Connection', 'close');
    res.status(413).json({ error: 'Message too large', maxBytes: limit });
    return false;
  }
  let seen = 0;
  let tripped = false;
  req.on('data', (chunk: Buffer) => {
    seen += chunk.length;
    if (!tripped && seen > limit) {
      tripped = true;
      // multer listens for 'error'; without a consumer, stop reading instead
      // (an 'error' event without listener would throw)
      if (req.listenerCount('error') > 0) req.emit('error', new BodyTooLargeError(limit));
      else req.destroy();
    }
  });
  return true;
}

type BodyConsumer = (req: Request, res: Response, cb: (err?: unknown) => void) => void;

/** Express wrapper: size guard, then the consumer built for that limit (multer) in the same tick. */
export function withBodyLimit(makeConsumer: (limitBytes: number) => BodyConsumer, getLimit: () => Promise<number> = maxMessageBytes) {
  return (req: Request, res: Response, next: NextFunction): void => {
    getLimit().then((limit) => {
      if (!guardBodySize(req, res, limit)) return;
      makeConsumer(limit)(req, res, (err?: unknown) => {
        if (!err) { next(); return; }
        if (err instanceof BodyTooLargeError || (err as { code?: string }).code === 'LIMIT_FILE_SIZE') {
          res.setHeader('Connection', 'close');
          res.status(413).json({ error: 'Message too large', maxBytes: limit });
          return;
        }
        const code = (err as { code?: string }).code;
        res.status(400).json({ error: typeof code === 'string' ? `Upload error: ${code}` : 'Upload error' });
      });
    }, next);
  };
}

// ── Recipients ───────────────────────────────────────────────────────────────

const ADDR = /^[^\s@<>()[\]\\,;:"]{1,64}@(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+[\p{L}\p{N}][\p{L}\p{N}-]{0,62}$/u;

/** Bare address of `a@b.c` / `Name <a@b.c>`, or null when invalid. */
export function recipientAddress(raw: string): string | null {
  const s = raw.trim();
  if (!s || s.length > 320 || /[\r\n\0]/.test(s)) return null;
  const m = /^(.*)<([^<>]+)>$/.exec(s);
  const addr = (m ? m[2]! : s).trim();
  if (addr.length > 254 || !ADDR.test(addr)) return null;
  return addr;
}

export function maxRecipients(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(1, envInt('MAIL_SEND_MAX_RECIPIENTS', 500, env));
}

export type RecipientCheck = { ok: true } | { ok: false; error: string; invalid?: string[] };

export function checkRecipients(lists: string[][], max = maxRecipients()): RecipientCheck {
  const all = lists.flat();
  if (all.length > max) return { ok: false, error: `Too many recipients (max. ${max})` };
  const invalid = all.filter((a) => recipientAddress(a) === null);
  if (invalid.length) return { ok: false, error: 'Invalid recipient address', invalid: invalid.slice(0, 10).map((a) => a.slice(0, 100)) };
  return { ok: true };
}
