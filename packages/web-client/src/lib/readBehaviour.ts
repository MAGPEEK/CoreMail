/**
 * 9.4: what the reader does when a message is opened (Settings → Lesen).
 * The webmail opens messages with `?markRead=false` and decides itself:
 *  - mark read immediately, after N seconds, or only manually,
 *  - read receipts: never answer, ask, or answer automatically.
 * No imports — unit-tested with `node --test`.
 */
export type MarkReadMode = 'immediately' | 'delay' | 'manual';
export type ReceiptPolicy = 'never' | 'ask' | 'always';

/** Keyword set once a receipt request was answered (sent or declined). */
export const MDN_SENT_FLAG = '$MDNSent';

/**
 * Milliseconds after which the opened message is marked read, or null (not at
 * all: manual mode, already read, or read-only mailbox).
 */
export function autoReadDelayMs(mode: MarkReadMode, delaySec: number, seen: boolean, readOnly: boolean): number | null {
  if (seen || readOnly || mode === 'manual') return null;
  if (mode === 'immediately') return 0;
  return Math.min(Math.max(Math.round(delaySec), 1), 120) * 1000;
}

export interface ReceiptContext {
  /** Disposition-Notification-To of the message (null = no request). */
  requestedBy: string | null | undefined;
  flags: readonly string[];
  /** Own mailbox only — receipts are never sent from shared/delegated mailboxes. */
  ownMailbox: boolean;
  /** Messages in Junk never trigger a receipt. */
  inJunk: boolean;
  /** Address the original came from (envelope / From). */
  fromAddr: string;
}

export type ReceiptAction = 'none' | 'ask' | 'sendAutomatically';

function domainOf(addr: string): string {
  const at = addr.lastIndexOf('@');
  return at < 0 ? '' : addr.slice(at + 1).toLowerCase();
}

/**
 * What to do about a read-receipt request. "Always" answers automatically only
 * when the receipt goes back to the sender's own domain — a request pointing
 * somewhere else is asked about (it could be used to confirm addresses to a
 * third party).
 */
export function receiptAction(policy: ReceiptPolicy, ctx: ReceiptContext): ReceiptAction {
  if (!ctx.requestedBy || !ctx.ownMailbox || ctx.inJunk || ctx.flags.includes(MDN_SENT_FLAG)) return 'none';
  if (policy === 'never') return 'none';
  if (policy === 'always' && domainOf(ctx.requestedBy) !== '' && domainOf(ctx.requestedBy) === domainOf(ctx.fromAddr)) {
    return 'sendAutomatically';
  }
  return 'ask';
}

/** Compose: is the "request a read receipt" option shown, and is it ticked by default? */
export function receiptRequestOption(policy: ReceiptPolicy): { visible: boolean; checked: boolean } {
  return { visible: policy !== 'never', checked: policy === 'always' };
}
