/**
 * Bounded database logging (8.0.0). Each failed Autodiscover Basic login used to write a
 * `system_logs` row. Behind a reverse proxy without TRUST_PROXY every client shares one
 * (private) IP, which the lockout does not count per IP, so an unauthenticated client
 * could grow the table without limit. The pino log still records every attempt; the
 * database only gets a bounded sample per window — per key (IP) and in total — and the
 * next written row carries how many were left out.
 */
export interface LogBudgetOptions {
  /** Rows per key (e.g. client IP) and window. */
  perKey: number;
  /** Rows in total per window. */
  total: number;
  windowMs: number;
  now?: () => number;
}

export class LogBudget {
  private windowStart = 0;
  private totalUsed = 0;
  private perKeyUsed = new Map<string, number>();
  private suppressed = 0;
  private readonly now: () => number;

  constructor(private readonly opts: LogBudgetOptions) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * May a row for `key` be written now? `suppressedBefore` = rows left out since the
   * last written one (to record in that row). Memory is bounded: the key map is reset
   * every window and never holds more than `total + 1` keys with a granted row.
   */
  take(key: string): { ok: true; suppressedBefore: number } | { ok: false } {
    const t = this.now();
    if (t - this.windowStart >= this.opts.windowMs) {
      this.windowStart = t;
      this.totalUsed = 0;
      this.perKeyUsed.clear();
    }
    const used = this.perKeyUsed.get(key) ?? 0;
    if (this.totalUsed >= this.opts.total || used >= this.opts.perKey) {
      this.suppressed++;
      return { ok: false };
    }
    this.totalUsed++;
    this.perKeyUsed.set(key, used + 1);
    const suppressedBefore = this.suppressed;
    this.suppressed = 0;
    return { ok: true, suppressedBefore };
  }
}
