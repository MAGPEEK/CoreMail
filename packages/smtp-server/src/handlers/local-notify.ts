/**
 * Delivery reports after a local delivery (port 25 inbound and SMTP submission).
 *
 *  - Outcomes come from `deliverOnce` — including the ones an earlier, failed
 *    attempt recorded in the ledger — so a retry still sends the NDR for a
 *    recipient that was over quota or unknown, and never confirms it as delivered.
 *  - Outcomes are mapped back onto the recipients as addressed (aliases): a full
 *    alias target gets an NDR under the alias, not also a "delivered" DSN.
 *  - Port 25 (unauthenticated): a success DSN goes out only when the MAIL FROM
 *    domain is authenticated (SPF pass or aligned DKIM, `verifiedDomains`), and
 *    always with RET=HDRS — a forged MAIL FROM with NOTIFY=SUCCESS RET=FULL must
 *    not reflect the message to a third party (backscatter).
 */
import { createLogger } from '@coremail/core';
import { isAttendeeAuthenticated, type SenderAuth } from '@coremail/storage';
import { sendSuccessDsn, rawSubjectAndId } from '../outbound/dsn.js';
import { bounceUnknownLocal, bounceQuotaLocal } from './local-delivery.js';
import { outcomesByOriginal, type LocalOutcome } from './delivery.js';
import type { EnvelopeDsn } from '../core/dsn-params.js';

const log = createLogger('smtp:local-notify');

export interface LocalNotifyInput {
  from: string;
  /** Recipients as the client addressed them that may get a success DSN. */
  originals: string[];
  /** Delivery target → original recipient(s) (expandRecipientsWithOrigins). */
  origins: ReadonlyMap<string, readonly string[]>;
  outcomes: ReadonlyMap<string, LocalOutcome>;
  dsn: EnvelopeDsn | undefined;
  hostname: string;
  /** Message as delivered (success DSN content). */
  deliveredRaw: Buffer;
  /** Message for the NDR (returned content). */
  ndrRaw: Buffer;
  /** No success DSN at all (e.g. mail filed as junk). */
  noSuccess?: boolean;
  /** Unauthenticated port-25 session: success DSN gated on `senderAuth`, RET forced to HDRS. */
  unauthenticated?: { senderAuth: SenderAuth };
}

export interface LocalNotifyDeps {
  successDsn: typeof sendSuccessDsn;
  bounceUnknown: typeof bounceUnknownLocal;
  bounceQuota: typeof bounceQuotaLocal;
}

const defaultDeps: LocalNotifyDeps = {
  successDsn: sendSuccessDsn, bounceUnknown: bounceUnknownLocal, bounceQuota: bounceQuotaLocal,
};

/** Pure: may an unauthenticated (port 25) transaction get a success DSN? */
export function successDsnAllowed(from: string, senderAuth: SenderAuth): boolean {
  return !!from && isAttendeeAuthenticated(from, senderAuth);
}

/** Sends the success DSN and the NDRs for one local delivery (never throws). */
export async function notifyLocalOutcomes(input: LocalNotifyInput, deps: LocalNotifyDeps = defaultDeps): Promise<{
  success: string[]; unknown: string[]; quota: string[];
}> {
  const summary = outcomesByOriginal(input.origins, input.outcomes);
  let success: string[] = [];
  if (input.dsn && !input.noSuccess) {
    const rcpts = input.originals.filter((r) => summary.delivered.includes(r));
    let dsn: EnvelopeDsn | undefined = input.dsn;
    let allowed = true;
    if (input.unauthenticated) {
      allowed = successDsnAllowed(input.from, input.unauthenticated.senderAuth);
      if (!allowed) log.info({ from: input.from }, 'Success DSN suppressed: MAIL FROM domain not authenticated (backscatter protection)');
      dsn = { ...input.dsn, ret: 'HDRS' };
    }
    if (allowed && rcpts.length > 0) {
      try {
        const original = rawSubjectAndId(input.deliveredRaw);
        success = await deps.successDsn({
          from: input.from, rcpts, action: 'delivered', dsn, hostname: input.hostname, originalRaw: input.deliveredRaw,
          subject: original.subject, messageId: original.messageId, deliverExternal: true,
        });
      } catch (err) {
        log.warn({ err, from: input.from }, 'Success DSN not sent');
      }
    }
  }
  if (summary.unknown.length > 0) {
    await deps.bounceUnknown(input.ndrRaw, input.from, summary.unknown, { hostname: input.hostname }).catch((err: unknown) =>
      log.error({ err, from: input.from, unknown: summary.unknown }, 'NDR for unknown local recipients failed'));
  }
  if (summary.quota.length > 0) {
    await deps.bounceQuota(input.ndrRaw, input.from, summary.quota, { hostname: input.hostname }).catch((err: unknown) =>
      log.error({ err, from: input.from, quota: summary.quota }, 'NDR for over-quota local recipients failed'));
  }
  return { success, unknown: summary.unknown, quota: summary.quota };
}
