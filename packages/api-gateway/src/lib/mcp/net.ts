/**
 * Admin MCP interface (10.3) — network checks, pure: the optional client IP
 * allowlist (ServerSettings.mcpAllowedIps) and the Origin check against DNS
 * rebinding (MCP transport spec: servers MUST validate Origin).
 */
import { BlockList, isIP } from 'node:net';

/** Upper bound of allowlist entries (BCP + API validation). */
export const MAX_ALLOWLIST_ENTRIES = 100;

/** Pure: IPv4-mapped IPv6 (`::ffff:1.2.3.4`) → IPv4, zone index removed. */
export function normalizeIp(raw: string | null | undefined): string {
  if (!raw) return '';
  let v = raw.trim();
  const zone = v.indexOf('%');
  if (zone !== -1) v = v.slice(0, zone);
  if (/^::ffff:\d{1,3}(?:\.\d{1,3}){3}$/i.test(v)) v = v.slice(7);
  return v;
}

interface ParsedEntry { address: string; prefix: number; family: 'ipv4' | 'ipv6' }

/** Pure: one allowlist entry (an IP or a CIDR range), or null when invalid. */
export function parseAllowlistEntry(entry: string): ParsedEntry | null {
  const text = entry.trim();
  if (!text) return null;
  const slash = text.indexOf('/');
  const address = normalizeIp(slash === -1 ? text : text.slice(0, slash));
  const fam = isIP(address);
  if (fam === 0) return null;
  const max = fam === 4 ? 32 : 128;
  const prefixText = slash === -1 ? String(max) : text.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  if (prefix > max) return null;
  return { address, prefix, family: fam === 4 ? 'ipv4' : 'ipv6' };
}

/**
 * Pure: validated, canonical allowlist (trimmed, duplicates removed), or the
 * first invalid entry. An empty list means "every client IP".
 */
export function normalizeAllowlist(entries: readonly string[]): { ok: true; entries: string[] } | { ok: false; error: string } {
  if (entries.length > MAX_ALLOWLIST_ENTRIES) return { ok: false, error: `At most ${MAX_ALLOWLIST_ENTRIES} entries` };
  const out: string[] = [];
  for (const raw of entries) {
    const p = parseAllowlistEntry(raw);
    if (!p) return { ok: false, error: `Invalid IP address or CIDR range: ${String(raw).slice(0, 64)}` };
    const max = p.family === 'ipv4' ? 32 : 128;
    const canonical = p.prefix === max ? p.address : `${p.address}/${p.prefix}`;
    if (!out.includes(canonical)) out.push(canonical);
  }
  return { ok: true, entries: out };
}

/** Pure: is `ip` allowed by the allowlist? Empty list → always; invalid entries never match. */
export function ipAllowed(ip: string | null | undefined, entries: readonly string[]): boolean {
  if (entries.length === 0) return true;
  const addr = normalizeIp(ip);
  const fam = isIP(addr);
  if (fam === 0) return false;
  const list = new BlockList();
  let rules = 0;
  for (const e of entries) {
    const p = parseAllowlistEntry(e);
    if (!p) continue;
    list.addSubnet(p.address, p.prefix, p.family);
    rules++;
  }
  return rules > 0 && list.check(addr, fam === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Pure: is a request's Origin header acceptable? No Origin (non-browser MCP
 * clients) → yes. Otherwise the origin's host name must be one of the
 * configured public host names (`allowedHosts`, lower-case) over http(s), or
 * the origin must be listed verbatim in `allowedOrigins` (MCP_ALLOWED_ORIGINS).
 * "null" and malformed origins are refused. The request's own Host header is
 * never trusted (that is what a DNS-rebinding page controls).
 */
export function originAllowed(
  origin: string | undefined,
  allowedHosts: readonly string[],
  allowedOrigins: readonly string[] = [],
): boolean {
  if (origin === undefined) return true;
  const value = origin.trim();
  if (!value || value === 'null') return false;
  if (allowedOrigins.some((o) => o.replace(/\/+$/, '').toLowerCase() === value.toLowerCase())) return true;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  return allowedHosts.some((h) => h.trim().toLowerCase().replace(/\.$/, '') === host);
}

/** Pure: MCP_ALLOWED_ORIGINS (comma / space separated origins) → list. */
export function parseOriginList(raw: string | undefined): string[] {
  return (raw ?? '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}
