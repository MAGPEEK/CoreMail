import { getRedisClient, greylistKey, createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage/prisma';
import { BlockList, isIP } from 'node:net';
import { normalizeSenderIp } from '../dnsbl/answer.js';

const log = createLogger('security-filter:greylisting');

// Single source of truth for greylisting: SmtpSettings (BCP → SMTP → Greylisting,
// the only page that edits all four fields incl. the whitelist). The BCP
// Protection page writes through to the same row (api-gateway admin/security.ts).
// Defaults — overridden by SmtpSettings (TTL 60s in `getOpts()`, invalidated on settings:reload)
const DEFAULT_WAIT_SECONDS     = 300;     // 5 min
const DEFAULT_TTL_HOURS        = 4;
const WHITELIST_TTL_SECONDS    = 2592000; // 30 days

const WHITELIST_PREFIX = 'greylist:white:';

interface GreylistOpts {
  waitSec:    number;
  ttlSec:     number;
  whitelist:  string[]; // IPs or sender emails / domains (case-insensitive)
  loadedAt:   number;
}
let _opts: GreylistOpts | null = null;
const OPTS_TTL_MS = 60_000;

async function getOpts(): Promise<GreylistOpts> {
  if (_opts && Date.now() - _opts.loadedAt < OPTS_TTL_MS) return _opts;
  try {
    const s = await prisma.smtpSettings.findUnique({
      where:  { id: 'singleton' },
      select: { greylistWaitSec: true, greylistTtlHours: true, greylistWhitelist: true },
    });
    const list = (s?.greylistWhitelist as unknown[] | null) ?? [];
    _opts = {
      waitSec:   s?.greylistWaitSec ?? DEFAULT_WAIT_SECONDS,
      ttlSec:    (s?.greylistTtlHours ?? DEFAULT_TTL_HOURS) * 3600,
      whitelist: list.filter((v): v is string => typeof v === 'string').map((v) => v.toLowerCase()),
      loadedAt:  Date.now(),
    };
  } catch (err) {
    log.warn({ err }, 'Greylist settings load failed — using defaults');
    _opts = {
      waitSec:   DEFAULT_WAIT_SECONDS,
      ttlSec:    DEFAULT_TTL_HOURS * 3600,
      whitelist: [],
      loadedAt:  Date.now(),
    };
  }
  return _opts;
}

export function invalidateGreylistOptsCache(): void {
  _opts = null;
}

/**
 * Pure: is the (ip, sender) pair exempt by the SmtpSettings.greylistWhitelist?
 * Entries: exact IP, CIDR (IPv4 or IPv6, real prefix matching via
 * net.BlockList), full sender address, or sender domain. Case-insensitive;
 * IPv4-mapped IPv6 client addresses are unwrapped first.
 */
export function isGreylistExempt(whitelist: readonly string[], rawIp: string, sender: string): boolean {
  if (whitelist.length === 0) return false;
  const ip = normalizeSenderIp(rawIp);
  const fam = isIP(ip);
  const senderLc = sender.toLowerCase();
  const senderDomain = senderLc.includes('@') ? senderLc.slice(senderLc.lastIndexOf('@') + 1) : '';
  for (const raw of whitelist) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry.includes('/')) {
      const [net = '', prefixStr = ''] = entry.split('/');
      const netNorm = normalizeSenderIp(net);
      const netFam = isIP(netNorm);
      const prefix = Number(prefixStr);
      if (!fam || !netFam || netFam !== fam || !/^\d{1,3}$/.test(prefixStr) || prefix > (netFam === 4 ? 32 : 128)) continue;
      const bl = new BlockList();
      try { bl.addSubnet(netNorm, prefix, netFam === 4 ? 'ipv4' : 'ipv6'); } catch { continue; }
      if (bl.check(ip, fam === 4 ? 'ipv4' : 'ipv6')) return true;
      continue;
    }
    if (fam && isIP(normalizeSenderIp(entry)) && normalizeSenderIp(entry) === ip) return true; // IP match
    if (entry === senderLc) return true;                      // sender address
    if (senderDomain && entry === senderDomain) return true;   // sender domain
  }
  return false;
}

function isExempt(opts: GreylistOpts, ip: string, sender: string): boolean {
  return isGreylistExempt(opts.whitelist, ip, sender);
}

export interface GreylistResult {
  action: 'pass' | 'defer';
  reason?: string;
}

export async function checkGreylist(
  senderIp: string,
  mailFrom: string,
  rcptTo: string,
): Promise<GreylistResult> {
  const opts = await getOpts();

  if (isExempt(opts, senderIp, mailFrom)) {
    log.debug({ senderIp, mailFrom }, 'Greylisting exempt — config whitelist match');
    return { action: 'pass' };
  }

  const redis = getRedisClient();

  // IP auto-whitelist (from an earlier successful triplet match)
  const whiteKey = `${WHITELIST_PREFIX}${senderIp}`;
  const whitelisted = await redis.exists(whiteKey);
  if (whitelisted) {
    return { action: 'pass' };
  }

  const key = greylistKey(senderIp, mailFrom, rcptTo);
  const existing = await redis.get(key);

  if (!existing) {
    await redis.set(key, Date.now().toString(), 'EX', opts.ttlSec);
    log.info({ senderIp, mailFrom, rcptTo, waitSec: opts.waitSec }, 'Greylisting: first attempt, defer');
    return {
      action: 'defer',
      reason: `Greylisted. Please retry in ${Math.ceil(opts.waitSec / 60)} minutes.`,
    };
  }

  const firstSeenMs = parseInt(existing, 10);
  const elapsedSecs = (Date.now() - firstSeenMs) / 1000;

  if (elapsedSecs < opts.waitSec) {
    const waitRemaining = Math.ceil(opts.waitSec - elapsedSecs);
    log.info({ senderIp, elapsedSecs, waitRemaining }, 'Greylisting: too soon, defer');
    return {
      action: 'defer',
      reason: `Greylisted. Please retry in ${waitRemaining} seconds.`,
    };
  }

  await redis.set(whiteKey, '1', 'EX', WHITELIST_TTL_SECONDS);
  await redis.del(key);
  log.info({ senderIp, mailFrom }, 'Greylisting: passed, IP whitelisted');

  return { action: 'pass' };
}
