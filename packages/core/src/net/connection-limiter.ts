/**
 * In-memory concurrent-connection limiter for the TCP mail protocols
 * (IMAP, POP3). Same idea as the SMTP limiter (smtp-server/src/core/ip-limiter.ts):
 *
 *  - per client IP: at most `maxPerIp` open connections (exempt IPs skip this
 *    check — e.g. loopback or operator-configured internal networks),
 *  - per process: at most `maxTotal` open connections, for every client.
 *
 * A limit <= 0 disables that check. `acquire()` returns a release function
 * that is idempotent, so it can be called from both 'close' and 'error'.
 */

export interface ConnectionLimiterOptions {
  maxPerIp: number;
  maxTotal: number;
  /** IPs that are not subject to the per-IP limit (they still count towards maxTotal). */
  isExempt?: (ip: string) => boolean;
}

export type ConnectionAcquireResult =
  | { ok: true; release: () => void }
  | { ok: false; reason: 'per_ip' | 'total'; current: number; limit: number };

/** IPv4-mapped IPv6 (`::ffff:1.2.3.4`) → `1.2.3.4`, strips an IPv6 zone. */
function normalize(ip: string | null | undefined): string {
  let v = (ip ?? '').trim();
  const zone = v.indexOf('%');
  if (zone !== -1) v = v.slice(0, zone);
  if (/^::ffff:\d{1,3}(?:\.\d{1,3}){3}$/i.test(v)) v = v.slice(7);
  return v;
}

/** Positive integer from an environment variable, otherwise the fallback. */
export function envLimit(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) ? n : fallback;
}

export class ConnectionLimiter {
  private readonly perIp = new Map<string, number>();
  private open = 0;

  constructor(private readonly opts: ConnectionLimiterOptions) {}

  /** Currently open connections (all IPs, or one IP). */
  count(ip?: string): number {
    return ip === undefined ? this.open : this.perIp.get(normalize(ip)) ?? 0;
  }

  acquire(rawIp: string | null | undefined): ConnectionAcquireResult {
    const ip = normalize(rawIp);
    const { maxTotal, maxPerIp } = this.opts;
    if (maxTotal > 0 && this.open >= maxTotal) {
      return { ok: false, reason: 'total', current: this.open, limit: maxTotal };
    }
    const exempt = !ip || (this.opts.isExempt?.(ip) ?? false);
    const current = this.perIp.get(ip) ?? 0;
    if (!exempt && maxPerIp > 0 && current >= maxPerIp) {
      return { ok: false, reason: 'per_ip', current, limit: maxPerIp };
    }
    this.open++;
    this.perIp.set(ip, current + 1);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.open = Math.max(0, this.open - 1);
        const n = (this.perIp.get(ip) ?? 1) - 1;
        if (n <= 0) this.perIp.delete(ip);
        else this.perIp.set(ip, n);
      },
    };
  }
}
