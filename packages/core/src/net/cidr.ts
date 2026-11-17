/**
 * Strict CIDR lists (IPv4/IPv6) for allow-list decisions.
 *
 * Unlike the brute-force exemption matcher, nothing is implicitly allowed
 * (no loopback bonus) and an invalid entry never widens the list: it is
 * reported in `invalid` and ignored. A bare address is a host route (/32, /128).
 *
 * IPv4-mapped IPv6 (`::ffff:192.0.2.1`, also in hex `::ffff:c000:201`) is
 * IPv4: client addresses are normalised to IPv4, and a mapped network entry
 * (`::ffff:a00:0/104`) becomes the IPv4 entry it denotes (`10.0.0.0/8`), so it
 * is subject to the IPv4 breadth limit. IPv4 clients are only ever checked
 * against IPv4 entries and IPv6 clients only against IPv6 entries — node's
 * BlockList alone would let an IPv6 rule that contains the mapped space (e.g.
 * `::/32`) match every IPv4 address.
 */
import { BlockList, SocketAddress, isIP } from 'node:net';

export interface ParsedCidr {
  /** Canonical form, e.g. `192.168.10.0/24`. */
  cidr: string;
  address: string;
  prefix: number;
  family: 4 | 6;
}

/**
 * Narrowest prefixes a relay allow-list accepts (device relay: api-gateway
 * validation and the smtp-server policy). Broader entries — up to `0.0.0.0/0`,
 * "the whole internet" — are refused.
 */
export const RELAY_NETWORK_MIN_PREFIX: Readonly<{ v4: number; v6: number }> = { v4: 8, v6: 32 };

const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/;

/** Canonical IPv6 text (lower case, `::` compressed, mapped IPv4 dotted). */
function canonicalIpv6(address: string): string {
  return new SocketAddress({ address, family: 'ipv6' }).address;
}

/** Strips an IPv6 zone, canonicalises IPv6 and maps IPv4-mapped IPv6 to IPv4; trims. */
export function normalizeClientIp(raw: string | null | undefined): string {
  if (!raw) return '';
  let v = raw.trim();
  const zone = v.indexOf('%');
  if (zone !== -1) v = v.slice(0, zone);
  if (isIP(v) !== 6) return v;
  const canonical = canonicalIpv6(v);
  return MAPPED_V4.exec(canonical)?.[1] ?? canonical;
}

/** Parses one `address[/prefix]` entry, or null when it is not valid. */
export function parseCidr(entry: string): ParsedCidr | null {
  const text = entry.trim();
  const slash = text.indexOf('/');
  const rawAddress = (slash === -1 ? text : text.slice(0, slash)).trim();
  const rawFamily = isIP(rawAddress);
  if (rawFamily !== 4 && rawFamily !== 6) return null;
  const prefixText = slash === -1 ? String(rawFamily === 4 ? 32 : 128) : text.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixText)) return null;
  let prefix = Number(prefixText);
  if (prefix > (rawFamily === 4 ? 32 : 128)) return null;

  let address = rawFamily === 4 ? rawAddress : canonicalIpv6(rawAddress);
  let family: 4 | 6 = rawFamily;
  const mapped = family === 6 ? MAPPED_V4.exec(address) : null;
  if (mapped && prefix >= 96) {
    // ::ffff:a.b.c.d/(96+n) is the IPv4 network a.b.c.d/n
    address = mapped[1]!;
    prefix -= 96;
    family = 4;
  }
  return { cidr: `${address}/${prefix}`, address, prefix, family };
}

export interface CidrMatcher {
  /** True when `ip` lies in one of the valid entries. */
  contains(ip: string | null | undefined): boolean;
  /** Valid entries in canonical form. */
  entries: string[];
  /** Entries that could not be parsed (ignored). */
  invalid: string[];
  /** Entries broader than `minPrefix` (ignored; only with that option). */
  tooBroad: string[];
}

export interface CidrMatcherOptions {
  /** Ignore (and report in `tooBroad`) entries with a shorter prefix. */
  minPrefix?: Readonly<{ v4: number; v6: number }>;
}

/** Pure: is the entry broader than the minimum prefix of its family? */
export function cidrTooBroad(p: ParsedCidr, minPrefix: Readonly<{ v4: number; v6: number }>): boolean {
  return p.prefix < (p.family === 4 ? minPrefix.v4 : minPrefix.v6);
}

/** Builds a matcher from a list (or a comma/whitespace separated string). */
export function createCidrMatcher(
  list: readonly string[] | string | null | undefined,
  options: CidrMatcherOptions = {},
): CidrMatcher {
  const raw = typeof list === 'string' ? list.split(/[\s,]+/) : [...(list ?? [])];
  const v4 = new BlockList();
  const v6 = new BlockList();
  const entries: string[] = [];
  const invalid: string[] = [];
  const tooBroad: string[] = [];
  for (const item of raw.map((e) => e.trim()).filter(Boolean)) {
    const parsed = parseCidr(item);
    if (!parsed) { invalid.push(item); continue; }
    if (options.minPrefix && cidrTooBroad(parsed, options.minPrefix)) { tooBroad.push(item); continue; }
    if (parsed.family === 4) v4.addSubnet(parsed.address, parsed.prefix, 'ipv4');
    else v6.addSubnet(parsed.address, parsed.prefix, 'ipv6');
    entries.push(parsed.cidr);
  }
  const contains = (rawIp: string | null | undefined): boolean => {
    if (entries.length === 0) return false;
    const ip = normalizeClientIp(rawIp);
    const family = isIP(ip);
    if (family === 4) return v4.check(ip, 'ipv4');
    if (family === 6) return v6.check(ip, 'ipv6');
    return false;
  };
  return { contains, entries, invalid, tooBroad };
}
