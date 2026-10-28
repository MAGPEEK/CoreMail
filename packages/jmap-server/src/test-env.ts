/** Preload for `node --test`: @coremail/core validates the environment on import. */
process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['REDIS_URL'] ??= 'redis://localhost:6379';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
