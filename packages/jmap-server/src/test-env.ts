/** Preload for `node --test`: @coremail/core validates the environment on import. */
process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['REDIS_URL'] ??= 'redis://localhost:6379';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
(globalThis as { __realtimeRedis?: unknown }).__realtimeRedis ??= null; // 9.4: realtime events go nowhere in tests
(globalThis as { __sendRateRedis?: unknown }).__sendRateRedis ??= null; // 10.5: send rate limiter counts in process
