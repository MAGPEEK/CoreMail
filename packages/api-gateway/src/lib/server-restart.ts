/**
 * Container restart from the BCP (10.4.2) — `POST /api/v1/admin/servers/restart`.
 *
 * Mechanism: the api-gateway runs as user `node` under supervisord (root, child
 * of tini = PID 1). It can neither signal supervisord nor use its control socket
 * (root-only, chmod 0700). The root event listener `restart-watch`
 * (infra/docker/restart-watch.py) writes a new random secret to
 * /var/run/supervisor/restart.token on every container start (root:node 0440).
 * To restart, this gateway writes that secret into
 * /var/run/supervisor/restart.request; the listener checks the file every 5 s
 * (TICK_5), compares in constant time and sends SIGTERM to supervisord, which
 * stops every program gracefully and exits; tini exits, the container stops and
 * its restart policy (`restart: unless-stopped`, Kubernetes `restartPolicy:
 * Always`) starts it again. PostgreSQL, Redis and the scanners are separate
 * containers and keep running.
 *
 * Deliberately NOT stdout: supervisor's capture mode would turn attacker text
 * in any log line (a login e-mail, a path) into events, and an injected BEGIN
 * marker would swallow every following log line. The secret is never logged.
 *
 * Order (route): cooldown slot → audit row written (awaited) → 202 → after the
 * response has left, ~1 s delay → request file. No audit row, no restart.
 */
import { accessSync, constants as fsConstants, readFileSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';

// Container paths — always POSIX (also when the tests run on Windows).
const { join } = posix;
import { getRedisClient, createLogger } from '@coremail/core';

const log = createLogger('admin:restart');

/** Directory shared with restart-watch (writable by supervisord's run dir owner). */
export function restartDir(env: NodeJS.ProcessEnv = process.env): string {
  return env['COREMAIL_RESTART_DIR'] || '/var/run/supervisor';
}
export const TOKEN_FILE_NAME = 'restart.token';
export const REQUEST_FILE_NAME = 'restart.request';
/** restart-watch writes 32 random bytes as hex. */
export const TOKEN_RE = /^[0-9a-f]{64}$/;

/** What the BCP shows as the expected downtime. */
export const EXPECTED_DOWNTIME_SECONDS = 30;
/** One restart per this many seconds, server-wide. */
export const RESTART_COOLDOWN_SECONDS = 120;
/** Delay between the flushed 202 and the trigger. */
export const RESTART_DELAY_MS = 1000;

const COOLDOWN_KEY = 'admin:server-restart:cooldown';

export type RestartAvailability =
  | { available: true }
  | { available: false; reason: 'not-supervised' | 'no-listener' };

function readable(path: string): boolean {
  try { accessSync(path, fsConstants.R_OK); return true; } catch { return false; }
}

/**
 * The trigger only works inside the CoreMail container: supervisord sets
 * SUPERVISOR_ENABLED / SUPERVISOR_PROCESS_NAME for its programs, and
 * restart-watch must have written its secret.
 */
export function restartAvailability(
  env: NodeJS.ProcessEnv = process.env,
  canRead: (path: string) => boolean = readable,
): RestartAvailability {
  if (env['SUPERVISOR_ENABLED'] !== '1' || env['SUPERVISOR_PROCESS_NAME'] !== 'api-gateway') {
    return { available: false, reason: 'not-supervised' };
  }
  return canRead(join(restartDir(env), TOKEN_FILE_NAME)) ? { available: true } : { available: false, reason: 'no-listener' };
}

export interface RestartFs {
  readFile: (path: string) => string;
  writeFile: (path: string, data: string) => void;
}
const realFs: RestartFs = {
  readFile: (p) => readFileSync(p, 'utf8'),
  // 0600, replaced if a stale one exists; restart-watch deletes it after reading
  writeFile: (p, d) => writeFileSync(p, d, { mode: 0o600 }),
};

/**
 * Hands the restart request to restart-watch: the current per-boot secret into
 * the request file. Throws when the secret is missing or malformed. Never logs it.
 */
export function writeRestartRequest(fs: RestartFs = realFs, env: NodeJS.ProcessEnv = process.env): void {
  const dir = restartDir(env);
  const secret = fs.readFile(join(dir, TOKEN_FILE_NAME)).trim();
  if (!TOKEN_RE.test(secret)) throw new Error('restart-watch secret missing or malformed');
  fs.writeFile(join(dir, REQUEST_FILE_NAME), `${secret}\n`);
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
 * unavailable → in-process timestamp (never "unlimited"). restart-watch keeps
 * its own once-per-2-minutes limit on top.
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
