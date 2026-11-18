/**
 * Internationalized domain names in addresses (IDNA 2008 A-/U-labels) — the one
 * shared helper for every address comparison (9.4 review).
 *
 * An admin may enter a domain as U-label (`bücher.example`) or A-label
 * (`xn--bcher-kva.example`), and a sender or recipient may use either spelling.
 * Comparisons therefore use the canonical form: lower case, domain as A-label.
 * Pure module (no database), also loaded by the smtp-server test stub.
 */
import { domainToASCII, domainToUnicode } from 'node:url';

function splitAddress(addr: string): { local: string; domain: string } | null {
  const at = addr.lastIndexOf('@');
  if (at <= 0 || at === addr.length - 1) return null;
  return { local: addr.slice(0, at), domain: addr.slice(at + 1) };
}

/** A-label (punycode) form of a domain, lower case; '' when it is not a valid IDN. */
export function domainToAsciiForm(domain: string): string {
  if (domain.startsWith('[')) return domain; // address literal
  return domainToASCII(domain).toLowerCase();
}

/** U-label (Unicode) form of a domain; the lower-cased input when it cannot be converted. */
export function domainToUnicodeForm(domain: string): string {
  if (domain.startsWith('[')) return domain;
  const ascii = domainToASCII(domain);
  if (!ascii) return domain.toLowerCase();
  return domainToUnicode(ascii).toLowerCase() || domain.toLowerCase();
}

/**
 * Both spellings of a domain (A-label and U-label), lower-cased, deduplicated.
 * Used for database lookups: an admin may have entered either.
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

/** Every spelling of an address (local-part unchanged, domain in both forms), lower case. */
export function addressVariants(addr: string): string[] {
  const parts = splitAddress(addr);
  if (!parts) return [addr.toLowerCase()];
  return domainVariants(parts.domain).map((d) => `${parts.local}@${d}`.toLowerCase());
}

/**
 * Canonical domain for comparisons: lower-case A-label. A domain that is no
 * valid IDN as a whole (a wildcard pattern such as `*.bücher.example`) is
 * converted label by label; a label that cannot be converted stays lower-cased.
 */
export function canonicalDomain(domain: string): string {
  const lower = domain.trim().toLowerCase().replace(/\.$/, '');
  if (!lower) return lower;
  const whole = domainToAsciiForm(lower);
  if (whole) return whole;
  return lower.split('.').map((label) => (label.includes('*') || !label ? label : domainToASCII(label).toLowerCase() || label)).join('.');
}

/**
 * Canonical form of an address pattern (sender lists: exact address, `*@domain`
 * or a glob): lower case, the part after the last `@` as A-labels.
 */
export function canonicalAddressPattern(pattern: string): string {
  const lower = pattern.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  return at >= 0 ? `${lower.slice(0, at)}@${canonicalDomain(lower.slice(at + 1))}` : lower;
}

/**
 * Canonical address for comparisons: angle brackets and whitespace removed,
 * lower case, domain as A-label. A value without `@` is returned lower-cased.
 */
export function canonicalAddress(addr: string): string {
  const bare = addr.trim().replace(/^<|>$/g, '').trim().toLowerCase();
  const parts = splitAddress(bare);
  return parts ? `${parts.local}@${canonicalDomain(parts.domain)}` : bare;
}
