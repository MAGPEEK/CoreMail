/**
 * Applies the routing part of a TransportOutcome (packages/storage/src/transport-rules.ts)
 * for ONE envelope recipient inside storeInboundMessage():
 *
 *   reject     → DSN to the envelope sender if it is a LOCAL address (none for the
 *                null sender <> or forgeable external senders — no backscatter), no delivery
 *   quarantine → raw message + envelope into the quarantine store, no delivery
 *                (skipped for messages re-injected by a BCP quarantine release)
 *   redirect   → deliver ONLY to the redirect target(s), not to the original recipient
 *   addRecipient    → additionally deliver to the given address(es) (compliance BCC)
 *   removeRecipient → do not deliver to the original recipient if it is listed
 *
 * Transport rules match on message content only, so every recipient of the same
 * message produces the same outcome. Side effects that are per MESSAGE (DSN,
 * extra-recipient deliveries) are de-duplicated with a short-lived "once" claim
 * keyed on the raw message hash, so a mail to N local recipients does not
 * produce N DSNs or N compliance copies.
 *
 * Extra deliveries are stored with `skipTransportRules` → no rule loops.
 */
import crypto from 'crypto';
import { createLogger, getRedisClient } from '@coremail/core';
import { prisma, applyOutcomeToBuffer, type TransportOutcome } from '@coremail/storage';

const log = createLogger('smtp:transport-actions');

export interface TransportActionContext {
  /** Original raw message as received (before per-recipient S/MIME decryption). */
  raw:        Buffer;
  fromAddr:   string;
  rcptTo:     string;
  subject:    string;
  messageId:  string | null;
  spamScore?: number;
  /** True when the message is re-injected by a quarantine release. */
  quarantineRelease?: boolean;
}

export interface ExtraDeliveryOptions { skipTransportRules: true }

export interface TransportActionDeps {
  sendDsn: (opts: {
    originalFrom: string; originalTo: string[]; originalSubject: string;
    originalMessageId: string | null; failureReason: string; smtpCode: number | null;
    serverHostname: string; deliverExternal?: boolean;
  }) => Promise<void>;
  quarantine: (input: {
    raw: Buffer; from: string; recipients: string[]; reason: 'POLICY';
    details: Record<string, unknown>; spamScore?: number;
  }) => Promise<string>;
  /** Local delivery of an extra recipient (storeInboundMessage). */
  storeLocal: (raw: Buffer, fromAddr: string, rcptTo: string, opts: ExtraDeliveryOptions) => Promise<void>;
  /** External delivery via the BullMQ 'smtp-outbound' queue (rawMessage). */
  enqueueExternal: (raw: Buffer, fromAddr: string, to: string[]) => Promise<void>;
  isLocalAddress: (addr: string) => Promise<boolean>;
  /** Alias expansion for local extra recipients. */
  expand: (addrs: string[]) => Promise<string[]>;
  /** Returns true exactly once per key (per-message de-duplication). */
  claimOnce: (key: string) => Promise<boolean>;
  serverHostname: () => Promise<string>;
}

export type TransportDecision = 'continue' | 'stop';

// ── Pure recipient-set math ───────────────────────────────────────────────────

const norm = (a: string): string => a.trim().toLowerCase();

/**
 * Computes the effective recipient set for a list of envelope recipients:
 *   1. redirect (non-empty) replaces all original recipients
 *   2. addRecipient adds addresses
 *   3. removeRecipient removes addresses (applied last, also to added ones)
 * Result is lower-cased and de-duplicated, order preserved.
 */
export function applyRecipientChanges(
  recipients: readonly string[],
  outcome: Pick<TransportOutcome, 'redirectedTo' | 'additionalRcpts' | 'removedRcpts'>,
): string[] {
  const base = outcome.redirectedTo.length > 0 ? outcome.redirectedTo : recipients;
  const removed = new Set(outcome.removedRcpts.map(norm));
  const out: string[] = [];
  for (const addr of [...base, ...outcome.additionalRcpts].map(norm)) {
    if (!addr || removed.has(addr) || out.includes(addr)) continue;
    out.push(addr);
  }
  return out;
}

/** Splits the per-recipient result into "keep the original" + "extra deliveries". */
export function planRecipient(
  rcptTo: string,
  outcome: Pick<TransportOutcome, 'redirectedTo' | 'additionalRcpts' | 'removedRcpts'>,
): { keepOriginal: boolean; extra: string[] } {
  const original = norm(rcptTo);
  const set = applyRecipientChanges([original], outcome);
  return { keepOriginal: set.includes(original), extra: set.filter((a) => a !== original) };
}

function hasRecipientChanges(o: TransportOutcome): boolean {
  return o.redirectedTo.length > 0 || o.additionalRcpts.length > 0 || o.removedRcpts.length > 0;
}

function isNullSender(from: string): boolean {
  const f = from.trim();
  return f === '' || f === '<>';
}

// ── Outcome handler ───────────────────────────────────────────────────────────

export async function handleTransportOutcome(
  outcome: TransportOutcome,
  ctx: TransportActionContext,
  deps: TransportActionDeps = defaultDeps,
): Promise<TransportDecision> {
  const msgKey = crypto.createHash('sha256').update(ctx.raw).digest('hex');

  // 1. reject — terminal. SMTP already answered 250 → bounce via DSN.
  if (outcome.rejected) {
    const reason = outcome.rejectReason ?? 'Message rejected by transport rule';
    log.warn({ rcptTo: ctx.rcptTo, from: ctx.fromAddr, reason }, 'Mail rejected by TransportRule — no delivery');
    if (isNullSender(ctx.fromAddr)) {
      log.info({ rcptTo: ctx.rcptTo }, 'No DSN for rejected mail: null sender (backscatter protection)');
    } else if (!(await deps.isLocalAddress(ctx.fromAddr))) {
      // The envelope sender of an inbound message can be forged; bouncing to it
      // would send backscatter to innocent third parties. Only local senders
      // (whose address we own) are notified.
      log.info({ rcptTo: ctx.rcptTo, from: ctx.fromAddr }, 'No DSN for rejected mail: external sender (backscatter protection)');
    } else if (await deps.claimOnce(`dsn:${msgKey}`)) {
      await deps.sendDsn({
        originalFrom:      ctx.fromAddr,
        originalTo:        [ctx.rcptTo],
        originalSubject:   ctx.subject,
        originalMessageId: ctx.messageId,
        failureReason:     reason,
        smtpCode:          550,
        serverHostname:    await deps.serverHostname(),
      }).catch((err: unknown) => log.error({ err }, 'DSN for transport-rule reject failed'));
    }
    return 'stop';
  }

  // 2. quarantine — no delivery; one record per envelope recipient.
  if (outcome.quarantined && !ctx.quarantineRelease) {
    const id = await deps.quarantine({
      raw:        ctx.raw,
      from:       ctx.fromAddr,
      recipients: [ctx.rcptTo],
      reason:     'POLICY',
      details:    { source: 'transport-rule', ruleIds: outcome.appliedRuleIds },
      ...(ctx.spamScore !== undefined ? { spamScore: ctx.spamScore } : {}),
    });
    log.info({ rcptTo: ctx.rcptTo, from: ctx.fromAddr, quarantineId: id, ruleIds: outcome.appliedRuleIds },
      'Mail moved to quarantine by TransportRule');
    return 'stop';
  }

  // 3. recipient changes
  if (!hasRecipientChanges(outcome)) return 'continue';
  const plan = planRecipient(ctx.rcptTo, outcome);

  if (plan.extra.length > 0) {
    // Same header/subject/disclaimer modifications as the original delivery.
    const extraRaw = applyOutcomeToBuffer(ctx.raw, outcome);
    const todo: string[] = [];
    for (const addr of plan.extra) {
      if (await deps.claimOnce(`rcpt:${msgKey}:${addr}`)) todo.push(addr);
    }
    const local: string[] = [];
    const external: string[] = [];
    for (const addr of todo) {
      if (await deps.isLocalAddress(addr)) local.push(addr);
      else external.push(addr);
    }
    for (const addr of local.length > 0 ? await deps.expand(local) : []) {
      try {
        await deps.storeLocal(extraRaw, ctx.fromAddr, addr, { skipTransportRules: true });
      } catch (err) {
        log.error({ err, addr }, 'TransportRule extra local delivery failed');
      }
    }
    if (external.length > 0) {
      try {
        await deps.enqueueExternal(extraRaw, ctx.fromAddr, external);
      } catch (err) {
        log.error({ err, external }, 'TransportRule extra external delivery failed');
      }
    }
    log.info({ rcptTo: ctx.rcptTo, local, external, keepOriginal: plan.keepOriginal },
      'TransportRule recipient changes applied');
  }

  return plan.keepOriginal ? 'continue' : 'stop';
}

// ── Default (production) dependencies ─────────────────────────────────────────

const defaultDeps: TransportActionDeps = {
  sendDsn: async (opts) => {
    const { sendDsnBounce } = await import('../outbound/dsn.js');
    await sendDsnBounce(opts);
  },
  quarantine: async (input) => {
    const { quarantineMessage } = await import('./quarantine.js');
    return quarantineMessage(input);
  },
  storeLocal: async (raw, fromAddr, rcptTo, opts) => {
    const { storeInboundMessage } = await import('./message.js');
    await storeInboundMessage(raw, { fromAddr, rcptTo, toJunk: false, ...opts });
  },
  enqueueExternal: async (raw, fromAddr, to) => {
    const { enqueueOutbound } = await import('../outbound/queue.js');
    await enqueueOutbound({
      messageId:  crypto.randomUUID(),
      from:       fromAddr,
      to,
      rawMessage: raw.toString('base64'),
    });
  },
  isLocalAddress: async (addr) => {
    const domain = addr.split('@')[1]?.toLowerCase();
    if (!domain) return false;
    const d = await prisma.domain.findFirst({ where: { name: domain, active: true }, select: { id: true } });
    return !!d;
  },
  expand: async (addrs) => {
    const { expandRecipients } = await import('./expand.js');
    return expandRecipients(addrs);
  },
  claimOnce: async (key) => {
    try {
      const res = await getRedisClient().set(`transport:once:${key}`, '1', 'EX', 3600, 'NX');
      return res === 'OK';
    } catch {
      return true; // fail open: duplicate copies are better than lost mail
    }
  },
  serverHostname: async () => {
    const s = await prisma.serverSettings.findUnique({ where: { id: 'singleton' }, select: { publicHostname: true } })
      .catch(() => null);
    return s?.publicHostname ?? 'mail.local';
  },
};
