/**
 * 10.5 attack protection — the permanent IP block list and the exceptions
 * ("nie sperren") of BCP → Schutz → Angriffsschutz (table ip_access_rules,
 * docs/attack-protection.md).
 *
 *  - BLOCK rules are refused on every protocol at connect: SMTP/IMAP/POP3 on the
 *    raw TCP socket before TLS (connect-guard.ts), every HTTP surface in the
 *    api-gateway (ActiveSync, DAV, JMAP, MAPI, Autodiscover, webmail, BCP, API).
 *    10.5 review: automatic (repeat-offender) entries are not applied to inbound
 *    mail on port 25 (surface `mx`) — only manual entries are.
 *  - ALLOW rules are never locked: they skip the per-IP lockout counter (merged
 *    with MAIL_AUTH_EXEMPT_CIDRS) and win over BLOCK. Loopback is always allowed.
 *  - Every service keeps the rules in memory: refreshed every 60 s and right
 *    away on CHANNEL_SETTINGS_RELOAD `{type:'ip-access'}` (startIpAccessSubscriber).
 *    A failed load keeps the last good list (empty at start) — the block list
 *    fails open, like the lockout without Redis.
 *
 * Pure helpers (parseCidr, buildIpAccessMatcher) have no I/O and are unit-tested.
 */
import { BlockList, isIP } from 'node:net';
import { createLogger, getRedisClient, peekRedisClient, CHANNEL_SETTINGS_RELOAD } from '@coremail/core';
import { prisma } from './prisma/index.js';
import { compressIpv6Groups, createExemptIpMatcher, formatIpv6Groups, ipv6Groups, isLoopbackIp, normalizeIp } from './mail-auth-core.js';

const log = createLogger('ip-access');

export type IpAccessKindName = 'BLOCK' | 'ALLOW';

export interface ParsedCidr {
  /** Canonical text: network address / prefix (host bits cleared, IPv6 compressed). */
  cidr: string;
  /** Network address (host bits cleared). */
  address: string;
  prefix: number;
  family: 4 | 6;
}

/** RFC 5952 text of eight IPv6 groups (longest zero run → `::`); the lockout's ipLockIdOf uses the same text. */
export function compressIpv6(groups: number[]): string {
  return compressIpv6Groups(groups);
}

/**
 * Parses "203.0.113.7", "203.0.113.0/24", "2001:db8::/48", "::ffff:1.2.3.4" …
 * Host bits are cleared ("203.0.113.9/24" → "203.0.113.0/24"). null when the
 * text is not a valid IP / CIDR.
 */
export function parseCidr(input: string): ParsedCidr | null {
  const raw = String(input ?? '').trim();
  if (!raw || raw.length > 64) return null;
  const slash = raw.indexOf('/');
  const addrText = normalizeIp(slash === -1 ? raw : raw.slice(0, slash));
  const family = isIP(addrText);
  if (family !== 4 && family !== 6) return null;
  const max = family === 4 ? 32 : 128;
  const prefixText = slash === -1 ? String(max) : raw.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  if (prefix > max) return null;
  if (family === 4) {
    const n = addrText.split('.').reduce((acc, o) => (acc * 256) + Number(o), 0);
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const net = (n & mask) >>> 0;
    const address = [24, 16, 8, 0].map((s) => (net >>> s) & 0xff).join('.');
    return { cidr: `${address}/${prefix}`, address, prefix, family: 4 };
  }
  const g = ipv6Groups(addrText);
  if (!g) return null;
  const masked = g.map((v, i) => {
    const bits = Math.max(0, Math.min(16, prefix - i * 16));
    return bits === 0 ? 0 : (v & ((0xffff << (16 - bits)) & 0xffff));
  });
  const address = compressIpv6(masked);
  return { cidr: `${address}/${prefix}`, address, prefix, family: 6 };
}

/** True when `ip` lies inside `cidr` (text or parsed). */
export function cidrContains(cidr: string | ParsedCidr, rawIp: string): boolean {
  const c = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
  const ip = normalizeIp(rawIp);
  const family = isIP(ip);
  if (!c || family === 0) return false;
  const list = new BlockList();
  list.addSubnet(c.family === 4 ? c.address : formatIpv6Groups(ipv6Groups(c.address)!), c.prefix, c.family === 4 ? 'ipv4' : 'ipv6');
  return list.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

export interface IpRule {
  id?: string;
  kind: IpAccessKindName;
  cidr: string;
  expiresAt?: Date | string | null;
  /** 10.5 review: an automatic (repeat-offender) entry — not applied to inbound MX (port 25). */
  auto?: boolean | null;
}

export type IpVerdict = 'allow' | 'block' | 'none';

/**
 * 10.5 review: where a connection arrives. `mx` = inbound mail on port 25
 * (other servers delivering mail): only manual BLOCK entries apply there — an
 * automatic entry (shared address that tripped the login lockout) must never
 * bounce legitimate mail with a permanent 554. Every other surface (client
 * logins: submission, IMAP, POP3, HTTP) applies manual and automatic entries.
 */
export type IpAccessSurface = 'client' | 'mx';

export interface IpAccessMatcher {
  /** ALLOW (wins) → 'allow', BLOCK → 'block', else 'none'. Loopback/env exemptions are NOT applied here. */
  verdict(ip: string | null | undefined, surface?: IpAccessSurface): IpVerdict;
  readonly blocks: number;
  readonly allows: number;
}

/** Builds the matcher of the active (not expired, parseable) rules. */
export function buildIpAccessMatcher(rules: readonly IpRule[], now = Date.now()): IpAccessMatcher {
  const manualBlock = new BlockList();
  const autoBlock = new BlockList();
  const allow = new BlockList();
  let blocks = 0; let allows = 0; let manualBlocks = 0;
  for (const r of rules) {
    if (r.expiresAt && new Date(r.expiresAt).getTime() <= now) continue;
    const c = parseCidr(r.cidr);
    if (!c) continue;
    const list = r.kind === 'ALLOW' ? allow : r.auto === true ? autoBlock : manualBlock;
    const addr = c.family === 4 ? c.address : formatIpv6Groups(ipv6Groups(c.address)!);
    list.addSubnet(addr, c.prefix, c.family === 4 ? 'ipv4' : 'ipv6');
    if (r.kind === 'ALLOW') allows++;
    else { blocks++; if (r.auto !== true) manualBlocks++; }
  }
  const autoBlocks = blocks - manualBlocks;
  return {
    blocks, allows,
    verdict(rawIp, surface = 'client') {
      const ip = normalizeIp(rawIp);
      const family = isIP(ip);
      if (family === 0) return 'none';
      const type = family === 4 ? 'ipv4' : 'ipv6';
      if (allows > 0 && allow.check(ip, type)) return 'allow';
      if (manualBlocks > 0 && manualBlock.check(ip, type)) return 'block';
      if (surface !== 'mx' && autoBlocks > 0 && autoBlock.check(ip, type)) return 'block';
      return 'none';
    },
  };
}

// ─── Runtime cache ──────────────────────────────────────────────────────────

const REFRESH_MS = 60_000;
const RETRY_AFTER_FAILURE_MS = 30_000;
const EMPTY = buildIpAccessMatcher([]);

const state = {
  matcher: EMPTY,
  loadedAt: 0,
  failedAt: 0,
  loading: null as Promise<boolean> | null,
  /** Lazy refresh on access — enabled by the production wiring (never in unit tests by default). */
  lazy: false,
  override: null as IpAccessMatcher | null,
};

const envExempt = createExemptIpMatcher(process.env['MAIL_AUTH_EXEMPT_CIDRS']);

/** Loads the active rules from the database. Returns false (keeping the last list) on errors. */
export async function refreshIpAccessRules(): Promise<boolean> {
  if (state.loading) return state.loading;
  state.loading = (async () => {
    try {
      const now = new Date();
      const rows = await prisma.ipAccessRule.findMany({
        where: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        select: { kind: true, cidr: true, expiresAt: true, auto: true },
      });
      state.matcher = buildIpAccessMatcher(rows.map((r) => ({ kind: r.kind as IpAccessKindName, cidr: r.cidr, expiresAt: r.expiresAt, auto: r.auto })));
      state.loadedAt = Date.now();
      return true;
    } catch (err) {
      state.failedAt = Date.now();
      log.warn({ err }, 'IP block list could not be loaded — keeping the last list');
      return false;
    } finally {
      state.loading = null;
    }
  })();
  return state.loading;
}

function current(): IpAccessMatcher {
  if (state.override) return state.override;
  if (state.lazy && !state.loading) {
    const now = Date.now();
    const stale = now - state.loadedAt > REFRESH_MS;
    const mayRetry = now - state.failedAt > RETRY_AFTER_FAILURE_MS;
    if (stale && mayRetry) void refreshIpAccessRules();
  }
  return state.matcher;
}

/** Enables the lazy 60 s refresh on access (production wiring). Idempotent. */
export function enableIpAccessRuntime(): void {
  if (state.lazy) return;
  state.lazy = true;
  void refreshIpAccessRules();
}

/**
 * The connect-time verdict of a client IP: loopback, MAIL_AUTH_EXEMPT_CIDRS and
 * ALLOW rules → 'allow' (never refused, never IP-locked), BLOCK rules → 'block',
 * else 'none'. Synchronous (in-memory list). 10.5 review: on the `mx` surface
 * (inbound port 25) automatic entries do not apply — manual ones do.
 */
export function ipAccessVerdict(rawIp: string | null | undefined, surface: IpAccessSurface = 'client'): IpVerdict {
  const ip = normalizeIp(rawIp);
  if (!ip || isIP(ip) === 0) return 'none';
  if (isLoopbackIp(ip) || envExempt.isExempt(ip)) return 'allow';
  return current().verdict(ip, surface);
}

/** True when an ALLOW rule of the BCP list covers the IP (the lockout exemption). */
export function isAllowListed(rawIp: string | null | undefined): boolean {
  return current().verdict(rawIp) === 'allow';
}

/** Drops the cache: the next access reloads (lazy mode) — call after a change in this process. */
export function invalidateIpAccessRules(): void {
  state.loadedAt = 0;
  state.failedAt = 0;
  if (state.lazy) void refreshIpAccessRules();
}

/** Test seam: fixed rules (null = back to the database cache). */
export function setIpAccessRulesForTests(rules: readonly IpRule[] | null): void {
  state.override = rules ? buildIpAccessMatcher(rules) : null;
}

/** Reload signal of a block list / exception change on CHANNEL_SETTINGS_RELOAD. */
export const IP_ACCESS_RELOAD = 'ip-access';

/** True for a CHANNEL_SETTINGS_RELOAD message about the IP rules (pure). */
export function isIpAccessReload(message: string): boolean {
  try {
    return (JSON.parse(message) as { type?: unknown } | null)?.type === IP_ACCESS_RELOAD;
  } catch {
    return false;
  }
}

/**
 * Tells every service to reload the IP rules (and reloads this process). Uses
 * the process's Redis client only when it exists (services always have one;
 * unit tests never open a connection) — without it services reload within 60 s.
 */
export async function publishIpAccessReload(): Promise<void> {
  invalidateIpAccessRules();
  try {
    // Not awaited: a Redis outage must not hold the admin request (ioredis retries).
    const r = peekRedisClient();
    if (r) void r.publish(CHANNEL_SETTINGS_RELOAD, JSON.stringify({ type: IP_ACCESS_RELOAD }))
      .catch((err: unknown) => log.warn({ err }, 'Could not publish the IP rule reload signal — services reload within 60 s'));
  } catch (err) {
    log.warn({ err }, 'Could not publish the IP rule reload signal — services reload within 60 s');
  }
}

let subscribed = false;
let timer: NodeJS.Timeout | null = null;

/**
 * Loads the rules now, refreshes them every 60 s and reloads on every change of
 * any instance (CHANNEL_SETTINGS_RELOAD {type:'ip-access'}). Idempotent; call
 * once at service start (SMTP/IMAP/POP3/api-gateway via startAttackProtection).
 */
export function startIpAccessSubscriber(): void {
  enableIpAccessRuntime();
  if (!timer) {
    timer = setInterval(() => { void refreshIpAccessRules(); }, REFRESH_MS);
    timer.unref();
  }
  if (subscribed) return;
  subscribed = true;
  try {
    const sub = getRedisClient().duplicate();
    sub.on('error', (err) => log.warn({ err }, 'IP rule subscriber error'));
    sub.on('message', (_channel: string, message: string) => {
      if (isIpAccessReload(message)) void refreshIpAccessRules();
    });
    void sub.subscribe(CHANNEL_SETTINGS_RELOAD).catch((err: unknown) => log.warn({ err }, 'IP rule subscribe failed'));
  } catch (err) {
    log.warn({ err }, 'IP rule subscriber not started — the 60 s refresh applies');
  }
}

/** Number of active rules in this process (health/logging). */
export function ipAccessRuleCounts(): { blocks: number; allows: number; loadedAt: number } {
  const m = current();
  return { blocks: m.blocks, allows: m.allows, loadedAt: state.loadedAt };
}
