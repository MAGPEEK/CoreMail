import { getRedisClient, greylistKey, createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage/prisma';

const log = createLogger('security-filter:greylisting');

// Defaults — overridden by SmtpSettings (TTL 60s in `getOpts()`)
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

function isExempt(opts: GreylistOpts, ip: string, sender: string): boolean {
  if (opts.whitelist.length === 0) return false;
  const senderLc = sender.toLowerCase();
  const senderDomain = senderLc.includes('@') ? senderLc.split('@')[1] : '';
  for (const entry of opts.whitelist) {
    if (entry === ip.toLowerCase()) return true;            // IP match
    if (entry === senderLc) return true;                    // sender address
    if (senderDomain && entry === senderDomain) return true; // Domain
    if (entry.includes('/') && ip.startsWith(entry.split('/')[0]!.split('.').slice(0, 3).join('.'))) {
      // /24 approximation for CIDR notation — more robust CIDR logic would be better, but this is "good enough" for SMBs.
      return true;
    }
  }
  return false;
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
