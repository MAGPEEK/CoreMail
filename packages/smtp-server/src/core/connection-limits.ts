/**
 * BCP → SMTP → Connection settings (SmtpSettings) → session/listener limits (pure).
 *
 * Defaults equal the Prisma schema defaults, so a missing row behaves like a
 * fresh install. Values are clamped to the ranges the admin API accepts.
 */

export interface SmtpConnectionLimitsRow {
  maxConnections?: number | null;
  maxConnectionsPerIp?: number | null;
  connectionTimeoutSec?: number | null;
  greetingDelaySec?: number | null;
  maxAuthFailures?: number | null;
}

export interface SmtpConnectionLimits {
  /** Concurrent connections over all listeners and IPs. */
  maxConnections: number;
  /** Concurrent connections per client IP (public IPs; private/loopback are exempt). */
  maxConnectionsPerIp: number;
  /** Idle timeout for the greeting reply / next command. */
  commandTimeoutMs: number;
  /** Delay of the 220 greeting on port 25 (0 = off). */
  greetingDelayMs: number;
  /** Failed AUTH attempts per session before 421 + disconnect. */
  maxAuthFailures: number;
}

function int(v: number | null | undefined, def: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return def;
  return Math.min(max, Math.max(min, Math.trunc(v)));
}

/** A positive integer from an explicitly set env var, otherwise undefined. */
function envInt(env: Record<string, string | undefined>, name: string): number | undefined {
  const raw = env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return n > 0 ? n : undefined;
}

/**
 * Precedence: an explicitly set env var wins over the DB value, so operators
 * who tuned the limit before 9.2 (when only the env existed) keep it:
 *  - SMTP_MAX_CONNS_PER_IP → maxConnectionsPerIp (pre-9.2: the only per-IP knob).
 * maxAuthFailures had no env var before 9.2 (code default 3) — the DB value
 * (BCP, default 5) applies. The other settings are DB-only as well.
 */
export function smtpConnectionLimits(
  row: SmtpConnectionLimitsRow | null | undefined,
  env: Record<string, string | undefined> = process.env,
): SmtpConnectionLimits {
  return {
    maxConnections:      int(row?.maxConnections, 100, 1, 10_000),
    maxConnectionsPerIp: envInt(env, 'SMTP_MAX_CONNS_PER_IP') ?? int(row?.maxConnectionsPerIp, 10, 1, 1_000),
    commandTimeoutMs:    int(row?.connectionTimeoutSec, 300, 30, 3_600) * 1000,
    greetingDelayMs:     int(row?.greetingDelaySec, 0, 0, 30) * 1000,
    maxAuthFailures:     int(row?.maxAuthFailures, 5, 1, 100),
  };
}
