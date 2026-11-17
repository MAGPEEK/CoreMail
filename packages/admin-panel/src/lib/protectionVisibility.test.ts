import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scannerVisible, scannerNotice, scannerNotices, visibleSections, resolveSection, absentScanners, reasonText,
  SCANNER_DOCS, HOST_NOT_FOUND_TEXT, type ScannerCapabilities, type ScannerCapability, type ProtectionSection,
} from './protectionVisibility.ts';

const cap = (state: ScannerCapability['state'], reason = state === 'available' ? 'ok' : state === 'absent' ? 'disabled-by-config' : 'connect-failed', detail?: string): ScannerCapability =>
  ({ state, reason, ...(detail ? { detail } : {}), checkedAt: '2026-11-17T08:00:00.000Z' });
const caps = (rspamd: ScannerCapability, clamav: ScannerCapability): ScannerCapabilities => ({ rspamd, clamav });

const NAV: { id: ProtectionSection }[] = [
  { id: 'overview' }, { id: 'rspamd' }, { id: 'antivirus' }, { id: 'dnsbl' }, { id: 'greylisting' }, { id: 'geoip' }, { id: 'attachments' },
];
const ids = (xs: { id: ProtectionSection }[]) => xs.map((x) => x.id);

test('unknown capabilities (loading, request failed) hide nothing', () => {
  assert.equal(scannerVisible(undefined), true);
  assert.deepEqual(ids(visibleSections(NAV, undefined)), ids(NAV));
  assert.deepEqual(scannerNotices(undefined), []);
  assert.deepEqual(absentScanners(undefined), { rspamd: false, clamav: false });
});

test('absent scanner: its section is hidden, a neutral info line with docs link is shown', () => {
  const c = caps(cap('absent'), cap('available'));
  assert.deepEqual(ids(visibleSections(NAV, c)), ['overview', 'antivirus', 'dnsbl', 'greylisting', 'geoip', 'attachments']);
  assert.deepEqual(scannerNotices(c), [{
    scanner: 'rspamd', tone: 'info',
    text: 'Spamfilter (rspamd) ist in dieser Installation nicht bereitgestellt.', docsUrl: SCANNER_DOCS.rspamd,
  }]);
  const clam = scannerNotice('clamav', cap('absent', 'disabled-by-config'));
  assert.equal(clam?.text, 'Virenscanner (ClamAV) ist in dieser Installation nicht bereitgestellt.');
  assert.match(clam?.docsUrl ?? '', /docs\/antivirus\.md$/);
});

test('both absent: the other protection sections remain', () => {
  const c = caps(cap('absent'), cap('absent', 'disabled-by-config'));
  assert.deepEqual(ids(visibleSections(NAV, c)), ['overview', 'dnsbl', 'greylisting', 'geoip', 'attachments']);
  assert.deepEqual(absentScanners(c), { rspamd: true, clamav: true });
  assert.deepEqual(scannerNotices(c).map((n) => [n.scanner, n.tone]), [['rspamd', 'info'], ['clamav', 'info']]);
});

test('unavailable scanner: settings stay, warning with the reason', () => {
  const c = caps(cap('available'), cap('unavailable', 'connect-failed', 'ECONNREFUSED'));
  assert.deepEqual(ids(visibleSections(NAV, c)), ids(NAV));
  const [n] = scannerNotices(c);
  assert.equal(n?.tone, 'warning');
  assert.equal(n?.scanner, 'clamav');
  assert.match(n!.text, /^Virenscanner \(ClamAV\) ist bereitgestellt, aber nicht erreichbar: Verbindung fehlgeschlagen \(ECONNREFUSED\)\./);
  assert.match(n!.text, /Signaturen/);
  assert.equal(n?.docsUrl, undefined);
  assert.match(scannerNotice('rspamd', cap('unavailable', 'timeout'))!.text, /Zeitüberschreitung.*ohne Spamprüfung/);
});

test('unavailable + host-not-found: warning names CLAMAV_HOST/RSPAMD_URL and the env switches; settings stay', () => {
  const c = caps(cap('unavailable', 'host-not-found', 'ENOTFOUND'), cap('unavailable', 'host-not-found', 'ENOTFOUND'));
  assert.deepEqual(ids(visibleSections(NAV, c)), ids(NAV));
  assert.deepEqual(absentScanners(c), { rspamd: false, clamav: false });
  const [r, cl] = scannerNotices(c);
  assert.equal(HOST_NOT_FOUND_TEXT, 'Host nicht gefunden: CLAMAV_HOST/RSPAMD_URL prüfen oder den Scanner mit CLAMAV_ENABLED=false bzw. RSPAMD_ENABLED=false als nicht bereitgestellt kennzeichnen.');
  for (const n of [r, cl]) {
    assert.equal(n?.tone, 'warning');
    assert.ok(n!.text.includes(HOST_NOT_FOUND_TEXT), n!.text);
  }
  assert.match(r!.text, /^Spamfilter \(rspamd\) ist nicht erreichbar\. Host nicht gefunden/);
  assert.match(cl!.text, /Fehlerbehandlung/);
});

test('available or not yet checked: no notice', () => {
  assert.equal(scannerNotice('rspamd', cap('available')), null);
  assert.equal(scannerNotice('clamav', cap('unavailable', 'not-checked')), null);
});

test('resolveSection falls back to the overview when the selected section was hidden', () => {
  const visible = visibleSections(NAV, caps(cap('available'), cap('absent')));
  assert.equal(resolveSection('antivirus', visible), 'overview');
  assert.equal(resolveSection('rspamd', visible), 'rspamd');
  assert.equal(resolveSection('dnsbl', visible), 'dnsbl');
});

test('reasonText: German text, unknown codes stay generic', () => {
  assert.equal(reasonText('host-not-found'), 'Host nicht gefunden');
  assert.equal(reasonText('bad-response', 'HTTP_503'), 'unerwartete Antwort (HTTP_503)');
  assert.equal(reasonText('something-new'), 'unbekannter Zustand');
});
