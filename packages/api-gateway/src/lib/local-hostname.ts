/**
 * Local / private host names (10.5, docs/setup-wizard.md "Local domain first").
 *
 * The first-run wizard sets CoreMail up with a local domain (example.local) and
 * a self-signed certificate; the real public domain is added later in the BCP.
 * A host name counts as local / private when no public CA can issue for it and
 * no public DNS points at it:
 *   - a bare IPv4 or IPv6 address (optionally bracketed, with a port),
 *   - a single label (localhost, intranet names),
 *   - a name under one of LOCAL_HOSTNAME_SUFFIXES.
 *
 * Pure, no imports. Three identical copies — keep them in step (the parity
 * test in api-gateway src/lib/local-hostname.test.ts compares them):
 *   packages/api-gateway/src/lib/local-hostname.ts   (setup-state card, make-primary)
 *   packages/web-client/src/lib/localHostname.ts     (setup wizard hints)
 *   packages/admin-panel/src/lib/localHostname.ts    (dashboard certificate card)
 */

/** Suffixes of private / reserved names (RFC 6762 .local, RFC 8375 .home.arpa, RFC 2606 .test/.localhost, common LAN names). */
export const LOCAL_HOSTNAME_SUFFIXES: readonly string[] = ['local', 'lan', 'internal', 'home.arpa', 'test', 'localdomain', 'localhost'];

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Lower-cased host part: no scheme, path, trailing dot, brackets or port. */
function hostPart(value: string | null | undefined): string {
  let h = (value ?? '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '');
  const bracketed = /^\[([^\]]*)\](?::\d+)?$/.exec(h);
  if (bracketed) return bracketed[1] ?? '';
  // host:port (exactly one colon) — more colons is an IPv6 literal
  if (/^[^:]+:\d+$/.test(h)) h = h.slice(0, h.indexOf(':'));
  return h.replace(/\.$/, '');
}

/** True for a local / private host name or a bare IP address; false for an empty value. */
export function isLocalHostname(value: string | null | undefined): boolean {
  const h = hostPart(value);
  if (!h) return false;
  if (h.includes(':')) return true; // IPv6 literal
  if (IPV4_RE.test(h)) return true;
  if (!h.includes('.')) return true; // single label
  return LOCAL_HOSTNAME_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}
