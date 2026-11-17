import { test } from 'node:test';
import assert from 'node:assert/strict';
import { protectionFeatureMatrix, type ProtectionSettingsLike } from './protectionStatus.ts';

const base: ProtectionSettingsLike = {
  greylistEnabled: true, greylistWaitSec: 300, dnsblEnabled: true, geoipMode: 'DISABLED', geoipCountries: [],
  attachmentEnabled: true, attachmentBlockedExt: ['exe', 'bat'], rspamdEnabled: true, clamavEnabled: true,
};
const row = (rows: ReturnType<typeof protectionFeatureMatrix>, label: string) => rows.find((r) => r.label === label)!;

test('rows follow the settings instead of being hard-coded as active', () => {
  const rows = protectionFeatureMatrix(
    { ...base, greylistEnabled: false, dnsblEnabled: false, attachmentEnabled: false },
    { rspamd: true, clamav: true }, ['zen.spamhaus.org'],
  );
  assert.equal(row(rows, 'Greylisting').ok, false);
  assert.equal(row(rows, 'DNSBL').ok, false);
  assert.equal(row(rows, 'Anhang-Filter').ok, false);
});

test('scanners need the switch AND a reachable container', () => {
  const off = protectionFeatureMatrix({ ...base, rspamdEnabled: false }, { rspamd: true, clamav: false }, []);
  assert.equal(row(off, 'Anti-Spam (Rspamd)').ok, false);
  assert.match(row(off, 'Anti-Spam (Rspamd)').note, /deaktiviert/);
  assert.equal(row(off, 'Antivirus (ClamAV)').ok, false);
  assert.match(row(off, 'Antivirus (ClamAV)').note, /nicht erreichbar/);
});

test('DNSBL lists the active zones; greylisting shows the configured wait time', () => {
  const rows = protectionFeatureMatrix({ ...base, greylistWaitSec: 600 }, { rspamd: true, clamav: true }, ['a.example', 'b.example']);
  assert.deepEqual(row(rows, 'DNSBL'), { label: 'DNSBL', ok: true, note: 'a.example, b.example' });
  assert.match(row(rows, 'Greylisting').note, /^10 min/);
  assert.equal(protectionFeatureMatrix(base, { rspamd: true, clamav: true }, [])
    .find((r) => r.label === 'DNSBL')!.ok, false);
});

test('a country filter without countries is reported as without effect', () => {
  const rows = protectionFeatureMatrix({ ...base, geoipMode: 'BLACKLIST' }, { rspamd: true, clamav: true }, []);
  assert.equal(row(rows, 'Länderfilter').ok, false);
});

test('9.3: rows of scanners not deployed in this installation are left out', () => {
  const rows = protectionFeatureMatrix(base, { rspamd: false, clamav: false }, [], { rspamd: true, clamav: true });
  assert.equal(rows.find((r) => r.label === 'Anti-Spam (Rspamd)'), undefined);
  assert.equal(rows.find((r) => r.label === 'Antivirus (ClamAV)'), undefined);
  assert.ok(row(rows, 'SPF-Prüfung') && row(rows, 'DNSBL') && row(rows, 'Greylisting'));
  const onlyClam = protectionFeatureMatrix(base, { rspamd: true, clamav: false }, [], { clamav: true });
  assert.equal(row(onlyClam, 'Anti-Spam (Rspamd)').ok, true);
  assert.equal(onlyClam.find((r) => r.label === 'Antivirus (ClamAV)'), undefined);
});
