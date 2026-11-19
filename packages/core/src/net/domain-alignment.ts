/**
 * Relaxed domain alignment as DMARC defines it (RFC 7489 §3.1 / §3.2): two
 * domains are aligned when they are equal or share the same Organizational
 * Domain — the registrable domain one label below the longest matching entry
 * of the Public Suffix List.
 *
 * Every relaxed-alignment decision in CoreMail (local-spoof checks, sender-list
 * allow entries, iTIP/iMIP replies) goes through this
 * module, so a domain under a public suffix never vouches for a different
 * registrable domain: `evil.co.uk` is not aligned with `co.uk`, and
 * `a.github.io` is not aligned with `b.github.io`.
 *
 * Rules:
 *  - The list is the full Public Suffix List including its PRIVATE section
 *    (github.io, blogspot.com, …) — the same data and options mailauth uses
 *    for its DMARC verdicts, so a domain counts as authenticated here exactly
 *    when DMARC would consider it aligned.
 *  - Unknown TLDs fall back to the PSL default rule "*": the last label is the
 *    public suffix (`corp.test` → Organizational Domain `corp.test`).
 *  - Names are compared in canonical form: lower case, one trailing dot
 *    removed, internationalized labels as A-labels (punycode).
 *  - A public suffix itself has no Organizational Domain; it is aligned only
 *    with exactly the same name. IP literals (`1.2.3.4`, `[IPv6:::1]`) and
 *    malformed names are likewise aligned only on exact equality.
 */
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { getDomain } from 'tldts';

/** Same options mailauth passes to tldts for DMARC (ICANN + private section). */
const PSL_OPTIONS = {
  allowIcannDomains: true,
  allowPrivateDomains: true,
  extractHostname: false,
  validateHostname: true,
} as const;

const MAX_DOMAIN_LENGTH = 253;
/** One A-label: letters, digits, hyphen, underscore (DKIM selectors/SRV-style names), 1–63 chars. */
const LABEL = /^[a-z0-9_-]{1,63}$/;
const URL_SYNTAX = /[\s/\\?#@:%[\]]/;

/** Pure: canonical address literal (`1.2.3.4`, `::1`) or null when `value` is none. */
function ipLiteral(value: string): string | null {
  let s = value.trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (s.startsWith('ipv6:')) s = s.slice(5);
  return isIP(s) ? s : null;
}

/**
 * Pure: canonical form of a DNS domain name — lower case, without one trailing
 * dot, with A-labels. Null for an empty, malformed or IP-literal value.
 */
export function canonicalDomainName(value: string): string | null {
  const trimmed = value.trim();
  const withoutDot = trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
  // URL syntax would otherwise be parsed away by the host parser ("a.example/x" → "a.example")
  if (!withoutDot || URL_SYNTAX.test(withoutDot) || ipLiteral(withoutDot)) return null;
  const ascii = domainToASCII(withoutDot);
  if (!ascii || ascii.length > MAX_DOMAIN_LENGTH) return null;
  return ascii.split('.').every((l) => LABEL.test(l)) ? ascii : null;
}

/**
 * Pure: the Organizational Domain of `domain` (RFC 7489 §3.2) in canonical
 * form, or null when the name is a public suffix itself, an IP literal or
 * malformed.
 */
export function organizationalDomain(domain: string): string | null {
  const canonical = canonicalDomainName(domain);
  if (!canonical) return null;
  return getDomain(canonical, PSL_OPTIONS);
}

/** Pure: canonical comparison key for exact matches (domain name or IP literal). */
function exactKey(value: string): string | null {
  return ipLiteral(value) ?? canonicalDomainName(value);
}

/**
 * Pure: DMARC relaxed alignment — equal (canonical form), or both names have
 * the same Organizational Domain. Symmetric.
 */
export function domainsAlignedRelaxed(a: string, b: string): boolean {
  const x = exactKey(a);
  const y = exactKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const orgX = organizationalDomain(x);
  return orgX !== null && orgX === organizationalDomain(y);
}

/** Pure: is `domain` aligned with at least one of the authenticated domains? */
export function isAlignedWithAny(domain: string, authenticatedDomains: readonly string[]): boolean {
  return authenticatedDomains.some((d) => domainsAlignedRelaxed(domain, d));
}
