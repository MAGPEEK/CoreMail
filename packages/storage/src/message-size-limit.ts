/**
 * Maximum size of an outgoing message (9.4) — one helper for every submission path:
 * REST /mail/send, JMAP EmailSubmission / Email/import / Email/set create and
 * ActiveSync SendMail / SmartReply / SmartForward (including the appended original).
 *
 * The limit is the stricter of SmtpSettings.maxMessageSizeMb (the SMTP submission
 * limit, BCP → SMTP) and ServerSettings.maxMessageSizeMb (BCP → Settings → Mail), so a
 * message accepted by one client protocol is never refused by another.
 * The SMTP listener uses `maxMessageBytesFrom` with its own setting only (port 25
 * inbound follows the SMTP setting).
 */
import { prisma } from './prisma/index.js';

/** Schema default of both maxMessageSizeMb columns. */
export const DEFAULT_MAX_MESSAGE_MB = 25;

const MB = 1024 * 1024;
const CACHE_TTL_MS = 60_000;

/** Pure: the smallest positive MB value as bytes (default 25 MB when none is set). */
export function maxMessageBytesFrom(valuesMb: ReadonlyArray<number | null | undefined>): number {
  const set = valuesMb.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  const mb = set.length > 0 ? Math.min(...set) : DEFAULT_MAX_MESSAGE_MB;
  return Math.max(1, Math.floor(mb)) * MB;
}

export type MessageSizeCheck = { ok: true } | { ok: false; size: number; limit: number };

/** Pure: is a message of `size` bytes within `limit`? */
export function checkMessageSize(size: number, limit: number): MessageSizeCheck {
  return size <= limit ? { ok: true } : { ok: false, size, limit };
}

let cache: { bytes: number; expires: number } | null = null;

/** Forget the cached limit (tests; settings saves in the same process). */
export function clearMessageSizeLimitCache(): void { cache = null; }

/** Max. size of one outgoing message in bytes (60 s cache; unreadable settings → default). */
export async function maxOutgoingMessageBytes(now: number = Date.now()): Promise<number> {
  if (cache && cache.expires > now) return cache.bytes;
  let bytes = maxMessageBytesFrom([]);
  try {
    const [smtp, server] = await Promise.all([
      prisma.smtpSettings.findUnique({ where: { id: 'singleton' }, select: { maxMessageSizeMb: true } }),
      prisma.serverSettings.findUnique({ where: { id: 'singleton' }, select: { maxMessageSizeMb: true } }),
    ]);
    bytes = maxMessageBytesFrom([smtp?.maxMessageSizeMb, server?.maxMessageSizeMb]);
  } catch {
    /* settings unreadable → default, retried after the TTL */
  }
  cache = { bytes, expires: now + CACHE_TTL_MS };
  return bytes;
}

/** Size check against the configured outgoing limit. */
export async function checkOutgoingMessageSize(size: number): Promise<MessageSizeCheck> {
  return checkMessageSize(size, await maxOutgoingMessageBytes());
}
