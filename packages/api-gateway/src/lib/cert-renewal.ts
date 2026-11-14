/**
 * Certificate renewal scheduler (v6).
 *
 * - Runs shortly after api-gateway startup and then hourly.
 * - Only one api-gateway instance runs a check at a time (Redis scheduler lock).
 * - Recomputes ACTIVE / EXPIRING / EXPIRED from the PEM validity dates.
 * - Renews Let's Encrypt certs with autoRenew=true when <= 30 days remain,
 *   through the same ACME code path as a manual renewal (lib/cert-acme.ts).
 * - Never two concurrent renewals for one cert: per-certificate Redis lock
 *   (held until the ACME work has really finished) + in-process guard.
 * - Exponential backoff after failures (2h … 24h), lastError stays visible.
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '@coremail/storage';
import { getRedisClient, createLogger } from '@coremail/core';
import {
  decideRenewal, parseCertValidity, recomputeStatus,
  type CertStatus, type RenewalBackoff,
} from './cert-lifecycle.js';
import { runAcmeIssuance, publishTlsReload, ACME_TIMEOUT_MS } from './cert-acme.js';

const log = createLogger('cert-renewal');

const LOCK_PREFIX      = 'cert:renew:lock:';
const BACKOFF_PREFIX   = 'cert:renew:backoff:';
const SCHEDULER_LOCK   = 'cert:renew:scheduler';
/** Per-cert lock outlives the ACME timeout so a hanging zombie cannot overlap a new run. */
export const RENEW_LOCK_TTL_MS = ACME_TIMEOUT_MS * 3;
const BACKOFF_TTL_S    = 30 * 24 * 3600;
const CHECK_INTERVAL_MS = 60 * 60_000;
const STARTUP_DELAY_MS  = 60_000;
const SCHEDULER_LOCK_TTL_MS = CHECK_INTERVAL_MS - 5 * 60_000;

/** Minimal Redis surface used here (ioredis-compatible) — injectable for tests. */
export interface RenewRedis {
  set(key: string, value: string, px: 'PX', ttl: number, nx: 'NX'): Promise<'OK' | null>;
  get(key: string): Promise<string | null>;
  setex(key: string, seconds: number, value: string): Promise<unknown>;
  del(key: string): Promise<number>;
  exists(key: string): Promise<number>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

function redis(): RenewRedis {
  return getRedisClient() as unknown as RenewRedis;
}

/** Certs with a renewal running in this process. */
const inFlight = new Set<string>();

// ── Locks ─────────────────────────────────────────────────────────────────────

export async function acquireRenewLock(r: RenewRedis, certId: string): Promise<string | null> {
  const token = randomUUID();
  const ok = await r.set(`${LOCK_PREFIX}${certId}`, token, 'PX', RENEW_LOCK_TTL_MS, 'NX');
  return ok === 'OK' ? token : null;
}

const RELEASE_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

export async function releaseRenewLock(r: RenewRedis, certId: string, token: string): Promise<void> {
  await r.eval(RELEASE_SCRIPT, 1, `${LOCK_PREFIX}${certId}`, token);
}

export async function isRenewLockHeld(r: RenewRedis, certId: string): Promise<boolean> {
  return inFlight.has(certId) || (await r.exists(`${LOCK_PREFIX}${certId}`)) === 1;
}

// ── Backoff state ─────────────────────────────────────────────────────────────

export async function getBackoff(r: RenewRedis, certId: string): Promise<RenewalBackoff | null> {
  const raw = await r.get(`${BACKOFF_PREFIX}${certId}`);
  if (!raw) return null;
  try {
    const b = JSON.parse(raw) as RenewalBackoff;
    return typeof b.failures === 'number' && typeof b.lastFailureAt === 'number' ? b : null;
  } catch { return null; }
}

export async function recordRenewFailure(r: RenewRedis, certId: string, now = Date.now()): Promise<RenewalBackoff> {
  const prev = await getBackoff(r, certId);
  const next: RenewalBackoff = { failures: (prev?.failures ?? 0) + 1, lastFailureAt: now };
  await r.setex(`${BACKOFF_PREFIX}${certId}`, BACKOFF_TTL_S, JSON.stringify(next));
  return next;
}

export async function clearBackoff(r: RenewRedis, certId: string): Promise<void> {
  await r.del(`${BACKOFF_PREFIX}${certId}`);
}


// ── Start one renewal ─────────────────────────────────────────────────────────

export type StartRenewalResult =
  | { started: true }
  | { started: false; reason: 'not-found' | 'not-letsencrypt' | 'no-acme-email' | 'locked' | 'in-progress'; status?: string };

/**
 * Starts the renewal of a Let's Encrypt certificate (manual or scheduled).
 * Returns immediately; the ACME work runs in the background.
 */
export async function startRenewal(certId: string, trigger: 'manual' | 'scheduler'): Promise<StartRenewalResult> {
  const cert = await prisma.certificate.findUnique({
    where: { id: certId },
    select: { id: true, type: true, status: true, domains: true, acmeEmail: true, autoRenew: true },
  });
  if (!cert) return { started: false, reason: 'not-found' };
  if (cert.type !== 'LETSENCRYPT') return { started: false, reason: 'not-letsencrypt' };
  if (!cert.acmeEmail) return { started: false, reason: 'no-acme-email' };
  if (cert.status === 'PENDING' || cert.status === 'RENEWING') {
    return { started: false, reason: 'in-progress', status: cert.status };
  }
  if (inFlight.has(certId)) return { started: false, reason: 'locked' };

  const r = redis();
  const token = await acquireRenewLock(r, certId);
  if (!token) return { started: false, reason: 'locked' };
  inFlight.add(certId);

  const release = async () => {
    inFlight.delete(certId);
    await releaseRenewLock(r, certId, token).catch(err => log.warn({ err, certId }, 'Failed to release renew lock'));
  };

  // Conditional transition — loses against a concurrent PENDING/RENEWING switch.
  let moved: { count: number };
  try {
    moved = await prisma.certificate.updateMany({
      where: { id: certId, status: { notIn: ['PENDING', 'RENEWING'] } },
      data:  { status: 'RENEWING' },
    });
  } catch (err) {
    await release();
    throw err;
  }
  if (moved.count === 0) {
    await release();
    return { started: false, reason: 'in-progress' };
  }

  log.info({ certId, trigger, domains: cert.domains }, 'Certificate renewal started');
  void runAcmeIssuance(certId, cert.domains, cert.acmeEmail, cert.autoRenew, false, {
    isRenewal: true,
    onSettled: release,
  })
    .then(async () => {
      await clearBackoff(r, certId).catch(() => {});
      log.info({ certId, trigger }, 'Certificate renewed');
    })
    .catch(async (err: unknown) => {
      const b = await recordRenewFailure(r, certId).catch(() => null);
      log.error({ err, certId, trigger, failures: b?.failures }, 'Certificate renewal failed — backing off');
    });

  return { started: true };
}

// ── Periodic check ────────────────────────────────────────────────────────────

/**
 * One scheduler pass: recompute statuses and start due renewals.
 * Returns a summary (used by logs).
 */
export async function runRenewalCheck(now: Date = new Date()): Promise<{ updated: number; renewals: number; skipped?: string }> {
  const r = redis();
  const got = await r.set(SCHEDULER_LOCK, randomUUID(), 'PX', SCHEDULER_LOCK_TTL_MS, 'NX');
  if (got !== 'OK') return { updated: 0, renewals: 0, skipped: 'another instance ran the check' };

  const certs = await prisma.certificate.findMany({
    select: {
      id: true, name: true, type: true, status: true, autoRenew: true, acmeEmail: true,
      domains: true, certPem: true, expiresAt: true,
    },
  });

  let updated = 0;
  let renewals = 0;
  let newlyExpired = false;

  for (const cert of certs) {
    const validTo = parseCertValidity(cert.certPem)?.validTo ?? cert.expiresAt;
    const current = cert.status as CertStatus;
    const next = recomputeStatus(current, validTo, now);
    const expiresChanged = !!validTo && cert.expiresAt?.getTime() !== validTo.getTime();
    if (next !== current || expiresChanged) {
      await prisma.certificate.update({
        where: { id: cert.id },
        data: { status: next, ...(validTo ? { expiresAt: validTo } : {}) },
      }).catch(err => log.warn({ err, certId: cert.id }, 'Status update failed'));
      updated++;
      if (next === 'EXPIRED' && current !== 'EXPIRED') {
        newlyExpired = true;
        log.warn({ certId: cert.id, name: cert.name, validTo }, 'Certificate expired');
      }
    }

    const decision = decideRenewal(
      { ...cert, status: next, certPem: cert.certPem, expiresAt: validTo ?? null },
      { now, backoff: await getBackoff(r, cert.id), lockHeld: await isRenewLockHeld(r, cert.id) },
    );
    if (decision.renew) {
      const res = await startRenewal(cert.id, 'scheduler').catch(err => {
        log.error({ err, certId: cert.id }, 'Failed to start renewal');
        return null;
      });
      if (res?.started) renewals++;
    } else if (decision.reason === 'backoff') {
      log.info({ certId: cert.id, retryAt: new Date(decision.retryAt ?? 0) }, 'Renewal due but backing off after failure');
    }
  }

  // Expired certs must drop out of the HTTPS proxy SNI map.
  if (newlyExpired) await publishTlsReload('');
  return { updated, renewals };
}

let started = false;

/** Starts the hourly certificate check (idempotent). */
export function startCertRenewalScheduler(): void {
  if (started) return;
  started = true;
  const tick = () => {
    void runRenewalCheck()
      .then(res => log.debug(res, 'Certificate renewal check done'))
      .catch(err => log.error({ err }, 'Certificate renewal check failed'));
  };
  setTimeout(tick, STARTUP_DELAY_MS).unref();
  setInterval(tick, CHECK_INTERVAL_MS).unref();
}
