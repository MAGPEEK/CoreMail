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
  /** Ledger entries of earlier, failed attempts (see `ledgerEntry`). */
  delivered(key: string): Promise<Set<string>>;
  /** Records the entries so far (only after a failed attempt and on its completing retry). */
  remember(key: string, entries: string[]): Promise<void>;
}

/**
 * Result of one local store: stored, or not storable (mailbox over its hard
 * quota / recipient gone / refused by the recipient's mail flow policy, 9.4) —
 * the failures need an NDR to the sender.
 */
export type LocalOutcome = 'delivered' | 'quota' | 'unknown' | 'policy';

export interface DeliveryDeps {
  /** `void` counts as delivered (pre-8.1 callers). */
  storeLocal(rcpt: string): Promise<LocalOutcome | void>;
  enqueueExternal(rcpts: string[]): Promise<void>;
  ledger: DeliveryLedger;
}

/** Key of one transaction: envelope sender + the octets as received from the client. */
export function deliveryKey(from: string, raw: Buffer): string {
  return createHash('sha256').update(from.toLowerCase()).update('\0').update(raw).digest('hex');
}

const EXTERNAL_MARK = 'external:';

/**
 * Pure: ledger entry of a local outcome. A delivered recipient is stored as the
 * bare address (pre-8.1 ledgers), a failed one with its outcome as prefix — so
 * a retry still sends the NDR the failed attempt never got to send.
 */
export function ledgerEntry(rcpt: string, outcome: LocalOutcome): string {
  return outcome === 'delivered' ? rcpt : `${outcome}:${rcpt}`;
}

/** Pure: the outcome recorded for a local recipient, or null when it was not handled yet. */
export function ledgerOutcome(entries: Set<string>, rcpt: string): LocalOutcome | null {
  if (entries.has(rcpt)) return 'delivered';
  if (entries.has(`quota:${rcpt}`)) return 'quota';
  if (entries.has(`unknown:${rcpt}`)) return 'unknown';
  if (entries.has(`policy:${rcpt}`)) return 'policy';
  return null;
}

export interface DeliveryResult {
  stored: string[];
  skipped: string[];
  /** Outcome per local recipient — this attempt's or the one recorded by an earlier attempt. */
  outcomes: Map<string, LocalOutcome>;
}

/**
 * Stores every local recipient and enqueues the external ones. Throws when a
 * step fails (the caller answers 451); recipients handled before the failure
 * are recorded WITH their outcome, so a retry neither delivers them again nor
 * loses the NDR of a recipient that was over quota or unknown.
 */
export async function deliverOnce(
  key: string,
  local: string[],
  external: string[],
  deps: DeliveryDeps,
): Promise<DeliveryResult> {
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
  const outcomes = new Map<string, LocalOutcome>();
  try {
    for (const rcpt of local) {
      const earlier = ledgerOutcome(done, rcpt);
      if (earlier) { skipped.push(rcpt); outcomes.set(rcpt, earlier); continue; }
      const outcome = (await deps.storeLocal(rcpt)) ?? 'delivered';
      outcomes.set(rcpt, outcome);
      if (outcome === 'delivered') stored.push(rcpt);
      progress.push(ledgerEntry(rcpt, outcome));
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
  return { stored, skipped, outcomes };
}

/**
 * Pure: maps the per-target outcomes back onto the recipients as the client
 * addressed them (aliases → their targets). A recipient counts as delivered
 * only when every local target it expanded to was delivered; a failed target
 * is reported under the original address(es) — the NDR names what the sender
 * typed, and a full alias target never gets both a "delivered" DSN and an NDR.
 */
export function outcomesByOriginal(
  origins: ReadonlyMap<string, readonly string[]>,
  outcomes: ReadonlyMap<string, LocalOutcome>,
): { delivered: string[]; quota: string[]; unknown: string[]; policy: string[] } {
  const state = new Map<string, LocalOutcome>();
  const rank: Record<LocalOutcome, number> = { delivered: 0, quota: 1, policy: 2, unknown: 3 };
  for (const [target, outcome] of outcomes) {
    for (const original of origins.get(target) ?? [target]) {
      const prev = state.get(original);
      if (!prev || rank[outcome] > rank[prev]) state.set(original, outcome);
    }
  }
  const pick = (o: LocalOutcome): string[] => [...state].filter(([, v]) => v === o).map(([k]) => k);
  return { delivered: pick('delivered'), quota: pick('quota'), unknown: pick('unknown'), policy: pick('policy') };
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
