import { randomUUID } from 'crypto';
import { createLogger } from '@coremail/core';
import { enqueueOutbound } from '../outbound/queue.js';

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
 * Appends headers to the buffer (header/body separated by CRLFCRLF).
 * If the separator is missing, the header is simply appended at the end.
 */
function addHeaders(rawBuffer: Buffer, extraHeaders: Record<string, string>): Buffer {
  const headerEnd = rawBuffer.indexOf('\r\n\r\n');
  const extra = Object.entries(extraHeaders)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\r\n');
  if (headerEnd < 0) {
    return Buffer.concat([rawBuffer, Buffer.from('\r\n' + extra + '\r\n')]);
  }
  return Buffer.concat([
    rawBuffer.subarray(0, headerEnd),
    Buffer.from('\r\n' + extra),
    rawBuffer.subarray(headerEnd),
  ]);
}

export interface RuleForwardOpts {
  rawBuffer:      Buffer;
  toAddress:      string;        // target address (from the rule)
  forwardingUser: { id: string; email: string };
  mode:           'forward' | 'redirect';
  originalFrom:   string;        // From: of the original mail (for the envelope on redirect)
}

/**
 * Hands an outgoing forward/redirect mail to the SMTP outbound queue.
 *
 * - `forward`: the user becomes the sender (Resent-From/Resent-To headers),
 *   envelope-from = user's mail. Recipient sees "forwarded by user".
 * - `redirect`: original headers stay untouched, envelope-from = original sender.
 *   Recipient sees the mail as if it came directly from the original sender.
 *
 * In both cases the loop-protection header is set.
 */
export async function enqueueRuleForward(opts: RuleForwardOpts): Promise<void> {
  if (isRuleForwardedAlready(opts.rawBuffer)) {
    log.warn(
      { userId: opts.forwardingUser.id, to: opts.toAddress },
      'Loop-Schutz: Mail wurde bereits durch eine Rule weitergeleitet — überspringe',
    );
    return;
  }

  const extra: Record<string, string> = {
    [LOOP_HEADER]: opts.forwardingUser.id,
  };

  if (opts.mode === 'forward') {
    extra['Resent-From'] = `<${opts.forwardingUser.email}>`;
    extra['Resent-To']   = `<${opts.toAddress}>`;
    extra['Resent-Date'] = new Date().toUTCString();
    extra['Resent-Message-ID'] = `<${randomUUID()}@${opts.forwardingUser.email.split('@')[1] ?? 'localhost'}>`;
  }

  const augmented = addHeaders(opts.rawBuffer, extra);

  // For `redirect`: envelope-from stays = original sender, so bounces go to the
  // originating sender. For `forward`: the user takes responsibility.
  const envelopeFrom = opts.mode === 'redirect' ? opts.originalFrom : opts.forwardingUser.email;

  await enqueueOutbound({
    messageId:  randomUUID(),
    from:       envelopeFrom,
    to:         [opts.toAddress],
    rawMessage: augmented.toString('base64'),
    senderUserId: opts.forwardingUser.id,
  });

  log.info(
    { userId: opts.forwardingUser.id, to: opts.toAddress, mode: opts.mode },
    'Rule-Forward eingereiht',
  );
}
