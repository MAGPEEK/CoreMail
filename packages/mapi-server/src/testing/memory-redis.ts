/**
 * In-memory Redis for the tests (test-only): the commands the session
 * registry and the local ID store use — strings with a TTL, INCRBY and sorted
 * sets. `now` is the clock TTLs are checked against (tests advance it).
 * One instance shared by two registries stands for two server instances on
 * one Redis.
 */
import type { SessionRedis } from '../session/registry.js';
import type { LocalIdRedis } from '../store/local-ids.js';

interface Entry { value: string; expires: number }

export class MemoryRedis implements SessionRedis, LocalIdRedis {
  readonly store = new Map<string, Entry>();
  readonly zsets = new Map<string, Map<string, number>>();
  now = 0;

  private live(key: string): Entry | undefined {
    const e = this.store.get(key);
    if (e && e.expires <= this.now) { this.store.delete(key); return undefined; }
    return e;
  }

  async set(key: string, value: string, mode: 'PX' | 'NX', ttlMs?: number): Promise<unknown> {
    if (mode === 'NX' && this.live(key)) return null;
    this.store.set(key, { value, expires: mode === 'PX' ? this.now + (ttlMs ?? 0) : Number.POSITIVE_INFINITY });
    return 'OK';
  }

  async pexpire(key: string, ttlMs: number): Promise<number> {
    const e = this.live(key);
    if (e) { e.expires = this.now + ttlMs; return 1; }
    return this.zsets.has(key) ? 1 : 0;
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) || this.zsets.delete(key) ? 1 : 0;
  }

  async incrby(key: string, n: number): Promise<number> {
    const current = BigInt(this.live(key)?.value ?? '0') + BigInt(n);
    this.store.set(key, { value: current.toString(), expires: Number.POSITIVE_INFINITY });
    return Number(current);
  }

  async zadd(key: string, score: number, member: string): Promise<unknown> {
    const set = this.zsets.get(key) ?? new Map<string, number>();
    set.set(member, score);
    this.zsets.set(key, set);
    return 1;
  }

  async zrem(key: string, member: string): Promise<unknown> {
    return this.zsets.get(key)?.delete(member) ? 1 : 0;
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    const sorted = [...(this.zsets.get(key) ?? new Map<string, number>())].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).map(([m]) => m);
    return sorted.slice(start, stop < 0 ? sorted.length + stop + 1 : stop + 1);
  }

  async zremrangebyscore(key: string, min: number | string, max: number | string): Promise<unknown> {
    const lo = min === '-inf' ? Number.NEGATIVE_INFINITY : Number(min);
    const hi = max === '+inf' ? Number.POSITIVE_INFINITY : Number(max);
    const set = this.zsets.get(key);
    for (const [m, s] of set ?? []) if (s >= lo && s <= hi) set!.delete(m);
    return 1;
  }
}
