/**
 * Preload for `node --test`: @coremail/core validates the environment on import,
 * and no unit test may reach a real database — any Prisma call fails loudly
 * unless the test installs its own fake (globalThis.__prisma) before importing
 * @coremail/storage.
 */
process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['REDIS_URL'] ??= 'redis://localhost:6379';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] ??= 'error';

const noDatabase = new Proxy({}, {
  get: (_target, model) => (model === '$on' ? () => undefined : new Proxy({}, {
    get: (_m, method) => () => Promise.reject(new Error(`unit test reached Prisma: ${String(model)}.${String(method)}`)),
  })),
});
(globalThis as unknown as { __prisma: unknown }).__prisma ??= noDatabase;
// 10.5: the send rate limiter (storage submission-rate.ts) counts in process — no Redis connection.
(globalThis as { __sendRateRedis?: unknown }).__sendRateRedis ??= null;
