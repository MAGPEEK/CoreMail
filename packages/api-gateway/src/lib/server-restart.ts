/**
 * Container restart from the BCP (10.4.2) — `POST /api/v1/admin/servers/restart`.
 *
 * Mechanism: the api-gateway runs as user `node` under supervisord (root, child
 * of tini = PID 1). It can neither signal supervisord nor use its control socket
 * (root-only, chmod 0700). Instead it writes a supervisor "process communication"
 * token to its own stdout (`stdout_capture_maxbytes` on [program:api-gateway]);
 * supervisord turns it into a PROCESS_COMMUNICATION_STDOUT event for the root
 * event listener `restart-watch` (infra/docker/restart-watch.py), which checks
 * that the event came from the api-gateway and sends SIGTERM to supervisord.
 * supervisord stops every program gracefully and exits, tini exits, the
 * container stops — and the restart policy (`restart: unless-stopped`,
 * Kubernetes `restartPolicy: Always`) starts it again. PostgreSQL, Redis and the
 * scanners are separate containers and keep running.
 *
 * Order (route): cooldown slot → audit row written (awaited) → 202 → after the
 * response has left, ~1 s delay → token. No audit row, no restart.
 */
import { getRedisClient, createLogger } from '@coremail/core';

const log = createLogger('admin:restart');

/** The token restart-watch accepts (must match infra/docker/restart-watch.py). */
export const RESTART_TOKEN = 'coremail:restart-container';
/** supervisor's capture-mode markers (supervisor.events.ProcessCommunicationEvent). */
export const CAPTURE_BEGIN = '<!--XSUPERVISOR:BEGIN-->';
export const CAPTURE_END = '<!--XSUPERVISOR:END-->';

/** What the BCP shows as the expected downtime. */
export const EXPECTED_DOWNTIME_SECONDS = 30;
/** One restart per this many seconds, server-wide. */
export const RESTART_COOLDOWN_SECONDS = 120;
/** Delay between the flushed 202 and the trigger. */
export const RESTART_DELAY_MS = 1000;

const COOLDOWN_KEY = 'admin:server-restart:cooldown';

export type RestartAvailability =
  | { available: true }
  | { available: false; reason: 'not-supervised' };

/**
 * The trigger only works inside the CoreMail container: supervisord sets
 * SUPERVISOR_ENABLED / SUPERVISOR_PROCESS_NAME for its programs. A gateway
 * started any other way (development, tests) has nobody to read the token.
 */
export function restartAvailability(env: NodeJS.ProcessEnv = process.env): RestartAvailability {
  return env['SUPERVISOR_ENABLED'] === '1' && env['SUPERVISOR_PROCESS_NAME'] === 'api-gateway'
    ? { available: true }
    : { available: false, reason: 'not-supervised' };
}

/** The exact bytes written to stdout — one write, below PIPE_BUF, so never interleaved. */
export function restartTokenLine(): string {
  return `${CAPTURE_BEGIN}${RESTART_TOKEN}${CAPTURE_END}\n`;
}

/** Hands the token to supervisord (see the module comment). */
export function writeRestartToken(write: (s: string) => unknown = (s) => process.stdout.write(s)): void {
  write(restartTokenLine());
}

export type CooldownClaim = { ok: true } | { ok: false; retryAfterSec: number };

interface CooldownRedis {
  set(key: string, value: string, mode: 'EX', seconds: number, flag: 'NX'): Promise<unknown>;
  ttl(key: string): Promise<number>;
  del(key: string): Promise<unknown>;
}

/**
 * Server-wide cooldown: Redis `SET NX EX` (survives the restart itself, so a
 * second click right after the container is back is refused too). Redis
 * unavailable → in-process timestamp (never "unlimited").
 */
export function createRestartCooldown(opts: {
  seconds?: number;
  redis?: () => CooldownRedis;
  now?: () => number;
} = {}) {
  const seconds = opts.seconds ?? RESTART_COOLDOWN_SECONDS;
  const now = opts.now ?? Date.now;
  const redis = opts.redis ?? (() => getRedisClient() as unknown as CooldownRedis);
  let localUntil = 0;

  async function claim(): Promise<CooldownClaim> {
    const t = now();
    if (localUntil > t) return { ok: false, retryAfterSec: Math.ceil((localUntil - t) / 1000) };
    try {
      const r = redis();
      const got = await r.set(COOLDOWN_KEY, String(t), 'EX', seconds, 'NX');
      if (got !== 'OK') {
        const ttl = await r.ttl(COOLDOWN_KEY).catch(() => seconds);
        return { ok: false, retryAfterSec: ttl > 0 ? ttl : seconds };
      }
    } catch (err) {
      log.warn({ err }, 'Restart cooldown: Redis unavailable — in-process cooldown only');
    }
    localUntil = t + seconds * 1000;
    return { ok: true };
  }

  /** Gives the slot back (the restart did not go ahead, e.g. the audit write failed). */
  async function release(): Promise<void> {
    localUntil = 0;
    try { await redis().del(COOLDOWN_KEY); } catch { /* expires on its own */ }
  }

  return { claim, release };
}
