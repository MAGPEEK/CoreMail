import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_SETUP_KEYS, clientSetupRows, clientSetupStatus, clientSetupSummary } from './dnsClientSetup.ts';

const rec = (ok: boolean, warning?: string) => ({
  type: 'SRV', name: '_imaps._tcp', expected: '0 1 993 mail.example.com.', ok, found: null, recommended: true,
  ...(warning ? { warning } : {}),
});

test('recommended records are green or yellow, never an error state', () => {
  assert.equal(clientSetupStatus(rec(true)), 'ok');
  assert.equal(clientSetupStatus(rec(false)), 'recommended');
  assert.equal(clientSetupStatus(rec(false, 'points elsewhere')), 'warning');
});

test('rows follow the fixed display order and skip unknown/missing keys', () => {
  const all = Object.fromEntries(CLIENT_SETUP_KEYS.map(([k]) => [k, rec(k === 'imaps')]));
  const rows = clientSetupRows({ ...all, bogus: rec(true) });
  assert.deepEqual(rows.map((r) => r.key), CLIENT_SETUP_KEYS.map(([k]) => k));
  assert.equal(rows[0]!.labelKey, 'domain_dns_rec_submissions');
  assert.equal(rows.find((r) => r.key === 'autodiscoverSrv')!.labelKey, 'domain_dns_rec_autodiscover_srv');
  assert.deepEqual(clientSetupSummary(rows), { ok: 1, total: 11 });
  assert.deepEqual(clientSetupRows(undefined), []);
  assert.deepEqual(clientSetupRows({ imap: rec(false) }).map((r) => r.key), ['imap']);
});
