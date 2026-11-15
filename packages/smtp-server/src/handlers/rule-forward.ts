import { randomUUID } from 'crypto';
import { createLogger } from '@coremail/core';
import { enqueueOutbound } from '../outbound/queue.js';
import { formatRfc5322Date } from './trace.js';

const log = createLogger('smtp:rule-forward');

const LOOP_HEADER = 'X-CoreMail-RuleForwarded';

/**
 * Checks the loop-protection header. If the mail has already been forwarded
 * by a rule (regardless of which user), `true` is returned →
 * no further forward action.
 */
export function isRuleForwardedAlready(rawBuffer: Buffer): boolean {
  const headerEnd = rawBuffer.indexOf('\r\n\r\n');
  const slice = headerEnd > 0 ? rawBuffer.subarray(0, headerEnd) : rawBuffer.subarray(0, Math.min(rawBuffer.length, 16384));
  return slice.toString('utf8').toLowerCase().includes(LOOP_HEADER.toLowerCase() + ':');
}

/**
 * Prepends header fields to the message. Resent-* blocks MUST be added at the
 * top of the header (RFC 5322 §3.6.6), like trace fields.
 */
export function prependHeaders(rawBuffer: Buffer, extraHeaders: Record<string, string>): Buffer {
  const extra = Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  return Buffer.concat([Buffer.from(extra), rawBuffer]);
}

export interface RuleForwardOpts {
  rawBuffer:      Buffer;
  toAddress:      string;        // target address (from the rule)
  forwardingUser: { id: string; email: string };
  mode:           'forward' | 'redirect';
  /** Envelope reverse-path of the original mail ('' = null sender). */
  originalFrom:   string;
}

/** Pure: envelope sender and header fields of a rule forward/redirect. */
export function buildRuleForward(opts: RuleForwardOpts, now = new Date()): { envelopeFrom: string; raw: Buffer } {
  const extra: Record<string, string> = {};
  if (opts.mode === 'forward') {
    extra['Resent-From'] = `<${opts.forwardingUser.email}>`;
    extra['Resent-To']   = `<${opts.toAddress}>`;
    extra['Resent-Date'] = formatRfc5322Date(now);
    extra['Resent-Message-ID'] = `<${randomUUID()}@${opts.forwardingUser.email.split('@')[1] ?? 'localhost'}>`;
  }
  extra[LOOP_HEADER] = opts.forwardingUser.id;
  // `redirect`: the envelope sender stays the ORIGINAL reverse-path (RFC 5321
  // §3.9.1) — not the header From — so bounces reach the list/bounce address
  // and a null sender (a bounce) stays null. `forward`: the user takes over.
  const envelopeFrom = opts.mode === 'redirect' ? opts.originalFrom : opts.forwardingUser.email;
  return { envelopeFrom, raw: prependHeaders(opts.rawBuffer, extra) };
}

/**
 * Hands an outgoing forward/redirect mail to the SMTP outbound queue.
 *
 * - `forward`: the user becomes the sender (Resent-From/Resent-To headers),
 *   envelope-from = user's mail. Recipient sees "forwarded by user".
 * - `redirect`: original headers stay untouched, envelope-from = original
 *   envelope sender.
 *
 * In both cases the loop-protection header is set. Throws when the job cannot
 * be enqueued (the caller defers the SMTP transaction).
 */
export async function enqueueRuleForward(opts: RuleForwardOpts): Promise<void> {
  if (isRuleForwardedAlready(opts.rawBuffer)) {
    log.warn(
      { userId: opts.forwardingUser.id, to: opts.toAddress },
      'Loop protection: mail was already forwarded by a rule — skipping',
    );
    return;
  }

  const { envelopeFrom, raw } = buildRuleForward(opts);

  await enqueueOutbound({
    messageId:  randomUUID(),
    from:       envelopeFrom,
    to:         [opts.toAddress],
    rawMessage: raw.toString('base64'),
    senderUserId: opts.forwardingUser.id,
  });

  log.info(
    { userId: opts.forwardingUser.id, to: opts.toAddress, mode: opts.mode },
    'Rule forward enqueued',
  );
}
