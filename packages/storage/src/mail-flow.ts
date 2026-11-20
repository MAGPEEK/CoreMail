/**
 * Per-mailbox mail flow (9.4) — MailFlowPolicy of a user mailbox or a Shared
 * Mailbox: address-list visibility, admin forwarding, accept-only-from /
 * reject-from lists and limits that override the global ones.
 *
 * Pure rules (validation, sender matching, verdicts, effective limits) are
 * separated from the database lookups so every enforcement point (SMTP
 * RCPT/DATA, local delivery, webmail / SMTP submission / JMAP / ActiveSync
 * sending, directory searches) shares one implementation.
 * See docs/mailbox-management.md.
 */
import { prisma } from './prisma/index.js';
import { findBodyStart, parseHeaderFields } from './mime/tree.js';
import { addressesOf } from './mime/address.js';
import { normalizeSenderAddress } from './sender-identity.js';
import { addressVariants, canonicalAddress, canonicalDomain } from './idn.js';

export interface MailFlowSettings {
  hiddenFromGal: boolean;
  forwardTo: string | null;
  forwardKeepCopy: boolean;
  acceptFrom: string[];
  rejectFrom: string[];
  maxSendSizeMb: number | null;
  maxReceiveSizeMb: number | null;
  maxRecipients: number | null;
  /** 10.5: outgoing messages per sliding hour (submission-rate.ts); null = global. */
  maxMessagesPerHour: number | null;
  /** 10.5: outgoing recipients per sliding hour (submission-rate.ts); null = global. */
  maxRecipientsPerHour: number | null;
}

export const DEFAULT_MAIL_FLOW: Readonly<MailFlowSettings> = Object.freeze({
  hiddenFromGal: false,
  forwardTo: null,
  forwardKeepCopy: true,
  acceptFrom: [],
  rejectFrom: [],
  maxSendSizeMb: null,
  maxReceiveSizeMb: null,
  maxRecipients: null,
  maxMessagesPerHour: null,
  maxRecipientsPerHour: null,
});

/** The mailbox a policy belongs to. */
export type MailFlowOwner = { userId: string } | { sharedMailboxId: string };

/** Most entries per sender list. */
export const MAX_SENDER_LIST_ENTRIES = 500;
/** Upper bounds of the per-mailbox limits (sanity, not policy). */
export const MAX_FLOW_SIZE_MB = 2048;
export const MAX_FLOW_RECIPIENTS = 10_000;
/** 10.5: upper bounds of the per-mailbox hourly send rate (sanity, not policy). */
export const MAX_FLOW_MESSAGES_PER_HOUR = 100_000;
export const MAX_FLOW_RECIPIENTS_PER_HOUR = 1_000_000;

// Prisma filter for directory listings: pure module, shared with folder-grantees.ts.
export { GAL_VISIBLE_WHERE } from './gal-visible.js';

// ─── Pure rules ──────────────────────────────────────────────────────────────

/** Pure: the policy of a stored row (defaults when there is none). */
export function mailFlowFromRow(row: Partial<MailFlowSettings> | null | undefined): MailFlowSettings {
  if (!row) return { ...DEFAULT_MAIL_FLOW, acceptFrom: [], rejectFrom: [] };
  return {
    hiddenFromGal: row.hiddenFromGal === true,
    forwardTo: row.forwardTo ? row.forwardTo.toLowerCase() : null,
    forwardKeepCopy: row.forwardKeepCopy !== false,
    acceptFrom: [...(row.acceptFrom ?? [])],
    rejectFrom: [...(row.rejectFrom ?? [])],
    maxSendSizeMb: row.maxSendSizeMb ?? null,
    maxReceiveSizeMb: row.maxReceiveSizeMb ?? null,
    maxRecipients: row.maxRecipients ?? null,
    maxMessagesPerHour: row.maxMessagesPerHour ?? null,
    maxRecipientsPerHour: row.maxRecipientsPerHour ?? null,
  };
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** Pure: a lower-case DNS domain name with at least two labels (a.example). */
export function isDomainName(value: string): boolean {
  if (value.length > 253) return false;
  const labels = value.split('.');
  return labels.length >= 2 && labels.every((l) => LABEL.test(l) || /^xn--[a-z0-9-]{1,59}$/.test(l));
}

/** Pure: a plain mailbox address (local@domain), lower case. */
export function isMailAddress(value: string): boolean {
  const at = value.lastIndexOf('@');
  if (at <= 0 || at > 64 || value.length > 254) return false;
  const local = value.slice(0, at);
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) && !local.startsWith('.') && !local.endsWith('.') && isDomainName(value.slice(at + 1));
}

/**
 * Pure: one sender-list entry in its stored form — an address
 * ("user@example.org") or a domain ("example.org"; "@example.org" is
 * accepted as input), lower case, an internationalized domain as A-label
 * ("bücher.example" → "xn--bcher-kva.example"). null when invalid.
 */
export function normalizeSenderPattern(entry: string): string | null {
  const v = entry.trim().toLowerCase().replace(/^@/, '');
  if (!v) return null;
  if (v.includes('@')) {
    const address = canonicalAddress(v);
    return isMailAddress(address) ? address : null;
  }
  const domain = canonicalDomain(v);
  return isDomainName(domain) ? domain : null;
}

export type SenderListResult = { ok: true; values: string[] } | { ok: false; invalid: string[] };

/** Pure: validates and normalizes a sender list (deduplicated, order kept). */
export function parseSenderList(entries: readonly string[]): SenderListResult {
  if (entries.length > MAX_SENDER_LIST_ENTRIES) return { ok: false, invalid: [`more than ${MAX_SENDER_LIST_ENTRIES} entries`] };
  const values: string[] = [];
  const invalid: string[] = [];
  for (const e of entries) {
    const n = normalizeSenderPattern(e);
    if (n === null) invalid.push(e);
    else if (!values.includes(n)) values.push(n);
  }
  return invalid.length ? { ok: false, invalid } : { ok: true, values };
}

/**
 * Pure: does a sender address match a list entry? An address entry matches
 * exactly; a domain entry matches that domain and its subdomains. Both sides
 * are compared in canonical form (lower case, domain as A-label), so the
 * Unicode and the punycode spelling of an internationalized domain match.
 */
export function senderMatches(pattern: string, address: string): boolean {
  const a = canonicalAddress(normalizeSenderAddress(address));
  if (!a) return false;
  if (pattern.includes('@')) return a === canonicalAddress(pattern);
  const p = canonicalDomain(pattern);
  const domain = a.slice(a.lastIndexOf('@') + 1);
  return domain === p || domain.endsWith(`.${p}`);
}

export const SENDER_REFUSED_REPLY = '550 5.7.1 Recipient does not accept mail from this sender';
export const SIZE_REFUSED_REPLY_PREFIX = '552 5.2.3 Message exceeds the size limit of the recipient';

/**
 * Pure: may mail from these senders (envelope sender and header From:) reach a
 * mailbox with this policy? Returns the SMTP reply when refused, else null.
 *
 *  - reject-from: refused when any known sender matches an entry;
 *  - accept-only-from (non-empty): every known sender must match an entry, and
 *    a message without any sender (null reverse-path, no From:) is refused.
 */
export function senderRefusal(policy: Pick<MailFlowSettings, 'acceptFrom' | 'rejectFrom'>, senders: ReadonlyArray<string | null | undefined>): string | null {
  const known = [...new Set(senders.map((s) => normalizeSenderAddress(s ?? '')).filter(Boolean))];
  if (known.some((s) => policy.rejectFrom.some((p) => senderMatches(p, s)))) return SENDER_REFUSED_REPLY;
  if (policy.acceptFrom.length > 0) {
    if (known.length === 0) return SENDER_REFUSED_REPLY;
    if (!known.every((s) => policy.acceptFrom.some((p) => senderMatches(p, s)))) return SENDER_REFUSED_REPLY;
  }
  return null;
}

/** Pure: the receive-size refusal of a message of `sizeBytes`, or null. */
export function receiveSizeRefusal(policy: Pick<MailFlowSettings, 'maxReceiveSizeMb'>, sizeBytes: number): string | null {
  const mb = policy.maxReceiveSizeMb;
  if (mb === null || mb <= 0) return null;
  return sizeBytes > mb * 1024 * 1024 ? `${SIZE_REFUSED_REPLY_PREFIX} (${mb} MB)` : null;
}

export interface DeliveryFacts {
  envelopeFrom: string | null;
  headerFrom: string | null;
  sizeBytes: number;
  /**
   * A notice this server generates for the mailbox itself (delivery status
   * notifications to a local sender, dead-letter notices to admins). Internal
   * flag of the delivery call — never derived from the message.
   */
  systemNotice?: boolean;
}

/**
 * Pure: why a local delivery is refused by the recipient's policy (SMTP reply),
 * or null. The server's own notices are never refused: a mailbox that accepts
 * only some senders still gets the NDRs of its own mail.
 */
export function deliveryRefusal(policy: MailFlowSettings, facts: DeliveryFacts): string | null {
  if (facts.systemNotice) return null;
  return senderRefusal(policy, [facts.envelopeFrom, facts.headerFrom]) ?? receiveSizeRefusal(policy, facts.sizeBytes);
}

/**
 * Pure: the RCPT-stage refusal (envelope sender only). A null reverse-path is
 * judged at DATA / delivery, where the header From: is known — accept-only-from
 * refuses a message only when no sender at all (neither envelope nor From:) is
 * on the list.
 */
export function rcptStageRefusal(policy: Pick<MailFlowSettings, 'acceptFrom' | 'rejectFrom'>, envelopeFrom: string | null): string | null {
  return envelopeFrom ? senderRefusal(policy, [envelopeFrom]) : null;
}

export interface SendLimits { maxBytes: number; maxRecipients: number }

/** Pure: the sender's limits — a per-mailbox value replaces the global one. */
export function effectiveSendLimits(policy: Pick<MailFlowSettings, 'maxSendSizeMb' | 'maxRecipients'>, global: SendLimits): SendLimits {
  return {
    maxBytes: policy.maxSendSizeMb !== null && policy.maxSendSizeMb > 0 ? policy.maxSendSizeMb * 1024 * 1024 : global.maxBytes,
    maxRecipients: policy.maxRecipients !== null && policy.maxRecipients > 0 ? policy.maxRecipients : global.maxRecipients,
  };
}

export type SendLimitVerdict = { ok: true } | { ok: false; kind: 'size' | 'recipients'; limit: number };

/** Pure: does a message of `sizeBytes` to `recipients` addresses fit the limits? */
export function checkSendLimitsPure(limits: SendLimits, sizeBytes: number, recipients: number): SendLimitVerdict {
  if (recipients > limits.maxRecipients) return { ok: false, kind: 'recipients', limit: limits.maxRecipients };
  if (sizeBytes > limits.maxBytes) return { ok: false, kind: 'size', limit: limits.maxBytes };
  return { ok: true };
}

/** Pure: the first From: address of a raw message (lower case), or null. */
export function headerFromAddress(raw: Buffer): string | null {
  const s = raw.subarray(0, Math.min(raw.length, 256 * 1024)).toString('latin1');
  const fields = parseHeaderFields(s, 0, findBodyStart(s, 0, s.length));
  const from = fields.find((f) => f.name.toLowerCase() === 'from');
  const first = from ? addressesOf(from.value)[0] : undefined;
  return first ? normalizeSenderAddress(first) : null;
}

// ─── Database ────────────────────────────────────────────────────────────────

const POLICY_SELECT = {
  hiddenFromGal: true, forwardTo: true, forwardKeepCopy: true, acceptFrom: true, rejectFrom: true,
  maxSendSizeMb: true, maxReceiveSizeMb: true, maxRecipients: true,
  maxMessagesPerHour: true, maxRecipientsPerHour: true,
} as const;

function ownerWhere(owner: MailFlowOwner): { userId: string } | { sharedMailboxId: string } {
  return 'userId' in owner ? { userId: owner.userId } : { sharedMailboxId: owner.sharedMailboxId };
}

/** The policy of one mailbox (defaults when no row exists). */
export async function loadMailFlowPolicy(owner: MailFlowOwner): Promise<MailFlowSettings> {
  const row = await prisma.mailFlowPolicy.findUnique({ where: ownerWhere(owner) as never, select: POLICY_SELECT });
  return mailFlowFromRow(row);
}

/** Writes (creates or replaces) the policy of one mailbox. */
export async function saveMailFlowPolicy(owner: MailFlowOwner, policy: MailFlowSettings): Promise<MailFlowSettings> {
  const data = { ...policy, acceptFrom: [...policy.acceptFrom], rejectFrom: [...policy.rejectFrom] };
  const row = await prisma.mailFlowPolicy.upsert({
    where: ownerWhere(owner) as never,
    create: { ...ownerWhere(owner), ...data },
    update: data,
    select: POLICY_SELECT,
  });
  return mailFlowFromRow(row);
}

/**
 * The policy of the mailbox a (canonical) recipient address delivers to: an
 * active user, Shared Mailbox or an active alias of either. null when the
 * address is no such mailbox (resource mailboxes, postmaster, unknown). An
 * internationalized domain matches in either spelling (A-label / U-label).
 */
export async function mailFlowForRecipient(address: string): Promise<{ owner: MailFlowOwner; policy: MailFlowSettings } | null> {
  const spellings = addressVariants(address.trim().toLowerCase());
  const [user, shared, alias] = await Promise.all([
    prisma.user.findFirst({ where: { email: { in: spellings }, active: true }, select: { id: true } }),
    prisma.sharedMailbox.findFirst({ where: { email: { in: spellings }, active: true }, select: { id: true } }),
    prisma.emailAlias.findFirst({ where: { address: { in: spellings }, active: true }, select: { targetUserId: true, targetSharedId: true } }),
  ]);
  const owner: MailFlowOwner | null = user ? { userId: user.id }
    : shared ? { sharedMailboxId: shared.id }
      : alias?.targetUserId ? { userId: alias.targetUserId }
        : alias?.targetSharedId ? { sharedMailboxId: alias.targetSharedId }
          : null;
  if (!owner) return null;
  return { owner, policy: await loadMailFlowPolicy(owner) };
}

/** RCPT-stage check ({@link rcptStageRefusal}): the refusal reply for this recipient, or null. */
export async function recipientSenderRefusal(recipient: string, envelopeFrom: string | null): Promise<string | null> {
  if (!envelopeFrom) return null;
  const found = await mailFlowForRecipient(recipient);
  return found ? rcptStageRefusal(found.policy, envelopeFrom) : null;
}

/**
 * {@link checkSendLimitsPure} with the user's policy over the given global limits —
 * for the SMTP listener, which enforces its own SIZE / RCPT limits. Every other
 * submission path uses submission-limits.ts `checkSubmissionLimits` (global + policy).
 */
export async function checkUserSendLimits(userId: string, global: SendLimits, sizeBytes: number, recipients: number): Promise<SendLimitVerdict> {
  return checkSendLimitsPure(effectiveSendLimits(await loadMailFlowPolicy({ userId }), global), sizeBytes, recipients);
}
