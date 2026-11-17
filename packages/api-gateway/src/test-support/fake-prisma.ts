/**
 * Test-only Prisma fake for the `globalThis.__prisma` seam (v6 security tests).
 * Unknown models/methods resolve to harmless defaults; tests override what
 * they need via `models`. `$transaction(fn)` runs fn with the same fake
 * (serialised through a promise chain to mimic row locking).
 */
import { after } from 'node:test';

type Fn = (...args: unknown[]) => unknown;
export type ModelOverrides = Record<string, Record<string, Fn>>;

function defaultFor(method: string): unknown {
  if (method === 'count') return 0;
  if (method === 'findMany' || method === 'groupBy') return [];
  if (method.endsWith('Many')) return { count: 0 };
  if (method === 'aggregate') return { _sum: {}, _count: {} };
  return null;
}

export function installFakePrisma(models: ModelOverrides = {}): { models: ModelOverrides } {
  const state = { models };
  let chain: Promise<unknown> = Promise.resolve();
  const modelProxy = (name: string) => new Proxy({}, {
    get: (_t, method: string) => {
      const o = state.models[name]?.[method];
      if (o) return async (...a: unknown[]) => o(...a);
      return async () => defaultFor(method);
    },
  });
  const client: Record<string | symbol, unknown> = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === '$on' || prop === '$connect' || prop === '$disconnect' || prop === '$use') return () => undefined;
      if (prop === '$transaction') {
        return (arg: unknown) => {
          if (Array.isArray(arg)) return Promise.all(arg);
          const run = chain.then(() => (arg as (tx: unknown) => unknown)(client));
          chain = run.catch(() => undefined);
          return run;
        };
      }
      if (prop === 'then') return undefined;
      return modelProxy(String(prop));
    },
  });
  (globalThis as Record<string, unknown>)['__prisma'] = client;
  return state;
}

/** Apply a Prisma `select` (one level, nested selects copied as-is) to a row. */
export function applySelect(row: Record<string, unknown> | null, select?: Record<string, unknown>): Record<string, unknown> | null {
  if (!row || !select) return row;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(select)) if (v) out[k] = row[k];
  return out;
}

export function setTestEnv(): void {
  process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
  process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
  process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
  process.env['REDIS_URL'] ??= 'redis://127.0.0.1:1';
  process.env['LOG_LEVEL'] ??= 'error';
  // requireAuth consults the shared revocation markers (8.0.0): default to an
  // empty in-memory auth Redis (tests that need markers install their own).
  const g = globalThis as Record<string, unknown>;
  if (!g['__authRedis']) {
    const kv = new Map<string, string>();
    g['__authRedis'] = {
      async get(k: string) { return kv.get(k) ?? null; },
      async setex(k: string, _s: number, v: string) { kv.set(k, v); return 'OK'; },
      async del(k: string) { return kv.delete(k) ? 1 : 0; },
      async incr(k: string) { const n = Number(kv.get(k) ?? 0) + 1; kv.set(k, String(n)); return n; },
      async expire() { return 1; },
    };
  }
  // server.ts installs the same BigInt serializer (Prisma quota fields)
  (BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function (this: bigint) { return Number(this); };
  closeSharedRedisAfterTests();
}

let redisTeardownRegistered = false;
/**
 * Routes publish reloads / rate-limit hits through the lazily created shared
 * Redis client (`getRedisClient()`). In tests REDIS_URL points at a closed port,
 * so that client reconnects forever and its retry timer keeps the test process
 * alive after the last test. Close it once all tests of the file have run.
 * `@coremail/core` is imported lazily: the environment above must be set first.
 */
function closeSharedRedisAfterTests(): void {
  if (redisTeardownRegistered) return;
  redisTeardownRegistered = true;
  after(async () => {
    const { closeRedis } = await import('@coremail/core');
    await closeRedis();
  });
}
