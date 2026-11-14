/**
 * SSRF guards for server-side requests to user-supplied URLs
 * (Web Push endpoints, JMAP PushSubscription URLs).
 *
 * Rules: https only, no credentials in the URL, every resolved address must
 * be public (no loopback / private / link-local / CGNAT / metadata / ULA /
 * multicast / reserved ranges, IPv4-mapped IPv6 is unwrapped first).
 * `safeLookup` re-checks at connect time, so a DNS answer that changes between
 * validation and connect (rebinding) is refused as well.
 */
import { BlockList, isIP } from 'node:net';
import dns from 'node:dns';
import type { LookupAddress, LookupOptions } from 'node:dns';

const blocked = new BlockList();
// IPv4
for (const [net, prefix] of [
  ['0.0.0.0', 8],        // "this network"
  ['10.0.0.0', 8],       // RFC 1918
  ['100.64.0.0', 10],    // CGNAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local incl. 169.254.169.254 metadata
  ['172.16.0.0', 12],    // RFC 1918
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // TEST-NET-1
  ['192.88.99.0', 24],   // 6to4 relay anycast
  ['192.168.0.0', 16],   // RFC 1918
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // TEST-NET-2
  ['203.0.113.0', 24],   // TEST-NET-3
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved + broadcast
] as const) blocked.addSubnet(net, prefix, 'ipv4');
// IPv6
for (const [net, prefix] of [
  ['::', 128],           // unspecified
  ['::1', 128],          // loopback
  ['64:ff9b::', 96],     // NAT64 (embeds IPv4)
  ['100::', 64],         // discard
  ['2001:db8::', 32],    // documentation
  ['2002::', 16],        // 6to4 (embeds IPv4)
  ['fc00::', 7],         // ULA
  ['fe80::', 10],        // link-local
  ['fec0::', 10],        // site-local (deprecated)
  ['ff00::', 8],         // multicast
  ['fd00:ec2::', 32],    // AWS IMDS IPv6
] as const) blocked.addSubnet(net, prefix, 'ipv6');

/** `::ffff:1.2.3.4` / `::ffff:0102:0304` → `1.2.3.4`; other input unchanged (lower-cased, zone id removed). */
export function normalizeIp(ip: string): string {
  let v = ip.trim().toLowerCase();
  if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1);
  const pct = v.indexOf('%');
  if (pct >= 0) v = v.slice(0, pct);
  const mapped = /^(?:0{0,4}:){0,4}:?(?:0{0,4}:)?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
  if (mapped) return mapped[1]!;
  const mappedHex = /^(?:0{0,4}:){0,4}:?(?:0{0,4}:)?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1]!, 16); const lo = parseInt(mappedHex[2]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return v;
}

/** True for addresses a server-side request must never reach (and for non-IPs). */
export function isBlockedAddress(ip: string): boolean {
  const v = normalizeIp(ip);
  const family = isIP(v);
  if (family === 4) return blocked.check(v, 'ipv4');
  if (family === 6) return blocked.check(v, 'ipv6');
  return true;
}

export type HostResolver = (hostname: string) => Promise<string[]>;

const defaultResolver: HostResolver = async (hostname) =>
  (await dns.promises.lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

export class UnsafeUrlError extends Error {
  constructor(message: string) { super(message); this.name = 'UnsafeUrlError'; }
}

/** Synchronous part of the check: scheme, credentials, literal IPs, obvious internal names. */
export function checkPublicHttpsUrlSyntax(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new UnsafeUrlError('invalid URL'); }
  if (u.protocol !== 'https:') throw new UnsafeUrlError('only https URLs are allowed');
  if (u.username || u.password) throw new UnsafeUrlError('credentials in URL are not allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw new UnsafeUrlError('missing host');
  if (isIP(normalizeIp(host)) !== 0) {
    if (isBlockedAddress(host)) throw new UnsafeUrlError('address not allowed');
  } else if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local') || !host.includes('.')) {
    throw new UnsafeUrlError('internal host names are not allowed');
  }
  return u;
}

/** Full check incl. DNS resolution: every resolved address must be public. */
export async function assertPublicHttpsUrl(raw: string, resolve: HostResolver = defaultResolver): Promise<URL> {
  const u = checkPublicHttpsUrlSyntax(raw);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(normalizeIp(host)) !== 0) return u;
  let addrs: string[];
  try { addrs = await resolve(host); } catch { throw new UnsafeUrlError('host does not resolve'); }
  if (addrs.length === 0) throw new UnsafeUrlError('host does not resolve');
  if (addrs.some((a) => isBlockedAddress(a))) throw new UnsafeUrlError('host resolves to a non-public address');
  return u;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * Drop-in `lookup` for http(s).Agent / request options: resolves like
 * dns.lookup but fails when any resulting address is non-public.
 */
export function safeLookup(hostname: string, options: LookupOptions | number | LookupCallback, callback?: LookupCallback): void {
  const cb = (typeof options === 'function' ? options : callback) as LookupCallback;
  const opts: LookupOptions = typeof options === 'object' && options !== null ? options : {};
  dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) { cb(err, ''); return; }
    const list = addresses as LookupAddress[];
    const bad = list.find((a) => isBlockedAddress(a.address));
    if (bad || list.length === 0) {
      const e: NodeJS.ErrnoException = new Error(`refusing to connect to non-public address for ${hostname}`);
      e.code = 'ESSRF';
      cb(e, '');
      return;
    }
    if (opts.all) cb(null, list);
    else cb(null, list[0]!.address, list[0]!.family);
  });
}
