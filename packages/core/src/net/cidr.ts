/**
 * Strict CIDR lists (IPv4/IPv6) for allow-list decisions.
 *
 * Unlike the brute-force exemption matcher, nothing is implicitly allowed
 * (no loopback bonus) and an invalid entry never widens the list: it is
 * reported in `invalid` and ignored. A bare address is a host route (/32, /128).
 * IPv4-mapped IPv6 client addresses (`::ffff:192.0.2.1`) match IPv4 entries.
 */
import { BlockList, isIP } from 'node:net';

export interface ParsedCidr {
  /** Canonical form, e.g. `192.168.10.0/24`. */
  cidr: string;
  address: string;
  prefix: number;
  family: 4 | 6;
}

/** Strips an IPv6 zone and the IPv4-mapped prefix; trims. */
export function normalizeClientIp(raw: string | null | undefined): string {
  if (!raw) return '';
  let v = raw.trim();
  const zone = v.indexOf('%');
  if (zone !== -1) v = v.slice(0, zone);
  if (/^::ffff:\d{1,3}(?:\.\d{1,3}){3}$/i.test(v)) v = v.slice(7);
  return v;
}

/** Parses one `address[/prefix]` entry, or null when it is not valid. */
export function parseCidr(entry: string): ParsedCidr | null {
  const text = entry.trim();
  const slash = text.indexOf('/');
  const address = normalizeClientIp(slash === -1 ? text : text.slice(0, slash));
  const family = isIP(address);
  if (family !== 4 && family !== 6) return null;
  const max = family === 4 ? 32 : 128;
  const prefixText = slash === -1 ? String(max) : text.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  if (prefix > max) return null;
  return { cidr: `${address}/${prefix}`, address, prefix, family };
}

export interface CidrMatcher {
  /** True when `ip` lies in one of the valid entries. */
  contains(ip: string | null | undefined): boolean;
  /** Valid entries in canonical form. */
  entries: string[];
  /** Entries that could not be parsed (ignored). */
  invalid: string[];
}

/** Builds a matcher from a list (or a comma/whitespace separated string). */
export function createCidrMatcher(list: readonly string[] | string | null | undefined): CidrMatcher {
  const raw = typeof list === 'string' ? list.split(/[\s,]+/) : [...(list ?? [])];
  const blocks = new BlockList();
  const entries: string[] = [];
  const invalid: string[] = [];
  for (const item of raw.map((e) => e.trim()).filter(Boolean)) {
    const parsed = parseCidr(item);
    if (!parsed) { invalid.push(item); continue; }
    blocks.addSubnet(parsed.address, parsed.prefix, parsed.family === 4 ? 'ipv4' : 'ipv6');
    entries.push(parsed.cidr);
  }
  const contains = (rawIp: string | null | undefined): boolean => {
    if (entries.length === 0) return false;
    const ip = normalizeClientIp(rawIp);
    const family = isIP(ip);
    if (family === 4) return blocks.check(ip, 'ipv4');
    if (family === 6) return blocks.check(ip, 'ipv6');
    return false;
  };
  return { contains, entries, invalid };
}
