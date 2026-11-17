import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listenerPayload, parseEntryList, formatEntryList, deviceRelayPayload, LEGACY_TLS_LABEL, LEGACY_TLS_WARNING,
} from './legacyClients.ts';

test('listener payload carries the legacy-TLS flag and a numeric port', () => {
  assert.deepEqual(
    listenerPayload({ address: ' 0.0.0.0 ', port: '993', ssl: true, active: true, allowLegacyTls: true }),
    { address: '0.0.0.0', port: 993, ssl: true, active: true, allowLegacyTls: true },
  );
});

test('label and warning name the versions and what stays blocked', () => {
  assert.match(LEGACY_TLS_LABEL, /TLS 1\.0\/1\.1/);
  assert.match(LEGACY_TLS_WARNING, /RC4, 3DES, NULL, EXPORT/);
});

test('entry lists: one per line, commas/spaces also split, duplicates dropped', () => {
  assert.deepEqual(parseEntryList('192.168.10.0/24\n10.0.0.5, 10.0.0.5\n\n  fd00::/8 '), ['192.168.10.0/24', '10.0.0.5', 'fd00::/8']);
  assert.equal(formatEntryList(['a', 'b']), 'a\nb');
  assert.deepEqual(parseEntryList(''), []);
});

test('device relay payload: validated port/rate, enabling needs both lists', () => {
  const form = { enabled: true, networks: '192.168.10.0/24', senderDomains: 'Example.com', port: '25', maxMessagesPerMinute: '30' };
  assert.deepEqual(deviceRelayPayload(form), {
    ok: true,
    value: { enabled: true, allowedNetworks: ['192.168.10.0/24'], senderDomains: ['example.com'], port: 25, maxMessagesPerMinute: 30 },
  });
  assert.equal(deviceRelayPayload({ ...form, port: '0' }).ok, false);
  assert.equal(deviceRelayPayload({ ...form, maxMessagesPerMinute: '5000' }).ok, false);
  assert.equal(deviceRelayPayload({ ...form, networks: '' }).ok, false);
  assert.equal(deviceRelayPayload({ ...form, enabled: false, networks: '', senderDomains: '' }).ok, true);
});

test('device relay section renders the server warnings (container NAT) prominently', async () => {
  const { readFileSync } = await import('node:fs');
  const section = readFileSync(new URL('../components/DeviceRelaySection.tsx', import.meta.url), 'utf8');
  assert.match(section, /warnings\?: string\[\]/, 'additive, optional field (older servers send none)');
  assert.match(section, /\(data\.warnings \?\? \[\]\)\.map/);
  assert.match(section, /role="alert"[^>]*bg-warning-bg|bg-warning-bg[^>]*role="alert"/);
  assert.match(section, /Container-NAT/);
});
