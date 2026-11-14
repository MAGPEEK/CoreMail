/**
 * Pure DNSBL/DNSWL helpers: query-name construction and answer interpretation.
 *
 * Interpretation rules:
 *  - Only answers inside 127.0.0.0/8 are list answers. Anything else (e.g. an
 *    ISP resolver that "helpfully" answers NXDOMAIN with an ad-server IP) is
 *    ignored.
 *  - 127.255.255.0/24 are operator error codes (Spamhaus: .252 typo in the
 *    query, .254 query via public/open resolver, .255 excessive queries) and
 *    mean "query refused", never "listed".
 *  - DNSWL answers 127.0.0.255 when the querier exceeded its limit.
 *  - 127.0.0.1 is the common "query refused / test" answer of blocklists
 *    (no preset lists a sender with it).
 */
import { isIP } from 'node:net';

export type DnsblAnswerState = 'listed' | 'clean' | 'refused';

export interface DnsblAnswer {
  state: DnsblAnswerState;
  /** The list answer(s) inside 127.0.0.0/8 that counted as a listing. */
  codes: string[];
}

function isLoopback127(addr: string): boolean {
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr);
}

export function isDnsblErrorCode(addr: string, isWhitelist: boolean): boolean {
  if (addr.startsWith('127.255.255.')) return true;
  if (isWhitelist) return addr === '127.0.0.255';
  return addr === '127.0.0.1';
}

/** Interpret the A records returned for `<reversed-ip>.<zone>`. Empty array = NXDOMAIN. */
export function interpretDnsblAnswer(addresses: readonly string[], isWhitelist = false): DnsblAnswer {
  const inRange = addresses.filter(isLoopback127);
  if (inRange.some((a) => isDnsblErrorCode(a, isWhitelist))) return { state: 'refused', codes: [] };
  if (inRange.length === 0) return { state: 'clean', codes: [] };
  return { state: 'listed', codes: inRange };
}

/** `::ffff:1.2.3.4` → `1.2.3.4`, lower-cases IPv6, strips zone ids. */
export function normalizeSenderIp(ip: string): string {
  let v = ip.trim().toLowerCase();
  const pct = v.indexOf('%');
  if (pct >= 0) v = v.slice(0, pct);
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v) ?? /^0:0:0:0:0:ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
  if (m) return m[1]!;
  const h = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v);
  if (h) {
    const hi = parseInt(h[1]!, 16); const lo = parseInt(h[2]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return v;
}

function expandIpv6(ip: string): string {
  const [left = '', right = ''] = ip.includes('::') ? ip.split('::') : [ip, ''];
  const l = left ? left.split(':') : [];
  const r = right ? right.split(':') : [];
  const missing = ip.includes('::') ? 8 - l.length - r.length : 0;
  return [...l, ...Array.from({ length: missing }, () => '0'), ...r].map((p) => p.padStart(4, '0')).join('');
}

/** Reversed query label for an IP (`1.2.3.4` → `4.3.2.1`, IPv6 → 32 nibbles), '' for invalid input. */
export function reverseIpForDnsbl(rawIp: string): string {
  const ip = normalizeSenderIp(rawIp);
  const fam = isIP(ip);
  if (fam === 4) return ip.split('.').reverse().join('.');
  if (fam === 6) {
    if (/\d+\.\d+\.\d+\.\d+$/.test(ip)) return ''; // embedded IPv4 notation other than mapped — not supported
    return expandIpv6(ip).split('').reverse().join('.');
  }
  return '';
}

/** Private/loopback/link-local senders are never looked up. */
export function isNonRoutableSender(rawIp: string): boolean {
  const ip = normalizeSenderIp(rawIp);
  const fam = isIP(ip);
  if (fam === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (fam === 6) {
    return ip === '::1' || ip === '::' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip);
  }
  return true;
}

/** DNS error codes that mean "name does not exist" (cacheable negative answer). */
export function isNxdomainError(err: unknown): boolean {
  const code = typeof err === 'object' && err && 'code' in err ? String((err as { code: unknown }).code) : '';
  return code === 'ENOTFOUND' || code === 'ENODATA';
}
