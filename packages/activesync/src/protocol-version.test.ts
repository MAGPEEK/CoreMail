/**
 * Protocol version negotiation: the server announces 12.1, 14.0 and 14.1; a request is served
 * with the version it names — a version the server does not announce is served as 14.1, as
 * before 9.4, and reported (once per device) — without one with the device's remembered
 * version, else the highest. Version-dependent protocol elements are looked up per feature,
 * never by comparing numbers in the commands.
 * Run: node --import tsx --test src/protocol-version.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EAS_VERSIONS, HIGHEST_EAS_VERSION, atLeast, isEasVersion, negotiateVersion, supports } from './protocol-version.js';
import { oncePerKey, versionForDevice, type DeviceVersionDeps } from './device-version.js';

test('announced versions, lowest first; 14.1 is the highest', () => {
  assert.deepEqual([...EAS_VERSIONS], ['12.1', '14.0', '14.1']);
  assert.equal(HIGHEST_EAS_VERSION, '14.1');
  assert.ok(isEasVersion('12.1') && !isEasVersion('12.0') && !isEasVersion('2.5') && !isEasVersion('16.1') && !isEasVersion('14'));
});

test('negotiation: requested version, else the remembered one, else the highest', () => {
  assert.deepEqual(negotiateVersion('12.1', '14.1'), { version: '12.1', unannounced: '' });
  assert.deepEqual(negotiateVersion(' 14.0 ', null), { version: '14.0', unannounced: '' });
  assert.deepEqual(negotiateVersion(undefined, '12.1'), { version: '12.1', unannounced: '' });
  assert.deepEqual(negotiateVersion('', '14.0'), { version: '14.0', unannounced: '' });
  assert.deepEqual(negotiateVersion(undefined, null), { version: '14.1', unannounced: '' });
  assert.deepEqual(negotiateVersion(undefined, '2.5'), { version: '14.1', unannounced: '' }, 'a stale remembered value is not trusted');
});

test('negotiation: an unannounced version (2.5, 12.0, 16.x, garbage) is served as 14.1 — never refused, remembered one ignored', () => {
  for (const v of ['2.5', '12.0', '16.0', '16.1', '14', 'abc']) {
    assert.deepEqual(negotiateVersion(v, '12.1'), { version: '14.1', unannounced: v }, v);
  }
  assert.deepEqual(negotiateVersion(' 16.1 ', null), { version: '14.1', unannounced: '16.1' });
});

test('oncePerKey: true only the first time; bounded memory starts over when full', () => {
  const once = oncePerKey(2);
  assert.deepEqual(['a', 'a', 'b', 'a', 'b'].map((k) => once.first(k)), [true, false, true, false, false]);
  assert.equal(once.first('c'), true, 'third key: memory full → starts over');
  assert.equal(once.first('a'), true, 'forgotten after the restart');
  assert.equal(once.first('c'), false);
});

function versionDeps() {
  const saved: Array<[string, string]> = [];
  const warnings: Array<Record<string, unknown>> = [];
  const deps: DeviceVersionDeps = {
    saveVersion: async (id, version) => { saved.push([id, version]); },
    warn: (fields) => { warnings.push(fields); },
    warned: oncePerKey(100),
  };
  return { deps, saved, warnings };
}

test('versionForDevice: an unannounced version is served as 14.1 and warned about once per device', async () => {
  const { deps, warnings } = versionDeps();
  const dev = { id: 'row1', protocolVersion: '12.1' };
  const ask = (deviceId: string, requested: string, device: { id: string; protocolVersion: string | null } | null = dev) =>
    versionForDevice({ userId: 'u1', deviceId, requested }, device, deps);
  assert.equal(await ask('D1', '16.0'), '14.1');
  assert.equal(await ask('D1', '2.5'), '14.1');
  assert.equal(await ask('D1', '16.1'), '14.1');
  assert.deepEqual(warnings, [{ userId: 'u1', deviceId: 'D1', requested: '16.0', servedAs: '14.1' }], 'one warning for D1');
  assert.equal(await ask('D2', '12.0', null), '14.1');
  assert.equal(warnings.length, 2, 'another device is reported on its own');
  assert.equal(await ask('D3', '14.0', null), '14.0');
  assert.equal(warnings.length, 2, 'announced versions are not reported');
  assert.equal(await ask('D4', 'x'.repeat(5000), null), '14.1');
  assert.equal(warnings[2]?.['requested'], 'x'.repeat(32), 'client input is logged truncated');
});

test('versionForDevice: the served version is stored on the device row only when it changes (never for an unknown device)', async () => {
  const { deps, saved } = versionDeps();
  const dev = { id: 'row1', protocolVersion: '12.1' as string | null };
  const ask = async (requested: string) => {
    const v = await versionForDevice({ userId: 'u1', deviceId: 'D1', requested }, dev, deps);
    dev.protocolVersion = v;
    return v;
  };
  assert.equal(await ask('12.1'), '12.1');
  assert.equal(await ask(''), '12.1', 'no version: the remembered one');
  assert.deepEqual(saved, []);
  assert.equal(await ask('14.1'), '14.1');
  assert.equal(await ask('16.0'), '14.1');
  assert.deepEqual(saved, [['row1', '14.1']]);
  assert.equal(await versionForDevice({ userId: 'u1', deviceId: 'new', requested: '12.1' }, null, deps), '12.1');
  assert.deepEqual(saved, [['row1', '14.1']], 'Provision registers a new device with its version');
});

test('atLeast orders the versions', () => {
  assert.ok(atLeast('14.1', '12.1') && atLeast('14.0', '14.0') && !atLeast('12.1', '14.0') && !atLeast('14.0', '14.1'));
});

test('features: 12.1 has neither global status codes nor ComposeMail/Email2/Preview/Availability; 14.1-only elements', () => {
  const v14 = ['globalStatus', 'composeMailWbxml', 'email2', 'bodyPreview', 'recipientAvailability', 'estimateOptions'] as const;
  for (const f of v14) {
    assert.equal(supports('12.1', f), false, f);
    assert.equal(supports('14.0', f), true, f);
    assert.equal(supports('14.1', f), true, f);
  }
  for (const f of ['provisionDeviceInformation', 'userInformationAccounts', 'rightsManagement'] as const) {
    assert.equal(supports('12.1', f), false, f);
    assert.equal(supports('14.0', f), false, f);
    assert.equal(supports('14.1', f), true, f);
  }
});
