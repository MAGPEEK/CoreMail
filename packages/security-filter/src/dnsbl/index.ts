import { createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage';
import { resolveHardened } from '../dns-hardened.js';
import { interpretDnsblAnswer, isNonRoutableSender, isNxdomainError, normalizeSenderIp, reverseIpForDnsbl } from './answer.js';

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

// ── DNS cache ────────────────────────────────────────────────────────────────
// Only definite answers are cached, and only briefly: positive listings and
// NXDOMAIN for 5 minutes. Timeouts, SERVFAIL and "query refused" codes are
// never cached — a transient resolver problem must not whitelist an IP for an
// hour (the previous behaviour).
interface QueryResult { listed: boolean; refused?: boolean; response?: string }
interface CacheEntry { result: QueryResult; expiresAt: number }
const dnsCache = new Map<string, CacheEntry>();
export const DNSBL_CACHE_TTL_MS = 5 * 60 * 1000;

function getCache(key: string): QueryResult | undefined {
  const e = dnsCache.get(key);
  if (!e) return undefined;
  if (Date.now() > e.expiresAt) { dnsCache.delete(key); return undefined; }
  return e.result;
}
function setCache(key: string, result: QueryResult): void {
  dnsCache.set(key, { result, expiresAt: Date.now() + DNSBL_CACHE_TTL_MS });
  if (dnsCache.size > 5000) {
    const now = Date.now();
    for (const [k, v] of dnsCache) {
      if (v.expiresAt < now) dnsCache.delete(k);
    }
  }
}
export function clearDnsblCache(): void { dnsCache.clear(); }

export type DnsResolve = (fqdn: string) => Promise<string[]>;

// ── DNS query (timeout handled by resolveHardened) ───────────────────────────
export async function queryZone(
  reversed: string,
  zone: string,
  ip: string,
  isWhitelist = false,
  resolve: DnsResolve = resolveHardened,
): Promise<QueryResult> {
  const cacheKey = `${zone}|${ip}`;
  const cached = getCache(cacheKey);
  if (cached !== undefined) return cached;

  const fqdn = `${reversed}.${zone}`;
  let addresses: string[];
  try {
    addresses = await resolve(fqdn);
  } catch (err) {
    if (isNxdomainError(err)) {
      const result = { listed: false };
      setCache(cacheKey, result);
      return result;
    }
    // timeout / SERVFAIL / network error — not listed for this check, not cached
    log.debug({ err, zone, ip }, 'DNSBL query failed (not cached)');
    return { listed: false };
  }

  const answer = interpretDnsblAnswer(addresses, isWhitelist);
  if (answer.state === 'refused') {
    log.warn({ zone, ip, addresses }, 'DNSBL query refused by the list operator (error code) — check resolver / quota');
    return { listed: false, refused: true };
  }
  const result: QueryResult = answer.state === 'listed'
    ? { listed: true, response: answer.codes[0]! }
    : { listed: false };
  setCache(cacheKey, result);
  return result;
}

// ── Main function ─────────────────────────────────────────────────────────────

/**
 * Checks a sender IP against all active DNSBL zones from the DB.
 * Falls back to DEFAULT_DNSBL_ZONES if the DB is still empty.
 * Writes hits asynchronously to the `dnsbl_hits` table.
 */
export async function checkDnsbl(rawIp: string): Promise<DnsblResult> {
  const empty: DnsblResult = { listed: false, whitelisted: false, hits: [], totalScore: 0, action: null };
  const ip = rawIp ? normalizeSenderIp(rawIp) : '';
  if (!ip || isNonRoutableSender(ip)) return empty;

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

  const reversed = reverseIpForDnsbl(ip);
  if (!reversed) return empty;

  // Whitelist first — on a whitelist hit, we stop
  const whitelistZones = zones.filter((z) => z.isWhitelist);
  const blacklistZones = zones.filter((z) => !z.isWhitelist);

  for (const z of whitelistZones) {
    const r = await queryZone(reversed, z.host, ip, true);
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
export async function testDnsbl(rawIp: string): Promise<{ zone: DnsblZoneConfig; listed: boolean; response?: string }[]> {
  const rows = await prisma.dnsblZone.findMany({
    orderBy: { sortOrder: 'asc' },
    select: { id: true, host: true, name: true, action: true, weight: true, isWhitelist: true },
  });
  const zones: DnsblZoneConfig[] = rows.map((r) => ({ ...r, action: r.action as DnsblAction }));
  const ip = normalizeSenderIp(rawIp);
  const reversed = reverseIpForDnsbl(ip);
  if (!reversed) return [];
  return Promise.all(
    zones.map(async (z) => ({ zone: z, ...(await queryZone(reversed, z.host, ip, z.isWhitelist)) })),
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
