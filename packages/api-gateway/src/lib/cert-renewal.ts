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
/**
 * Per-cert lock: held from the start of a run until the ACME work has really
 * stopped (released by onSettled). The TTL only matters when the process dies;
 * since 9.2.x a cancelled run stops within seconds (every CA call is
 * abortable), so the timeout plus a minute is enough.
 */
export const RENEW_LOCK_TTL_MS = ACME_TIMEOUT_MS + 60_000;
/** PENDING / RENEWING without a lock holder for this long = run died (restart) → ERROR. */
export const STALE_RUN_GRACE_MS = 2 * 60_000;
const BACKOFF_TTL_S    = 30 * 24 * 3600;
const CHECK_INTERVAL_MS = 60 * 60_000;
const STARTUP_DELAY_MS  = 60_000;
const SCHEDULER_LOCK_TTL_MS = CHECK_INTERVAL_MS - 5 * 60_000;

/**
 * Liveness of a lock holder (9.2.x review): every run refreshes
 * `cert:renew:hb:<certId>` (TTL HEARTBEAT_TTL_MS) while it holds the lock, and
 * the lock value carries `<instance>:<run id>:<acquiredAtMs>`. A lock whose
 * heartbeat is gone belongs to a run that died (restart) — it is taken over
 * right away instead of blocking "Retry" until the lock TTL expires.
 */
const HEARTBEAT_PREFIX = 'cert:renew:hb:';
export const HEARTBEAT_TTL_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
/** Identifies this process in lock values. */
const INSTANCE_ID = randomUUID().slice(0, 8);

/** Minimal Redis surface used here (ioredis-compatible) — injectable for tests. */
export interface RenewRedis {
  set(key: string, value: string, px: 'PX', ttl: number, nx?: 'NX'): Promise<'OK' | null>;
  get(key: string): Promise<string | null>;
  setex(key: string, seconds: number, value: string): Promise<unknown>;
  del(key: string): Promise<number>;
  exists(key: string): Promise<number>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
  /** Remaining lock lifetime (ms) — optional; used for "locked until" messages. */
  pttl?(key: string): Promise<number>;
}

function redis(): RenewRedis {
  // Test seam: globalThis.__certRenewRedis (in-memory fake).
  return (globalThis as { __certRenewRedis?: RenewRedis }).__certRenewRedis
    ?? getRedisClient() as unknown as RenewRedis;
}

/** Certs with a renewal running in this process. */
const inFlight = new Set<string>();

// ── Locks ─────────────────────────────────────────────────────────────────────

export async function acquireRenewLock(r: RenewRedis, certId: string, now = Date.now()): Promise<string | null> {
  const token = `${INSTANCE_ID}:${randomUUID()}:${now}`;
  const ok = await r.set(`${LOCK_PREFIX}${certId}`, token, 'PX', RENEW_LOCK_TTL_MS, 'NX');
  if (ok !== 'OK') return null;
  await beatHeart(r, certId, token);
  return token;
}

async function beatHeart(r: RenewRedis, certId: string, token: string): Promise<void> {
  await r.set(`${HEARTBEAT_PREFIX}${certId}`, token, 'PX', HEARTBEAT_TTL_MS)
    .catch((err: unknown) => log.warn({ err, certId }, 'Renew lock heartbeat failed'));
}

const RELEASE_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

export async function releaseRenewLock(r: RenewRedis, certId: string, token: string): Promise<void> {
  await r.eval(RELEASE_SCRIPT, 1, `${LOCK_PREFIX}${certId}`, token);
  await r.eval(RELEASE_SCRIPT, 1, `${HEARTBEAT_PREFIX}${certId}`, token).catch(() => undefined);
}

/** `<instance>:<run id>:<acquiredAtMs>`; null for values of older versions / foreign holders. */
export function parseLockValue(value: string): { instance: string; acquiredAt: number } | null {
  const m = /^([0-9a-f]{8}):[0-9a-f-]{36}:(\d{10,})$/.exec(value);
  return m ? { instance: m[1]!, acquiredAt: Number(m[2]) } : null;
}

export type RenewLockState =
  | { held: false }
  | { held: true; alive: boolean; value: string; until?: Date };

/**
 * Who holds the per-certificate lock and whether that run is still alive:
 * alive while the run is in flight in this process, or while its heartbeat
 * exists, or while the lock is younger than one heartbeat period.
 * Unparseable values (older versions) count as alive — their TTL bounds them.
 */
export async function renewLockState(r: RenewRedis, certId: string, now = Date.now()): Promise<RenewLockState> {
  const key = `${LOCK_PREFIX}${certId}`;
  const value = await r.get(key);
  if (value === null) return { held: false };
  const ttl = r.pttl ? await r.pttl(key).catch(() => -1) : -1;
  const until = ttl > 0 ? { until: new Date(now + ttl) } : {};
  const parsed = parseLockValue(value);
  let alive: boolean;
  if (!parsed) alive = true;
  else if (parsed.instance === INSTANCE_ID && inFlight.has(certId)) alive = true;
  else if ((await r.exists(`${HEARTBEAT_PREFIX}${certId}`)) === 1) alive = true;
  else alive = now - parsed.acquiredAt < HEARTBEAT_TTL_MS;
  return { held: true, alive, value, ...until };
}

export async function isRenewLockHeld(r: RenewRedis, certId: string): Promise<boolean> {
  if (inFlight.has(certId)) return true;
  const state = await renewLockState(r, certId);
  return state.held && state.alive;
}

/** Removes the lock of a run that no longer exists (compare-and-delete on the observed value). */
async function takeOverDeadLock(r: RenewRedis, certId: string): Promise<{ until?: Date } | null> {
  const state = await renewLockState(r, certId);
  if (!state.held) return null;
  if (state.alive) return state.until ? { until: state.until } : {};
  await r.eval(RELEASE_SCRIPT, 1, `${LOCK_PREFIX}${certId}`, state.value);
  log.warn({ certId }, 'Renew lock of a run that no longer exists (no heartbeat) taken over');
  return null;
}

/** "noch gesperrt bis 14:05 UTC" (server time zone) for the BCP. */
export function lockedUntilText(until: Date): string {
  const time = until.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  return `noch gesperrt bis ${time}`;
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
  | {
    started: false; reason: 'not-found' | 'not-letsencrypt' | 'no-acme-email' | 'locked' | 'in-progress'; status?: string;
    /** When the lock of the running (live) holder expires at the latest. */
    lockedUntil?: Date;
  };

/**
 * Starts an ACME run for a Let's Encrypt certificate: first issuance
 * ('issue', from POST /letsencrypt), a manual retry / renewal ('manual') or a
 * scheduled renewal. Returns immediately; the ACME work runs in the background.
 *
 * The per-certificate Redis lock is the source of truth for "a run is
 * active": every run holds it until its work has stopped. A PENDING/RENEWING
 * status whose lock is free therefore belongs to a run that died (server
 * restart) and may be restarted — no certificate stays "in progress" forever.
 * The Let's Encrypt environment (production / staging) is the one stored with
 * the certificate (`acmeStaging`), also for retries and scheduled renewals.
 */
export async function startRenewal(certId: string, trigger: 'manual' | 'scheduler' | 'issue'): Promise<StartRenewalResult> {
  const cert = await prisma.certificate.findUnique({
    where: { id: certId },
    select: {
      id: true, type: true, status: true, domains: true, acmeEmail: true, autoRenew: true,
      acmeStaging: true, certPem: true,
    },
  });
  if (!cert) return { started: false, reason: 'not-found' };
  if (cert.type !== 'LETSENCRYPT') return { started: false, reason: 'not-letsencrypt' };
  if (!cert.acmeEmail) return { started: false, reason: 'no-acme-email' };
  const inProgress = cert.status === 'PENDING' || cert.status === 'RENEWING';
  // The scheduler never touches a certificate that looks busy.
  if (trigger === 'scheduler' && inProgress) return { started: false, reason: 'in-progress', status: cert.status };
  if (inFlight.has(certId)) return { started: false, reason: inProgress ? 'in-progress' : 'locked', status: cert.status };

  const r = redis();
  let token = await acquireRenewLock(r, certId);
  if (!token) {
    // 9.2.x review: the holder may have died with its process — take its lock
    // over when its heartbeat is gone, otherwise report until when it is locked.
    const live = await takeOverDeadLock(r, certId);
    if (!live) token = await acquireRenewLock(r, certId);
    if (!token) {
      return {
        started: false, reason: inProgress ? 'in-progress' : 'locked', status: cert.status,
        ...(live?.until ? { lockedUntil: live.until } : {}),
      };
    }
  }
  const lockToken = token;
  inFlight.add(certId);
  const heartbeat = setInterval(() => { void beatHeart(r, certId, lockToken); }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  const release = async () => {
    clearInterval(heartbeat);
    inFlight.delete(certId);
    await releaseRenewLock(r, certId, lockToken).catch(err => log.warn({ err, certId }, 'Failed to release renew lock'));
  };

  if (inProgress && trigger !== 'issue') {
    log.warn({ certId, status: cert.status }, 'Certificate was left in progress by a run that no longer exists — restarting');
  }
  const acmeEmail = cert.acmeEmail;
  // We hold the lock — no other run exists. First issuance = PENDING, else RENEWING;
  // the previous error is cleared so the BCP shows the running attempt.
  try {
    await prisma.certificate.update({
      where: { id: certId },
      data:  { status: cert.certPem ? 'RENEWING' : 'PENDING', lastError: null, lastErrorCode: null },
    });
  } catch (err) {
    await release();
    throw err;
  }

  log.info({ certId, trigger, domains: cert.domains, staging: cert.acmeStaging },
    trigger === 'issue' ? 'Certificate issuance started' : 'Certificate renewal started');
  void runAcmeIssuance(certId, cert.domains, acmeEmail, cert.autoRenew, cert.acmeStaging, {
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

// ── Stale in-progress states ──────────────────────────────────────────────────

export const INTERRUPTED_MESSAGE =
  'Certificate issuance was interrupted (server restart). Start it again with "Retry".';

/**
 * PENDING / RENEWING certificates without a lock holder (the run died with
 * the process) → ERROR, so they can be retried and never stay "in progress"
 * forever. Called at startup and on every scheduler pass.
 */
export async function repairStaleAcmeStates(now: Date = new Date(), graceMs = STALE_RUN_GRACE_MS): Promise<number> {
  const r = redis();
  const rows = await prisma.certificate.findMany({
    where:  { status: { in: ['PENDING', 'RENEWING'] } },
    select: { id: true, updatedAt: true },
  });
  let repaired = 0;
  for (const row of rows) {
    if (row.updatedAt && now.getTime() - row.updatedAt.getTime() < graceMs) continue;
    if (await isRenewLockHeld(r, row.id)) continue;
    const res = await prisma.certificate.updateMany({
      where: { id: row.id, status: { in: ['PENDING', 'RENEWING'] } },
      data:  { status: 'ERROR', lastError: INTERRUPTED_MESSAGE, lastErrorCode: 'interrupted' },
    });
    if (res.count > 0) {
      repaired++;
      log.warn({ certId: row.id }, 'Certificate left in progress by a dead run — set to ERROR (retry possible)');
    }
  }
  return repaired;
}

/**
 * 9.2.x review: the startup repair cannot reset a certificate whose (dead)
 * lock is still younger than one heartbeat period — run it once more after
 * the lock TTL (+ margin), so no certificate stays RENEWING until the next
 * hourly scheduler pass.
 */
export function scheduleStaleRepairAfterLockTtl(delayMs = RENEW_LOCK_TTL_MS + 30_000): ReturnType<typeof setTimeout> {
  const t = setTimeout(() => {
    void repairStaleAcmeStates()
      .then((n) => { if (n > 0) log.warn({ count: n }, 'Stale PENDING/RENEWING certificates reset to ERROR after the lock TTL'); })
      .catch((err) => log.warn({ err }, 'Delayed stale certificate repair failed (non-fatal)'));
  }, delayMs);
  t.unref();
  return t;
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

  await repairStaleAcmeStates(now).catch(err => log.warn({ err }, 'Stale certificate state repair failed'));

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
