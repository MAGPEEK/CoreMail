import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STALE_IN_PROGRESS_MS, acmeActionLabel, acmeErrorHint, canStartAcme, isStaleInProgress, parseDomainList,
} from './certStatus.ts';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

test('retry is possible after a failure and for runs left over by a restart, never during a live run', () => {
  assert.equal(canStartAcme({ type: 'LETSENCRYPT', status: 'ERROR' }, NOW), true);
  assert.equal(canStartAcme({ type: 'LETSENCRYPT', status: 'ACTIVE' }, NOW), true);
  assert.equal(canStartAcme({ type: 'LETSENCRYPT', status: 'RENEWING', updatedAt: ago(60_000) }, NOW), false);
  assert.equal(canStartAcme({ type: 'LETSENCRYPT', status: 'PENDING', updatedAt: ago(STALE_IN_PROGRESS_MS + 1) }, NOW), true);
  assert.equal(canStartAcme({ type: 'CUSTOM', status: 'ERROR' }, NOW), false);
  assert.equal(isStaleInProgress({ type: 'LETSENCRYPT', status: 'ERROR', updatedAt: ago(1e9) }, NOW), false);
  assert.equal(isStaleInProgress({ type: 'LETSENCRYPT', status: 'RENEWING', updatedAt: null }, NOW), false);
});

test('button label distinguishes first issuance from renewal failures and stale runs', () => {
  assert.match(acmeActionLabel({ type: 'LETSENCRYPT', status: 'ERROR', issuedAt: null }, NOW), /Ausstellung fehlgeschlagen/);
  assert.match(acmeActionLabel({ type: 'LETSENCRYPT', status: 'ERROR', issuedAt: ago(1) }, NOW), /Erneuerung fehlgeschlagen/);
  assert.match(acmeActionLabel({ type: 'LETSENCRYPT', status: 'PENDING', updatedAt: ago(10_000) }, NOW), /läuft/);
  assert.match(acmeActionLabel({ type: 'LETSENCRYPT', status: 'RENEWING', updatedAt: ago(STALE_IN_PROGRESS_MS * 2) }, NOW), /erneut versuchen/);
  assert.match(acmeActionLabel({ type: 'LETSENCRYPT', status: 'EXPIRING', expiresAt: new Date(NOW + 5 * 86_400_000 + 1000).toISOString(), autoRenew: true }, NOW), /5 Tagen.*Auto-Renew/);
});

test('every server error code has a hint; unknown codes have none; no RFC numbers in texts', () => {
  for (const code of ['connection', 'unauthorized', 'dns', 'caa', 'rate-limited', 'rejected-identifier', 'tls',
    'account', 'local-serving', 'network', 'server', 'timeout', 'interrupted']) {
    const h = acmeErrorHint(code);
    assert.ok(h, code);
    assert.doesNotMatch(h!, /RFC\s*\d|Exchange/);
  }
  assert.equal(acmeErrorHint('unknown'), null);
  assert.equal(acmeErrorHint(null), null);
});

test('domain list parsing: lines, commas, blanks, case, duplicates', () => {
  assert.deepEqual(parseDomainList('Mail.Example.com\nautodiscover.example.com, mail.example.com\n\n'), ['mail.example.com', 'autodiscover.example.com']);
  assert.deepEqual(parseDomainList('   '), []);
});
