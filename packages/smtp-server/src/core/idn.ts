/**
 * Internationalized addresses (RFC 6531 SMTPUTF8, IDNA 2008 A-/U-labels).
 *
 * Pure helpers: domain form conversion (punycode ↔ Unicode) and the checks the
 * relay needs to decide whether a transaction requires SMTPUTF8 at the next hop.
 */
import { domainToASCII, domainToUnicode } from 'node:url';

/** True when the string contains anything outside US-ASCII. */
export function isNonAscii(text: string): boolean {
  return /[^\x00-\x7f]/.test(text);
}

function splitAddress(addr: string): { local: string; domain: string } | null {
  const at = addr.lastIndexOf('@');
  if (at <= 0 || at === addr.length - 1) return null;
  return { local: addr.slice(0, at), domain: addr.slice(at + 1) };
}

/** A-label (punycode) form of a domain; '' when it is not a valid IDN. */
export function domainToAsciiForm(domain: string): string {
  if (domain.startsWith('[')) return domain; // address literal
  return domainToASCII(domain).toLowerCase();
}

/** U-label (Unicode) form of a domain; the input when it cannot be converted. */
export function domainToUnicodeForm(domain: string): string {
  if (domain.startsWith('[')) return domain;
  const ascii = domainToASCII(domain);
  if (!ascii) return domain.toLowerCase();
  return domainToUnicode(ascii).toLowerCase() || domain.toLowerCase();
}

/**
 * Both spellings of a domain (A-label and U-label), lower-cased, deduplicated.
 * Used for local-domain and mailbox lookups: an admin may have entered either.
 */
export function domainVariants(domain: string): string[] {
  const lower = domain.toLowerCase();
  const out = new Set<string>([lower]);
  const ascii = domainToAsciiForm(lower);
  if (ascii) out.add(ascii);
  const unicode = domainToUnicodeForm(lower);
  if (unicode) out.add(unicode);
  return [...out];
}

/** Every spelling of an address (local-part unchanged, domain in both forms). */
export function addressVariants(addr: string): string[] {
  const parts = splitAddress(addr);
  if (!parts) return [addr.toLowerCase()];
  return domainVariants(parts.domain).map((d) => `${parts.local}@${d}`.toLowerCase());
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
