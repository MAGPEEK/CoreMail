/**
 * Limits of a message a client submits for sending (9.4) — ONE helper for every
 * client submission path: REST /mail/send, JMAP EmailSubmission / Email/import /
 * Email/set create, ActiveSync SendMail / SmartReply / SmartForward and MAPI
 * RopSubmitMessage.
 *
 * Global limits (BCP):
 *  - size: the stricter of SmtpSettings.maxMessageSizeMb (the SMTP submission
 *    limit, BCP → SMTP) and ServerSettings.maxMessageSizeMb (BCP → Settings →
 *    Mail), so a message accepted by one client protocol is never refused by
 *    another. The SMTP listener uses `maxMessageBytesFrom` with its own setting
 *    only (port 25 inbound follows the SMTP setting);
 *  - recipients: SmtpSettings.maxRecipients (the SMTP RCPT TO limit).
 * Per mailbox: a user's MailFlowPolicy maxSendSizeMb / maxRecipients replace the
 * global value (mail-flow.ts `effectiveSendLimits`).
 *
 * Read with a 60 s cache (cleared on CHANNEL_SETTINGS_RELOAD by the services);
 * schema defaults when the settings are unreadable.
 */
import { prisma } from './prisma/index.js';
import { checkSendLimitsPure, effectiveSendLimits, loadMailFlowPolicy, type SendLimits, type SendLimitVerdict } from './mail-flow.js';
import { clearSendRateSettingsCache } from './submission-rate.js';

/** Global limits of a submitted message. */
export interface SubmissionLimits {
  maxMessageBytes: number;
  maxRecipients: number;
}

/** Schema default of both maxMessageSizeMb columns. */
export const DEFAULT_MAX_MESSAGE_MB = 25;
/** Schema default of SmtpSettings.maxRecipients. */
export const DEFAULT_MAX_RECIPIENTS = 100;

const CACHE_MS = 60_000;
const MB = 1024 * 1024;

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Pure: the smallest positive MB value as bytes (default 25 MB when none is set). */
export function maxMessageBytesFrom(valuesMb: ReadonlyArray<number | null | undefined>): number {
  const set = valuesMb.filter(positive);
  const mb = set.length > 0 ? Math.min(...set) : DEFAULT_MAX_MESSAGE_MB;
  return Math.max(1, Math.floor(mb)) * MB;
}

export type MessageSizeCheck = { ok: true } | { ok: false; size: number; limit: number };

/** Pure: is a message of `size` bytes within `limit`? */
export function checkMessageSize(size: number, limit: number): MessageSizeCheck {
  return size <= limit ? { ok: true } : { ok: false, size, limit };
}

/** Pure: the global limits from the two settings rows (either may be missing). */
export function submissionLimitsFrom(
  smtp: { maxMessageSizeMb?: number | null; maxRecipients?: number | null } | null,
  server: { maxMessageSizeMb?: number | null } | null,
): SubmissionLimits {
  return {
    maxMessageBytes: maxMessageBytesFrom([smtp?.maxMessageSizeMb, server?.maxMessageSizeMb]),
    maxRecipients: positive(smtp?.maxRecipients) ? Math.floor(smtp.maxRecipients) : DEFAULT_MAX_RECIPIENTS,
  };
}

let cache: { limits: SubmissionLimits; expires: number } | null = null;

/**
 * Forget the cached limits (tests; settings saves and CHANNEL_SETTINGS_RELOAD).
 * 10.5: also the cached send rate settings (submission-rate.ts), so every
 * service that reloads the submission limits reloads the rate limit with them.
 */
export function clearSubmissionLimitsCache(): void {
  cache = null;
  clearSendRateSettingsCache();
}

/** Same cache as {@link clearSubmissionLimitsCache} (name kept for the size-only callers). */
export const clearMessageSizeLimitCache = clearSubmissionLimitsCache;

/** The global limits (60 s cache; unreadable settings → defaults, retried after the TTL). */
export async function loadSubmissionLimits(now = Date.now()): Promise<SubmissionLimits> {
  if (cache && cache.expires > now) return cache.limits;
  let limits: SubmissionLimits;
  try {
    const [smtp, server] = await Promise.all([
      prisma.smtpSettings.findUnique({ where: { id: 'singleton' }, select: { maxMessageSizeMb: true, maxRecipients: true } }),
      prisma.serverSettings.findUnique({ where: { id: 'singleton' }, select: { maxMessageSizeMb: true } }),
    ]);
    limits = submissionLimitsFrom(smtp, server);
  } catch {
    limits = submissionLimitsFrom(null, null);
  }
  cache = { limits, expires: now + CACHE_MS };
  return limits;
}

/** Global max. size of one outgoing message in bytes (body guards before the sender is known). */
export async function maxOutgoingMessageBytes(now: number = Date.now()): Promise<number> {
  return (await loadSubmissionLimits(now)).maxMessageBytes;
}

/** Size check against the global outgoing limit. */
export async function checkOutgoingMessageSize(size: number): Promise<MessageSizeCheck> {
  return checkMessageSize(size, await maxOutgoingMessageBytes());
}

/**
 * The limits that apply to a submission by `userId`: the global limits with the
 * user's per-mailbox values (MailFlowPolicy) replacing them.
 */
export async function submissionLimitsForUser(userId: string): Promise<SendLimits> {
  const global = await loadSubmissionLimits();
  return effectiveSendLimits(await loadMailFlowPolicy({ userId }), { maxBytes: global.maxMessageBytes, maxRecipients: global.maxRecipients });
}

/** Does a message of `sizeBytes` to `recipients` addresses fit the limits of `userId`? */
export async function checkSubmissionLimits(userId: string, sizeBytes: number, recipients: number): Promise<SendLimitVerdict> {
  return checkSendLimitsPure(await submissionLimitsForUser(userId), sizeBytes, recipients);
}
