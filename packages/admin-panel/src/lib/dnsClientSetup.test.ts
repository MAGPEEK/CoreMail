import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT_SETUP_KEYS, clientSetupRows, clientSetupStatus, clientSetupSummary, srvParts, srvZoneLine } from './dnsClientSetup.ts';

const rec = (ok: boolean, warning?: string) => ({
  type: 'SRV', name: '_imaps._tcp', expected: '0 1 993 mail.example.com.', ok, found: null, recommended: true,
  ...(warning ? { warning } : {}),
});

test('recommended records are green or yellow, never an error state', () => {
  assert.equal(clientSetupStatus(rec(true)), 'ok');
  assert.equal(clientSetupStatus(rec(false)), 'recommended');
  assert.equal(clientSetupStatus(rec(false, 'points elsewhere')), 'warning');
});

test('optional records (plain IMAP 143 / POP3 110) are grey when missing', () => {
  assert.equal(clientSetupStatus({ ok: false, optional: true }), 'optional');
  assert.equal(clientSetupStatus({ ok: true, optional: true }), 'ok');
  assert.equal(clientSetupStatus({ ok: false, optional: true, warning: 'x' }), 'warning');
});

test('rows follow the fixed display order and skip unknown/missing keys', () => {
  const all = Object.fromEntries(CLIENT_SETUP_KEYS.map(([k]) => [k, rec(k === 'imaps')]));
  const rows = clientSetupRows({ ...all, bogus: rec(true) });
  assert.deepEqual(rows.map((r) => r.key), CLIENT_SETUP_KEYS.map(([k]) => k));
  assert.equal(rows[0]!.labelKey, 'domain_dns_rec_submissions');
  assert.equal(rows.find((r) => r.key === 'autodiscoverSrv')!.labelKey, 'domain_dns_rec_autodiscover_srv');
  assert.equal(rows.find((r) => r.key === 'pop3')!.labelKey, 'domain_dns_rec_pop3');
  assert.deepEqual(clientSetupSummary(rows), { ok: 1, total: 12 });
  assert.deepEqual(clientSetupRows(undefined), []);
  assert.deepEqual(clientSetupRows({ imap: rec(false) }).map((r) => r.key), ['imap']);
});

test('optional records are not counted in the summary', () => {
  const rows = clientSetupRows({
    imaps: rec(true),
    imap: { ...rec(false), optional: true },
    pop3: { ...rec(true), optional: true },
    pop3s: rec(false),
  });
  assert.deepEqual(rows.map((r) => [r.key, r.optional]), [['imaps', false], ['imap', true], ['pop3s', false], ['pop3', true]]);
  assert.deepEqual(clientSetupSummary(rows), { ok: 1, total: 2 });
});

test('SRV split: server fields win, target without trailing dot', () => {
  assert.deepEqual(
    srvParts({ type: 'SRV', expected: '0 1 993 mail.example.com.', srv: { priority: 0, weight: 1, port: 993, target: 'mail.example.com.' } }),
    { priority: 0, weight: 1, port: 993, target: 'mail.example.com' },
  );
});

test('SRV split: falls back to parsing the zone-file string (older servers)', () => {
  assert.deepEqual(srvParts({ type: 'SRV', expected: '0 1 993 mail.example.com.' }),
    { priority: 0, weight: 1, port: 993, target: 'mail.example.com' });
  assert.deepEqual(srvParts({ type: 'SRV', expected: '10 0 443 mail.example.com' }),
    { priority: 10, weight: 0, port: 443, target: 'mail.example.com' });
  assert.equal(srvParts({ type: 'SRV', expected: 'garbage' }), null);
  assert.equal(srvParts({ type: 'TXT', expected: 'path=/dav/' }), null);
  assert.equal(srvParts({ type: 'CNAME', expected: 'mail.example.com' }), null);
});

test('zone-file line is fully qualified and keeps the trailing dots', () => {
  const p = { priority: 0, weight: 1, port: 993, target: 'mail.example.com' };
  assert.equal(srvZoneLine('_imaps._tcp', 'example.com', p), '_imaps._tcp.example.com. 3600 IN SRV 0 1 993 mail.example.com.');
  assert.equal(srvZoneLine('_imaps._tcp', 'example.com.', p, 300), '_imaps._tcp.example.com. 300 IN SRV 0 1 993 mail.example.com.');
  assert.equal(srvZoneLine('_imap._tcp', 'example.com', { priority: 0, weight: 0, port: 0, target: '' }),
    '_imap._tcp.example.com. 3600 IN SRV 0 0 0 .');
});
