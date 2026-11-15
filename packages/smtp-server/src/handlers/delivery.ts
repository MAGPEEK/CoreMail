/**
 * Multi-recipient delivery after DATA (RFC 5321 §6.1).
 *
 * The transaction is answered 250 only when every local copy is stored and the
 * external part is in the outbound queue. When a step fails the session answers
 * 4yz and the client retries the whole transaction — the recipients that were
 * already stored are remembered (keyed by sender + message octets) and skipped
 * on the retry, so a partial failure produces neither lost mail nor duplicates.
 */
import { createHash } from 'node:crypto';
import { createLogger, getRedisClient } from '@coremail/core';

const log = createLogger('smtp:delivery');

/** Retry window of sending MTAs (RFC 5321 §4.5.4.1: give-up time 4–5 days). */
export const PARTIAL_DELIVERY_TTL_SEC = 5 * 24 * 3600;

export interface DeliveryLedger {
  /** Recipients already delivered by an earlier, failed attempt. */
  delivered(key: string): Promise<Set<string>>;
  /** Records the recipients delivered so far (only after a failed attempt and on its completing retry). */
  remember(key: string, recipients: string[]): Promise<void>;
}

export interface DeliveryDeps {
  storeLocal(rcpt: string): Promise<void>;
  enqueueExternal(rcpts: string[]): Promise<void>;
  ledger: DeliveryLedger;
}

/** Key of one transaction: envelope sender + the octets as received from the client. */
export function deliveryKey(from: string, raw: Buffer): string {
  return createHash('sha256').update(from.toLowerCase()).update('\0').update(raw).digest('hex');
}

const EXTERNAL_MARK = 'external:';

/**
 * Stores every local recipient and enqueues the external ones. Throws when a
 * step fails (the caller answers 451); recipients delivered before the failure
 * are recorded so a retry does not deliver them again.
 */
export async function deliverOnce(
  key: string,
  local: string[],
  external: string[],
  deps: DeliveryDeps,
): Promise<{ stored: string[]; skipped: string[] }> {
  let done: Set<string>;
  try {
    done = await deps.ledger.delivered(key);
  } catch (err) {
    log.warn({ err }, 'Delivery ledger not readable — delivering to all recipients');
    done = new Set();
  }
  const progress: string[] = [...done];
  const stored: string[] = [];
  const skipped: string[] = [];
  try {
    for (const rcpt of local) {
      if (done.has(rcpt)) { skipped.push(rcpt); continue; }
      await deps.storeLocal(rcpt);
      stored.push(rcpt);
      progress.push(rcpt);
    }
    const pendingExternal = external.filter((r) => !done.has(EXTERNAL_MARK + r));
    skipped.push(...external.filter((r) => done.has(EXTERNAL_MARK + r)));
    if (pendingExternal.length > 0) {
      await deps.enqueueExternal(pendingExternal);
      progress.push(...pendingExternal.map((r) => EXTERNAL_MARK + r));
    }
  } catch (err) {
    if (progress.length > 0) {
      await deps.ledger.remember(key, progress).catch((e: unknown) =>
        log.error({ err: e, key }, 'Delivery ledger not writable — a retry may deliver duplicates'));
    }
    throw err;
  }
  // A retry that completes an earlier partial delivery marks the whole
  // transaction as done: should the 250 get lost, the next retry is a no-op.
  if (done.size > 0) {
    await deps.ledger.remember(key, progress).catch((e: unknown) => log.warn({ err: e, key }, 'Delivery ledger not writable'));
  }
  return { stored, skipped };
}

/** Redis ledger: a set per failed transaction, kept for the sender's retry window. */
export const redisDeliveryLedger: DeliveryLedger = {
  async delivered(key) {
    return new Set(await getRedisClient().smembers(`smtp:partial:${key}`));
  },
  async remember(key, recipients) {
    const redis = getRedisClient();
    await redis.sadd(`smtp:partial:${key}`, ...recipients);
    await redis.expire(`smtp:partial:${key}`, PARTIAL_DELIVERY_TTL_SEC);
  },
};
