/**
 * 8.0.0: numeric env variables treat an empty value as unset (compose passes
 * `MINIO_PORT: ${MINIO_PORT:-}`) — before, `z.coerce.number()` turned "" into 0.
 * Run: node --import tsx --test src/config/config.test.ts  (in packages/core)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';

const { parseEnvConfig } = await import('./index.js');

const base = {
  DATABASE_URL: 'postgresql://u:p@db:5432/coremail',
  JWT_SECRET: 'x'.repeat(32),
  PEPPER: 'y'.repeat(32),
};

test('empty numeric variables fall back to their defaults (not 0)', () => {
  const r = parseEnvConfig({ ...base, MINIO_PORT: '', PORT: '  ', JWT_ACCESS_TTL: '', JWT_REFRESH_TTL: '' });
  assert.ok(r.success);
  assert.equal(r.data.MINIO_PORT, 9000);
  assert.equal(r.data.PORT, 3000);
  assert.equal(r.data.JWT_ACCESS_TTL, 900);
  assert.equal(r.data.JWT_REFRESH_TTL, 2592000);
});

test('set numeric variables are coerced; unset ones use the default; garbage is rejected', () => {
  const r = parseEnvConfig({ ...base, MINIO_PORT: '9443' });
  assert.ok(r.success);
  assert.equal(r.data.MINIO_PORT, 9443);
  assert.equal(r.data.PORT, 3000);
  assert.equal(parseEnvConfig({ ...base, MINIO_PORT: 'abc' }).success, false);
});

test('no well-known MinIO default credentials (minioadmin) in the core config', () => {
  const r = parseEnvConfig(base);
  assert.ok(r.success);
  assert.equal(r.data.MINIO_ACCESS_KEY, undefined);
  assert.equal(r.data.MINIO_SECRET_KEY, undefined);
  const set = parseEnvConfig({ ...base, MINIO_ACCESS_KEY: 'u', MINIO_SECRET_KEY: 'p' });
  assert.ok(set.success);
  assert.equal(set.data.MINIO_SECRET_KEY, 'p');
});
