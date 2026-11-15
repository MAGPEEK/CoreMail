/**
 * The shared logger redacts credentials (pino `redact`).
 * Run: node --import tsx --test src/logger/redact.test.ts  (in packages/core)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import pino from 'pino';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['NODE_ENV'] = 'test';

const { LOG_REDACT, logger } = await import('./index.js');

function capture(): { log: pino.Logger; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const dest = new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } });
  const log = pino({ redact: LOG_REDACT }, dest);
  return { log, lines: () => chunks.join('').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>) };
}

test('top-level and nested secrets are replaced, other fields stay', () => {
  const { log, lines } = capture();
  log.info({
    password: 'p1', token: 't1', refreshToken: 'r1', user: 'alice',
    body: { password: 'p2', currentPassword: 'p3', newPassword: 'p4', email: 'a@b.c' },
  }, 'login');
  const [l] = lines();
  assert.equal(l!['password'], '[Redacted]');
  assert.equal(l!['token'], '[Redacted]');
  assert.equal(l!['refreshToken'], '[Redacted]');
  assert.equal(l!['user'], 'alice');
  const body = l!['body'] as Record<string, unknown>;
  assert.equal(body['password'], '[Redacted]');
  assert.equal(body['currentPassword'], '[Redacted]');
  assert.equal(body['newPassword'], '[Redacted]');
  assert.equal(body['email'], 'a@b.c');
});

test('request/response headers: authorization, cookie, set-cookie, internal token', () => {
  const { log, lines } = capture();
  log.info({
    req: { method: 'GET', headers: { authorization: 'Bearer abc', cookie: 'cm_sso=x', 'x-internal-token': 'it', host: 'h' } },
    res: { headers: { 'set-cookie': ['a=b'], 'content-type': 'text/plain' } },
    headers: { authorization: 'Basic eDp5' },
  });
  const [l] = lines();
  const req = l!['req'] as { headers: Record<string, unknown> };
  assert.equal(req.headers['authorization'], '[Redacted]');
  assert.equal(req.headers['cookie'], '[Redacted]');
  assert.equal(req.headers['x-internal-token'], '[Redacted]');
  assert.equal(req.headers['host'], 'h');
  const res = l!['res'] as { headers: Record<string, unknown> };
  assert.equal(res.headers['set-cookie'], '[Redacted]');
  assert.equal(res.headers['content-type'], 'text/plain');
  assert.equal((l!['headers'] as Record<string, unknown>)['authorization'], '[Redacted]');
});

test('child loggers inherit the redaction (createLogger pattern)', () => {
  const chunks: string[] = [];
  const dest = new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } });
  pino({ redact: LOG_REDACT }, dest).child({ service: 'x' }).info({ secret: 's', accessToken: 'a' });
  const l = JSON.parse(chunks[0]!) as Record<string, unknown>;
  assert.equal(l['secret'], '[Redacted]');
  assert.equal(l['accessToken'], '[Redacted]');
  assert.equal(l['service'], 'x');
});

test('the process logger is built with the redaction', () => {
  // pino stores the compiled redaction on a symbol; serialize a child and check the stringifier.
  const sym = Object.getOwnPropertySymbols(logger).find((s) => String(s) === 'Symbol(pino.stringifiers)');
  assert.ok(sym, 'pino stringifiers symbol present');
  const stringifiers = (logger as unknown as Record<symbol, Record<string, unknown>>)[sym!]!;
  assert.ok('password' in stringifiers && 'req' in stringifiers, 'redaction compiled for password and req');
});
