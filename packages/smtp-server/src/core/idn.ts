/**
 * Internationalized addresses (RFC 6531 SMTPUTF8, IDNA 2008 A-/U-labels).
 *
 * Pure helpers: the checks the relay needs to decide whether a transaction
 * requires SMTPUTF8 at the next hop. Domain form conversion (punycode ↔
 * Unicode) is the shared storage helper (@coremail/storage/idn).
 */
import { domainToAsciiForm } from '@coremail/storage/idn';

export { domainToAsciiForm, domainToUnicodeForm, domainVariants, addressVariants } from '@coremail/storage/idn';

/** True when the string contains anything outside US-ASCII. */
export function isNonAscii(text: string): boolean {
  return /[^\x00-\x7f]/.test(text);
}

function splitAddress(addr: string): { local: string; domain: string } | null {
  const at = addr.lastIndexOf('@');
  if (at <= 0 || at === addr.length - 1) return null;
  return { local: addr.slice(0, at), domain: addr.slice(at + 1) };
}

/**
 * Wire form for an SMTP envelope: the domain as A-label (an IDN domain never
 * needs SMTPUTF8 by itself, RFC 6531 §3.2); the local-part is unchanged.
 */
export function toAsciiDomainAddress(addr: string): string {
  const parts = splitAddress(addr);
  if (!parts || !isNonAscii(parts.domain)) return addr;
  const ascii = domainToAsciiForm(parts.domain);
  return ascii ? `${parts.local}@${ascii}` : addr;
}

/**
 * RFC 6531 §3.2: after converting domains to A-labels, an envelope still needs
 * SMTPUTF8 when an address has a non-ASCII local-part.
 */
export function envelopeNeedsSmtputf8(from: string, to: string[]): boolean {
  return [from, ...to].some((a) => isNonAscii(toAsciiDomainAddress(a)));
}
