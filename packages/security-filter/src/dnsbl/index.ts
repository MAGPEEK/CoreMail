import { createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage';
import { resolveHardened } from '../dns-hardened.js';

const log = createLogger('security-filter:dnsbl');

// Fallback zones in case the DB is still empty (e.g. on first start before the seed)
export const DEFAULT_DNSBL_ZONES = [
  'zen.spamhaus.org',
  'bl.spamcop.net',
];

export type DnsblAction = 'REJECT' | 'TAG' | 'SCORE_ONLY';

export interface DnsblZoneConfig {
  id: string;
  host: string;
  name: string;
  action: DnsblAction;
  weight: number;
  isWhitelist: boolean;
}

export interface DnsblHit {
  zone: DnsblZoneConfig;
  /** Answer address (e.g. 127.0.0.2) */
  response: string;
}

export interface DnsblResult {
  listed: boolean;
  whitelisted: boolean;
  hits: DnsblHit[];
  /** Aggregated score (sum of weights) */
  totalScore: number;
  /** Strongest action across all hits (REJECT > TAG > SCORE_ONLY) */
  action: DnsblAction | null;
}

// ── DNS cache (1h TTL) ────────────────────────────────────────────────────────
interface CacheEntry { result: { listed: boolean; response?: string }; expiresAt: number }
const dnsCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h

function getCache(key: string): CacheEntry['result'] | undefined {
  const e = dnsCache.get(key);
  if (!e) return undefined;
  if (Date.now() > e.expiresAt) { dnsCache.delete(key); return undefined; }
  return e.result;
}
function setCache(key: string, result: CacheEntry['result']): void {
  dnsCache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  // Soft cleanup: every 200 entries, remove stale entries
  if (dnsCache.size > 1000) {
    const now = Date.now();
    for (const [k, v] of dnsCache) {
      if (v.expiresAt < now) dnsCache.delete(k);
    }
  }
}
export function clearDnsblCache(): void { dnsCache.clear(); }

// ── IP helpers ────────────────────────────────────────────────────────────────
function isIpv4(ip: string): boolean { return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip); }
function isIpv6(ip: string): boolean { return ip.includes(':'); }

function expandIpv6(ip: string): string {
  // "2001:db8::1" → "2001:0db8:0000:0000:0000:0000:0000:0001"
  if (!ip.includes('::')) {
    return ip.split(':').map((p) => p.padStart(4, '0')).join('');
  }
  const [left, right] = ip.split('::');
  const leftParts = left ? left.split(':') : [];
  const rightParts = right ? right.split(':') : [];
  const missing = 8 - leftParts.length - rightParts.length;
  const allParts = [
    ...leftParts,
    ...Array.from({ length: missing }, () => '0'),
    ...rightParts,
  ];
  return allParts.map((p) => p.padStart(4, '0')).join('');
}

function reverseIp(ip: string): string {
  if (isIpv4(ip)) {
    // 1.2.3.4 → 4.3.2.1
    return ip.split('.').reverse().join('.');
  }
  if (isIpv6(ip)) {
    // 2001:db8::1 → 32 nibbles, reversed, separated by dots
    return expandIpv6(ip).split('').reverse().join('.');
  }
  return '';
}

function isPrivateIp(ip: string): boolean {
  if (isIpv4(ip)) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts as [number, number, number, number];
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (isIpv6(ip)) {
    // ::1 (loopback), fc00::/7 (ULA), fe80::/10 (link-local)
    const lower = ip.toLowerCase();
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb');
  }
  return true;
}

// ── DNS query (with 2s timeout) ───────────────────────────────────────────────
async function queryZone(reversed: string, zone: string, ip: string): Promise<{ listed: boolean; response?: string }> {
  const cacheKey = `${zone}|${ip}`;
  const cached = getCache(cacheKey);
  if (cached !== undefined) return cached;

  const fqdn = `${reversed}.${zone}`;
  try {
    const addresses = await resolveHardened(fqdn);
    const result = addresses[0]
      ? { listed: true as const, response: addresses[0] }
      : { listed: true as const };
    setCache(cacheKey, result);
    return result;
  } catch {
    const result = { listed: false as const };
    setCache(cacheKey, result);
    return result;
  }
}

// ── Main function ─────────────────────────────────────────────────────────────

/**
 * Checks a sender IP against all active DNSBL zones from the DB.
 * Falls back to DEFAULT_DNSBL_ZONES if the DB is still empty.
 * Writes hits asynchronously to the `dnsbl_hits` table.
 */
export async function checkDnsbl(ip: string): Promise<DnsblResult> {
  const empty: DnsblResult = { listed: false, whitelisted: false, hits: [], totalScore: 0, action: null };
  if (!ip || isPrivateIp(ip)) return empty;

  // Load active zones from DB (or fallback)
  let zones: DnsblZoneConfig[];
  try {
    const rows = await prisma.dnsblZone.findMany({
      where: { enabled: true },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, host: true, name: true, action: true, weight: true, isWhitelist: true },
    });
    if (rows.length > 0) {
      zones = rows.map((r) => ({ ...r, action: r.action as DnsblAction }));
    } else {
      zones = DEFAULT_DNSBL_ZONES.map((host, i) => ({
        id: `fallback-${i}`,
        host,
        name: host,
        action: 'REJECT' as const,
        weight: 5,
        isWhitelist: false,
      }));
    }
  } catch (err) {
    log.error({ err }, 'Failed to load DNSBL zones from DB, using defaults');
    zones = DEFAULT_DNSBL_ZONES.map((host, i) => ({
      id: `fallback-${i}`,
      host,
      name: host,
      action: 'REJECT' as const,
      weight: 5,
      isWhitelist: false,
    }));
  }

  const reversed = reverseIp(ip);
  if (!reversed) return empty;

  // Whitelist first — on a whitelist hit, we stop
  const whitelistZones = zones.filter((z) => z.isWhitelist);
  const blacklistZones = zones.filter((z) => !z.isWhitelist);

  for (const z of whitelistZones) {
    const r = await queryZone(reversed, z.host, ip);
    if (r.listed) {
      log.info({ ip, zone: z.host }, 'DNSWL hit — bypassing further checks');
      return { ...empty, whitelisted: true, hits: [{ zone: z, response: r.response ?? '' }] };
    }
  }

  // Query blacklists in parallel
  const results = await Promise.all(
    blacklistZones.map(async (z) => ({ zone: z, ...(await queryZone(reversed, z.host, ip)) })),
  );
  const hits = results.filter((r) => r.listed).map((r) => ({ zone: r.zone, response: r.response ?? '' }));

  // Log hits asynchronously (non-blocking)
  if (hits.length > 0) {
    void prisma.dnsblHit.createMany({
      data: hits.map((h) => ({ zoneId: h.zone.id, ip, ...(h.response ? { response: h.response } : {}) })),
    }).catch((err) => log.warn({ err }, 'Failed to log DNSBL hits'));
  }

  // Aggregation: strongest action wins (REJECT > TAG > SCORE_ONLY)
  const totalScore = hits.reduce((s, h) => s + h.zone.weight, 0);
  let action: DnsblAction | null = null;
  const hasReject = hits.some((h) => h.zone.action === 'REJECT');
  const hasTag    = hits.some((h) => h.zone.action === 'TAG');
  if (hasReject) action = 'REJECT';
  else if (hasTag) action = 'TAG';
  else if (hits.length > 0) action = 'SCORE_ONLY';

  return { listed: hits.length > 0, whitelisted: false, hits, totalScore, action };
}

/**
 * Live test: checks an IP against all zones (including disabled ones).
 * Used by the admin panel.
 */
export async function testDnsbl(ip: string): Promise<{ zone: DnsblZoneConfig; listed: boolean; response?: string }[]> {
  const rows = await prisma.dnsblZone.findMany({
    orderBy: { sortOrder: 'asc' },
    select: { id: true, host: true, name: true, action: true, weight: true, isWhitelist: true },
  });
  const zones: DnsblZoneConfig[] = rows.map((r) => ({ ...r, action: r.action as DnsblAction }));
  const reversed = reverseIp(ip);
  if (!reversed) return [];
  return Promise.all(
    zones.map(async (z) => ({ zone: z, ...(await queryZone(reversed, z.host, ip)) })),
  );
}

// ── Built-in presets (seeded when DB is empty) ────────────────────────────────
export const BUILTIN_DNSBL_PRESETS: Array<Omit<DnsblZoneConfig, 'id'> & { description: string; sortOrder: number }> = [
  { host: 'zen.spamhaus.org',         name: 'Spamhaus ZEN',         description: 'Kombiniert SBL+CSS+XBL+PBL — der De-facto-Standard',                action: 'REJECT', weight: 10, isWhitelist: false, sortOrder: 10 },
  { host: 'bl.spamcop.net',           name: 'SpamCop',              description: 'Community-betriebene Liste reportet-Spammer-IPs',                    action: 'REJECT', weight: 6,  isWhitelist: false, sortOrder: 20 },
  { host: 'b.barracudacentral.org',   name: 'Barracuda Reputation', description: 'Barracudas Reputation Block List (BRBL)',                            action: 'REJECT', weight: 7,  isWhitelist: false, sortOrder: 30 },
  { host: 'dnsbl.sorbs.net',          name: 'SORBS Aggregat',       description: 'Spam-Reportings + offene Proxies/Relays',                            action: 'TAG',    weight: 4,  isWhitelist: false, sortOrder: 40 },
  { host: 'ix.dnsbl.manitu.net',      name: 'Manitu NiX',           description: 'NiX Spam (Deutsch) — Heise/iX Spam-Blocklist',                       action: 'TAG',    weight: 5,  isWhitelist: false, sortOrder: 50 },
  { host: 'dnsbl-1.uceprotect.net',   name: 'UCEPROTECT Level 1',   description: 'Single-IPs mit Spam-Reports (sehr strikt)',                          action: 'TAG',    weight: 3,  isWhitelist: false, sortOrder: 60 },
  { host: 'psbl.surriel.com',         name: 'PSBL',                 description: 'Passive Spam Block List — niedrige False-Positive-Rate',             action: 'SCORE_ONLY', weight: 3, isWhitelist: false, sortOrder: 70 },
  { host: 'list.dnswl.org',           name: 'DNSWL (Whitelist)',    description: 'Vertrauenswürdige Sender — Treffer überspringt weitere Prüfungen',   action: 'SCORE_ONLY', weight: 0, isWhitelist: true,  sortOrder: 5  },
];

/**
 * Seed function — runs at startup of the security-filter service.
 * Creates the built-in presets if the table is empty.
 */
export async function seedDnsblZonesIfEmpty(): Promise<void> {
  const count = await prisma.dnsblZone.count();
  if (count > 0) return;
  log.info({ count: BUILTIN_DNSBL_PRESETS.length }, 'Seeding DNSBL zones');
  await prisma.dnsblZone.createMany({
    data: BUILTIN_DNSBL_PRESETS.map((p) => ({
      host: p.host,
      name: p.name,
      description: p.description,
      enabled: !p.isWhitelist || p.host === 'list.dnswl.org', // all active by default
      action: p.action,
      weight: p.weight,
      isWhitelist: p.isWhitelist,
      sortOrder: p.sortOrder,
      isBuiltin: true,
    })),
    skipDuplicates: true,
  });
}
