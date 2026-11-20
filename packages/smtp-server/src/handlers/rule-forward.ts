import { createHash, randomUUID } from 'crypto';
import { createLogger, getRedisClient } from '@coremail/core';
import { applyOutcomeToBuffer, consumeSendRate, RULE_FORWARDED_HEADER, type SendRateDecision, type TransportOutcome } from '@coremail/storage';
import { enqueueOutbound, type OutboundJob } from '../outbound/queue.js';
import { PARTIAL_DELIVERY_TTL_SEC } from './delivery.js';
import { formatRfc5322Date, headerBounds } from './trace.js';

const log = createLogger('smtp:rule-forward');

/** Internal header (storage INTERNAL_MAIL_HEADERS): stripped from every received or submitted message. */
const LOOP_HEADER = RULE_FORWARDED_HEADER;

/**
 * Checks the loop-protection header. If the mail has already been forwarded
 * by a rule (regardless of which user), `true` is returned →
 * no further forward action.
 */
export function isRuleForwardedAlready(rawBuffer: Buffer): boolean {
  const { end } = headerBounds(rawBuffer);
  const slice = rawBuffer.subarray(0, Math.min(end, 256 * 1024));
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

/** What the admin forwarding of a mailbox does with one delivery (9.4). */
export type AdminForwardPlan = 'none' | 'skipped-loop' | { to: string; keepCopy: boolean };

/**
 * Pure: the admin forwarding (MailFlowPolicy.forwardTo) of one delivery.
 * Forwarded like a rule `forward` (Resent-* fields, envelope sender = the
 * forwarding mailbox — aligned with our SPF/DKIM, no SRS rewriting) with the
 * same loop header. Never forwarded — and then always kept locally, so nothing
 * is lost: a message that was already forwarded by a rule or an admin
 * forwarding (loop protection), and a null-sender message (bounces and DSNs
 * stay where they arrive; forwarding them could bounce back and forth).
 */
export function planAdminForward(
  policy: { forwardTo: string | null; forwardKeepCopy: boolean },
  ctx: { envelopeFrom: string; alreadyForwarded: boolean },
): AdminForwardPlan {
  if (!policy.forwardTo) return 'none';
  if (ctx.alreadyForwarded || !ctx.envelopeFrom) return 'skipped-loop';
  return { to: policy.forwardTo, keepCopy: policy.forwardKeepCopy };
}

/**
 * Pure (9.4): the message every forward sends — the admin forwarding and the
 * user's inbox-rule forwards/redirects. The S/MIME plaintext that was decrypted
 * for storage never leaves the server: a decrypted message is forwarded as it
 * was received (still encrypted) with the transport rules' header and subject
 * changes — without a disclaimer, as the body is the encrypted entity.
 * Anything else is forwarded as it is stored.
 */
export function forwardSource(
  stored: Buffer,
  received: Buffer,
  decrypted: boolean,
  transport: TransportOutcome | null,
): Buffer {
  if (!decrypted) return stored;
  return transport ? applyOutcomeToBuffer(received, { ...transport, disclaimerHtml: '' }) : received;
}

/**
 * Pure (9.4 review): the forward requests of a user's inbox rules. They send
 * `source` (see {@link forwardSource}) — never the decrypted copy kept for storage.
 */
export function inboxRuleForwardOpts(
  forwards: ReadonlyArray<{ address: string; mode: 'forward' | 'redirect' }>,
  ctx: { source: Buffer; user: { id: string; email: string }; originalFrom: string; dedupKey?: string | undefined; recipient: string },
): RuleForwardOpts[] {
  return forwards.map((fwd) => ({
    rawBuffer:      ctx.source,
    toAddress:      fwd.address,
    forwardingUser: { id: ctx.user.id, email: ctx.user.email },
    mode:           fwd.mode,
    originalFrom:   ctx.originalFrom,
    dedupKey:       ctx.dedupKey,
    recipient:      ctx.recipient,
    countSendRate:  true, // 10.5 review: the user's own rules count against their send rate
  }));
}

export interface RuleForwardOpts {
  rawBuffer:      Buffer;
  toAddress:      string;        // target address (from the rule)
  /**
   * The forwarding mailbox. `shared` (9.4 admin forwarding of a Shared
   * Mailbox): `id` is a SharedMailbox id — the queue job gets no senderUserId.
   */
  forwardingUser: { id: string; email: string; shared?: boolean };
  mode:           'forward' | 'redirect';
  /** Envelope reverse-path of the original mail ('' = null sender). */
  originalFrom:   string;
  /** SMTP transaction key (handlers/delivery.ts deliveryKey) — dedups retries. */
  dedupKey?:      string | undefined;
  /** Local recipient whose rule fired (part of the dedup key). */
  recipient?:     string | undefined;
  /**
   * 10.5 review: the forward counts against the forwarding user's hourly send
   * rate (storage submission-rate.ts, protocol `rule`) — set for the user's own
   * inbox rules; the admin forwarding (MailFlowPolicy) is an admin setting.
   */
  countSendRate?: boolean | undefined;
}

export interface RuleForwardDeps {
  /** Claims `key` for the retry window; false when it was claimed before. */
  claim(key: string): Promise<boolean>;
  release(key: string): Promise<void>;
  enqueue(job: OutboundJob): Promise<unknown>;
  /** 10.5 review: the hourly send rate (counts when allowed). Absent = not limited (test deps). */
  consumeRate?(req: { userId: string; recipients: number; protocol: 'rule' }): Promise<SendRateDecision>;
}

const defaultRuleForwardDeps: RuleForwardDeps = {
  claim: async (key) => (await getRedisClient().set(key, '1', 'EX', PARTIAL_DELIVERY_TTL_SEC, 'NX')) === 'OK',
  release: async (key) => { await getRedisClient().del(key); },
  enqueue: (job) => enqueueOutbound(job),
  consumeRate: (req) => consumeSendRate(req),
};

/** 10.5 review: what happened to one forward request. */
export type RuleForwardStatus = 'queued' | 'loop' | 'duplicate' | 'rate-limited';

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
export async function enqueueRuleForward(opts: RuleForwardOpts, deps: RuleForwardDeps = defaultRuleForwardDeps): Promise<RuleForwardStatus> {
  if (isRuleForwardedAlready(opts.rawBuffer)) {
    log.warn(
      { userId: opts.forwardingUser.id, to: opts.toAddress },
      'Loop protection: mail was already forwarded by a rule — skipping',
    );
    return 'loop';
  }

  // The forward is queued before the local copy is committed; when the store
  // then fails, the sender retries the whole transaction. The claim (keyed by
  // the SMTP transaction, recipient and target) makes that retry skip it.
  const claimKey = opts.dedupKey
    ? `smtp:rulefwd:${createHash('sha256').update(`${opts.dedupKey}\0${opts.recipient ?? ''}\0${opts.mode}\0${opts.toAddress.toLowerCase()}`).digest('hex')}`
    : null;
  if (claimKey) {
    let claimed = true;
    try {
      claimed = await deps.claim(claimKey);
    } catch (err) {
      log.warn({ err }, 'Rule forward dedup store not reachable — forwarding without dedup');
    }
    if (!claimed) {
      log.info({ userId: opts.forwardingUser.id, to: opts.toAddress }, 'Rule forward already queued by an earlier attempt — skipping');
      return 'duplicate';
    }
  }

  // 10.5 review: an inbox-rule forward is mail the user's account sends — it counts
  // against the hourly send rate; over the limit it is skipped (the inbound delivery
  // itself is never refused; the caller keeps a local copy).
  if (opts.countSendRate && !opts.forwardingUser.shared && deps.consumeRate) {
    const rate = await deps.consumeRate({ userId: opts.forwardingUser.id, recipients: 1, protocol: 'rule' });
    if (!rate.allowed) {
      if (claimKey) await deps.release(claimKey).catch(() => undefined);
      log.warn({ userId: opts.forwardingUser.id, to: opts.toAddress, reason: rate.reason }, 'Rule forward skipped — send rate limit of the account reached');
      return 'rate-limited';
    }
  }

  const { envelopeFrom, raw } = buildRuleForward(opts);

  try {
    await deps.enqueue({
      messageId:  randomUUID(),
      from:       envelopeFrom,
      to:         [opts.toAddress],
      rawMessage: raw.toString('base64'),
      ...(opts.forwardingUser.shared ? {} : { senderUserId: opts.forwardingUser.id }),
      // the local delivery of this job keeps the genuine loop header (queue.ts localDeliveryBuffer)
      ruleForward: true,
      ...(opts.mode === 'redirect' ? { ruleRedirect: true } : {}),
    });
  } catch (err) {
    if (claimKey) await deps.release(claimKey).catch(() => undefined);
    throw err;
  }

  log.info(
    { userId: opts.forwardingUser.id, to: opts.toAddress, mode: opts.mode },
    'Rule forward enqueued',
  );
  return 'queued';
}
