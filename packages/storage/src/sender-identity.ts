/**
 * Sender identity policy for client submission paths (ActiveSync, JMAP, …).
 *
 * Mirrors the rule of SMTP submission (smtp-server/src/submission/handler.ts
 * `checkSenderPermission`): an authenticated user may send as
 *   1. their own primary address,
 *   2. an active alias that points to their own mailbox,
 *   3. a Shared Mailbox (primary address or active alias) on which they hold
 *      SEND_AS or FULL_ACCESS.
 * Anything else is spoofing and must be rejected.
 */
import { prisma } from './prisma/index.js';
import { findBodyStart, parseHeaderFields } from './mime/tree.js';
import { addressesOf } from './mime/address.js';

/** Lower-case and strip angle brackets/whitespace from an address. */
export function normalizeSenderAddress(address: string): string {
  return address.trim().replace(/^<|>$/g, '').trim().toLowerCase();
}

/** Pure: is `address` one of the allowed sender addresses? */
export function isSenderAddressAllowed(address: string, allowed: Iterable<string>): boolean {
  const wanted = normalizeSenderAddress(address);
  if (!wanted) return false;
  for (const a of allowed) {
    if (normalizeSenderAddress(a) === wanted) return true;
  }
  return false;
}

/**
 * All addresses `userId` may use as From / envelope sender. Empty for
 * unknown or deactivated users.
 */
export async function listAllowedSenderAddresses(userId: string): Promise<string[]> {
  const user = await prisma.user.findFirst({
    where:  { id: userId, active: true },
    select: { email: true },
  });
  if (!user) return [];

  const [ownAliases, perms] = await Promise.all([
    prisma.emailAlias.findMany({
      where:  { targetUserId: userId, active: true },
      select: { address: true },
    }),
    prisma.sharedMailboxPerm.findMany({
      where: {
        userId,
        permission:    { in: ['FULL_ACCESS', 'SEND_AS'] },
        sharedMailbox: { active: true },
      },
      select: {
        sharedMailbox: {
          select: {
            email:   true,
            aliases: { where: { active: true }, select: { address: true } },
          },
        },
      },
    }),
  ]);

  const out = new Set<string>([normalizeSenderAddress(user.email)]);
  for (const a of ownAliases) out.add(normalizeSenderAddress(a.address));
  for (const p of perms) {
    out.add(normalizeSenderAddress(p.sharedMailbox.email));
    for (const a of p.sharedMailbox.aliases) out.add(normalizeSenderAddress(a.address));
  }
  return [...out];
}

/**
 * Shared Mailbox addresses `userId` may put into From: when the message carries
 * the user's own address in Sender: (SEND_ON_BEHALF, RFC 5322 §3.6.2).
 */
export async function listOnBehalfSenderAddresses(userId: string): Promise<string[]> {
  const perms = await prisma.sharedMailboxPerm.findMany({
    where: { userId, permission: { in: ['SEND_ON_BEHALF'] }, sharedMailbox: { active: true } },
    select: {
      sharedMailbox: {
        select: { email: true, aliases: { where: { active: true }, select: { address: true } } },
      },
    },
  });
  const out = new Set<string>();
  for (const p of perms) {
    out.add(normalizeSenderAddress(p.sharedMailbox.email));
    for (const a of p.sharedMailbox.aliases) out.add(normalizeSenderAddress(a.address));
  }
  return [...out];
}

export interface HeaderSenderVerdict {
  ok: boolean;
  /** Human-readable reason when !ok. */
  reason?: string;
}

/**
 * Pure: may a message with these header fields be submitted by a user whose
 * allowed sender addresses are `allowed`?
 *
 *  - at most one From: and one Sender: field (RFC 5322 §3.6);
 *  - every From: address must be allowed, or — for SEND_ON_BEHALF — be in
 *    `onBehalf` while Sender: names an allowed (own) address;
 *  - a Sender: field must name exactly one allowed address;
 *  - a message without From: passes (nothing is claimed; the envelope sender
 *    was checked at MAIL FROM).
 */
export function evaluateHeaderSenders(
  raw: Buffer,
  allowed: Iterable<string>,
  onBehalf: Iterable<string> = [],
): HeaderSenderVerdict {
  const s = raw.toString('latin1');
  const fields = parseHeaderFields(s, 0, findBodyStart(s, 0, s.length));
  const named = (n: string): string[] => fields.filter((f) => f.name.toLowerCase() === n).map((f) => f.value);
  const froms = named('from');
  const senders = named('sender');
  if (froms.length > 1) return { ok: false, reason: 'multiple From header fields' };
  if (senders.length > 1) return { ok: false, reason: 'multiple Sender header fields' };

  const allowedSet = new Set([...allowed].map(normalizeSenderAddress));
  const onBehalfSet = new Set([...onBehalf].map(normalizeSenderAddress));

  let senderOk = false;
  if (senders.length === 1) {
    const addrs = addressesOf(senders[0] ?? '');
    if (addrs.length !== 1) return { ok: false, reason: 'Sender must contain exactly one address' };
    if (!allowedSet.has(normalizeSenderAddress(addrs[0] ?? ''))) {
      return { ok: false, reason: `Sender address <${addrs[0]}> not allowed` };
    }
    senderOk = true;
  }
  if (froms.length === 0) return { ok: true };
  const fromAddrs = addressesOf(froms[0] ?? '');
  if (fromAddrs.length === 0) return { ok: false, reason: 'From contains no address' };
  for (const a of fromAddrs) {
    const n = normalizeSenderAddress(a);
    if (allowedSet.has(n)) continue;
    if (senderOk && onBehalfSet.has(n)) continue;
    return { ok: false, reason: `From address <${a}> not allowed` };
  }
  return { ok: true };
}

/**
 * Pure (9.4 review): the header check plus the envelope sender. The envelope
 * sender must be an allowed address — or, for SEND_ON_BEHALF, an on-behalf
 * address while the Sender: field names an allowed (own) address. A null
 * envelope sender is never a user's submission.
 */
export function evaluateSubmissionSender(
  raw: Buffer,
  envelopeFrom: string,
  allowed: Iterable<string>,
  onBehalf: Iterable<string> = [],
): HeaderSenderVerdict {
  const allowedList = [...allowed];
  const onBehalfList = [...onBehalf];
  const header = evaluateHeaderSenders(raw, allowedList, onBehalfList);
  if (!header.ok) return header;
  if (isSenderAddressAllowed(envelopeFrom, allowedList)) return { ok: true };
  if (isSenderAddressAllowed(envelopeFrom, onBehalfList) && hasAllowedSenderField(raw, allowedList)) return { ok: true };
  return { ok: false, reason: `Envelope sender <${normalizeSenderAddress(envelopeFrom)}> not allowed` };
}

/** Pure: the message has one Sender: field naming exactly one allowed address. */
function hasAllowedSenderField(raw: Buffer, allowed: readonly string[]): boolean {
  const s = raw.toString('latin1');
  const senders = parseHeaderFields(s, 0, findBodyStart(s, 0, s.length)).filter((f) => f.name.toLowerCase() === 'sender');
  if (senders.length !== 1) return false;
  const addrs = addressesOf(senders[0]!.value);
  return addrs.length === 1 && isSenderAddressAllowed(addrs[0]!, allowed);
}

/**
 * {@link evaluateSubmissionSender} with the user's current rights from the
 * database — used again when a scheduled / held message is finally sent, so
 * revoked send-as / on-behalf rights or a deactivated account stop it.
 */
export async function checkSubmissionSenderIdentity(raw: Buffer, envelopeFrom: string, userId: string): Promise<HeaderSenderVerdict> {
  const [allowed, onBehalf] = await Promise.all([
    listAllowedSenderAddresses(userId),
    listOnBehalfSenderAddresses(userId),
  ]);
  if (allowed.length === 0) return { ok: false, reason: 'unknown or inactive user' };
  return evaluateSubmissionSender(raw, envelopeFrom, allowed, onBehalf);
}

/** {@link evaluateHeaderSenders} with the user's allowed + on-behalf addresses from the database. */
export async function checkHeaderSenderIdentity(raw: Buffer, userId: string): Promise<HeaderSenderVerdict> {
  const [allowed, onBehalf] = await Promise.all([
    listAllowedSenderAddresses(userId),
    listOnBehalfSenderAddresses(userId),
  ]);
  if (allowed.length === 0) return { ok: false, reason: 'unknown or inactive user' };
  return evaluateHeaderSenders(raw, allowed, onBehalf);
}
