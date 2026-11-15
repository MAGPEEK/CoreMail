/**
 * v8.1: transport-rule `regex` conditions use the linear-time rule matcher
 * (no ReDoS on attacker-controlled subject/body), header removal is line-based.
 * Run: node --import tsx --test src/transport-rules.test.ts  (in packages/storage)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
(globalThis as Record<string, unknown>)['__prisma'] = { $on: () => undefined };

const { evaluateOp, removeHeaderFields } = await import('./transport-rules.js');

test('regex condition: same verdict as before for normal patterns, case-insensitive', () => {
  assert.equal(evaluateOp('invoice #1234 overdue', 'regex', 'INVOICE\\s+#\\d+'), true);
  assert.equal(evaluateOp('hello', 'regex', '^bye'), false);
  assert.equal(evaluateOp('hello', 'regex', '(['), false, 'invalid pattern never matches');
  assert.equal(evaluateOp('aa', 'regex', '(a)\\1'), false, 'backreference unsupported → no match');
});

test('regex condition: hostile input does not stall (ReDoS)', () => {
  const hostile = 'a'.repeat(30_000) + '!';
  const t0 = Date.now();
  assert.equal(evaluateOp(hostile, 'regex', '^(a+)+$'), false);
  assert.equal(evaluateOp(hostile, 'regex', '(a|aa)*b'), false);
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
});

test('removeHeaderFields: all occurrences, folded lines, last field, name is literal', () => {
  const h = ['From: a@b', 'X-Spam: yes', '\tcontinued', 'Subject: s', 'x-spam: again'].join('\r\n');
  assert.equal(removeHeaderFields(h, 'X-Spam'), 'From: a@b\r\nSubject: s');
  assert.equal(removeHeaderFields(h, 'X-.*'), h, 'regex metacharacters are not interpreted');
  assert.equal(removeHeaderFields(h, ''), h);
});
