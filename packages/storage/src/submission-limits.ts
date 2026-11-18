/**
 * Limits of a message a client submits for sending (9.4; the SMTP submission
 * rules, used by the MAPI server and the REST send size check):
 *  - size: the stricter of SmtpSettings.maxMessageSizeMb (SMTP SIZE) and
 *    ServerSettings.maxMessageSizeMb;
 *  - recipients: SmtpSettings.maxRecipients (SMTP RCPT TO limit).
 * Read with a 60 s cache; schema defaults when the settings are unreadable.
 */
import { prisma } from './prisma/index.js';

export interface SubmissionLimits {
  maxMessageBytes: number;
  maxRecipients: number;
}

const DEFAULT_MAX_MESSAGE_MB = 25;
const DEFAULT_MAX_RECIPIENTS = 100;
const CACHE_MS = 60_000;
const MB = 1024 * 1024;

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Pure: the limits from the two settings rows (either may be missing). */
export function submissionLimitsFrom(
  smtp: { maxMessageSizeMb?: number | null; maxRecipients?: number | null } | null,
  server: { maxMessageSizeMb?: number | null } | null,
): SubmissionLimits {
  const sizes = [smtp?.maxMessageSizeMb, server?.maxMessageSizeMb].filter(positive);
  const mb = sizes.length ? Math.min(...sizes) : DEFAULT_MAX_MESSAGE_MB;
  return {
    maxMessageBytes: Math.max(1, mb) * MB,
    maxRecipients: positive(smtp?.maxRecipients) ? Math.floor(smtp.maxRecipients) : DEFAULT_MAX_RECIPIENTS,
  };
}

let cache: { limits: SubmissionLimits; expires: number } | null = null;

export function clearSubmissionLimitsCache(): void {
  cache = null;
}

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
