/**
 * EmailSubmission sender check (RFC 8621 §7.5 forbiddenFrom / invalidEmail).
 *
 * Same policy as SMTP submission (storage/src/sender-identity.ts): every From:
 * address and the Sender: address must be one the authenticated user may send as
 * (own address, own aliases, Shared Mailboxes with SEND_AS/FULL_ACCESS; From may
 * name a SEND_ON_BEHALF mailbox when Sender: is the user's own address).
 * Stricter than SMTP in one point: a message without a usable From: is rejected
 * (invalidEmail) — never skipped — and the chosen identity must appear in From
 * (or, on behalf, in Sender).
 */
import {
  addressesOf, evaluateHeaderSenders, findBodyStart, isSenderAddressAllowed, listAllowedSenderAddresses,
  listOnBehalfSenderAddresses, normalizeSenderAddress, parseHeaderFields,
} from '@coremail/storage';

export type SenderVerdict =
  | { ok: true }
  | { ok: false; type: 'forbiddenFrom' | 'invalidEmail'; description: string };

const ADDR = /^[^@\s]+@[^@\s]+$/;

/** Pure check over the raw message and the user's allowed sender addresses. */
export function checkSubmissionSenders(
  raw: Buffer,
  identityEmail: string,
  allowed: Iterable<string>,
  onBehalf: Iterable<string> = [],
): SenderVerdict {
  const s = raw.toString('latin1');
  const fields = parseHeaderFields(s, 0, findBodyStart(s, 0, s.length));
  const values = (n: string): string[] => fields.filter((f) => f.name.toLowerCase() === n).map((f) => f.value);
  const froms = values('from');
  const senders = values('sender');
  if (froms.length === 0) return { ok: false, type: 'invalidEmail', description: 'From header field missing' };
  if (froms.length > 1) return { ok: false, type: 'invalidEmail', description: 'multiple From header fields' };
  if (senders.length > 1) return { ok: false, type: 'invalidEmail', description: 'multiple Sender header fields' };
  const fromAddrs = addressesOf(froms[0]!);
  if (fromAddrs.length === 0 || !fromAddrs.every((a) => ADDR.test(a))) {
    return { ok: false, type: 'invalidEmail', description: 'From contains no valid address' };
  }
  const senderAddrs = senders.length ? addressesOf(senders[0]!) : [];
  if (senders.length && (senderAddrs.length !== 1 || !ADDR.test(senderAddrs[0]!))) {
    return { ok: false, type: 'invalidEmail', description: 'Sender must contain exactly one valid address' };
  }

  const verdict = evaluateHeaderSenders(raw, allowed, onBehalf);
  if (!verdict.ok) return { ok: false, type: 'forbiddenFrom', description: verdict.reason ?? 'sender not allowed' };

  const identity = normalizeSenderAddress(identityEmail);
  const claimed = [...fromAddrs, ...senderAddrs].map(normalizeSenderAddress);
  if (!claimed.includes(identity)) {
    return { ok: false, type: 'forbiddenFrom', description: `identity ${identityEmail} is neither in From nor in Sender` };
  }
  return { ok: true };
}

export type EnvelopeVerdict =
  | { ok: true; mailFrom: string; domain: string }
  | { ok: false; type: 'forbiddenMailFrom'; description: string };

/**
 * Envelope sender (MAIL FROM) check — the SMTP submission rule
 * (smtp-server checkSenderPermission → storage isSenderAddressAllowed):
 *  - the null reverse-path `<>` is refused (it is reserved for bounces/DSNs;
 *    SMTP submission refuses it as well),
 *  - the address must be a syntactically valid mailbox,
 *  - it must equal the chosen identity's address, and
 *  - it must be one of the addresses the user may send as.
 * The returned `domain` comes from the verified address only and is the one
 * that may be used for the DKIM key lookup.
 */
export function checkEnvelopeMailFrom(
  mailFrom: string,
  identityEmail: string,
  allowed: Iterable<string>,
): EnvelopeVerdict {
  const addr = normalizeSenderAddress(mailFrom);
  if (!addr) return { ok: false, type: 'forbiddenMailFrom', description: 'null reverse-path is not allowed for submission' };
  if (!ADDR.test(addr) || addr.indexOf('@') !== addr.lastIndexOf('@')) {
    return { ok: false, type: 'forbiddenMailFrom', description: 'envelope mailFrom is not a valid address' };
  }
  if (addr !== normalizeSenderAddress(identityEmail)) {
    return { ok: false, type: 'forbiddenMailFrom', description: 'envelope mailFrom must equal identity email' };
  }
  if (!isSenderAddressAllowed(addr, allowed)) {
    return { ok: false, type: 'forbiddenMailFrom', description: `not allowed to send as ${addr}` };
  }
  return { ok: true, mailFrom: addr, domain: addr.slice(addr.indexOf('@') + 1) };
}

/** {@link checkSubmissionSenders} with the user's addresses from the database. */
export async function checkSubmissionSendersFor(raw: Buffer, identityEmail: string, userId: string): Promise<SenderVerdict> {
  const [allowed, onBehalf] = await Promise.all([listAllowedSenderAddresses(userId), listOnBehalfSenderAddresses(userId)]);
  if (allowed.length === 0) return { ok: false, type: 'forbiddenFrom', description: 'unknown or inactive user' };
  return checkSubmissionSenders(raw, identityEmail, allowed, onBehalf);
}
