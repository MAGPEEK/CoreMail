import { getRedisClient, greylistKey, createLogger } from '@coremail/core';

const log = createLogger('security-filter:greylisting');

const GREYLIST_WAIT_SECONDS = 300;   // 5 minutes
const GREYLIST_TTL_SECONDS  = 14400; // 4 hours — triplet expires if not retried
const WHITELIST_TTL_SECONDS = 2592000; // 30 days — successful senders stay whitelisted

const WHITELIST_PREFIX = 'greylist:white:';

export interface GreylistResult {
  action: 'pass' | 'defer';
  reason?: string;
}

export async function checkGreylist(
  senderIp: string,
  mailFrom: string,
  rcptTo: string,
): Promise<GreylistResult> {
  const redis = getRedisClient();

  // Check if IP is already whitelisted (sent successfully before)
  const whiteKey = `${WHITELIST_PREFIX}${senderIp}`;
  const whitelisted = await redis.exists(whiteKey);
  if (whitelisted) {
    return { action: 'pass' };
  }

  const key = greylistKey(senderIp, mailFrom, rcptTo);
  const existing = await redis.get(key);

  if (!existing) {
    // First attempt — create the triplet record
    await redis.set(key, Date.now().toString(), 'EX', GREYLIST_TTL_SECONDS);
    log.info({ senderIp, mailFrom, rcptTo }, 'Greylisting: first attempt, defer');
    return {
      action: 'defer',
      reason: `Greylisted. Please retry in ${GREYLIST_WAIT_SECONDS / 60} minutes.`,
    };
  }

  const firstSeenMs = parseInt(existing, 10);
  const elapsedSecs = (Date.now() - firstSeenMs) / 1000;

  if (elapsedSecs < GREYLIST_WAIT_SECONDS) {
    log.info({ senderIp, elapsedSecs }, 'Greylisting: too soon, defer');
    const waitRemaining = Math.ceil(GREYLIST_WAIT_SECONDS - elapsedSecs);
    return {
      action: 'defer',
      reason: `Greylisted. Please retry in ${waitRemaining} seconds.`,
    };
  }

  // Sender passed greylisting — whitelist the IP
  await redis.set(whiteKey, '1', 'EX', WHITELIST_TTL_SECONDS);
  await redis.del(key);
  log.info({ senderIp, mailFrom }, 'Greylisting: passed, IP whitelisted');

  return { action: 'pass' };
}
