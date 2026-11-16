import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayEndIso, dayStartIso, signatureFromHeader } from './auditFilters.ts';

test('audit date filters cover the whole local day', () => {
  const from = dayStartIso('2026-11-16')!;
  const to = dayEndIso('2026-11-16')!;
  assert.equal(new Date(from).getHours(), 0);
  assert.equal(new Date(from).getDate(), 16);
  assert.equal(new Date(to).getHours(), 23);
  assert.equal(new Date(to).getDate(), 16);
  assert.equal(new Date(to).getTime() - new Date(from).getTime(), 24 * 3600 * 1000 - 1);
  assert.equal(dayStartIso(''), null);
  assert.equal(dayEndIso('16.11.2026'), null);
});

test('export signature header', () => {
  const hex = 'a'.repeat(64);
  assert.equal(signatureFromHeader(`hmac-sha256=${hex}`), `hmac-sha256=${hex}`);
  assert.equal(signatureFromHeader(hex), hex);
  assert.equal(signatureFromHeader(null), null);
  assert.equal(signatureFromHeader('sha256=abc'), null);
});
