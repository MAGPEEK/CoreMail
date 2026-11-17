/**
 * Protocol version negotiation: the server announces 12.1, 14.0 and 14.1; a request is served
 * with the version it names (anything not announced is refused), without one with the
 * device's remembered version, else the highest. Version-dependent protocol elements are
 * looked up per feature, never by comparing numbers in the commands.
 * Run: node --import tsx --test src/protocol-version.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EAS_VERSIONS, HIGHEST_EAS_VERSION, atLeast, isEasVersion, negotiateVersion, supports } from './protocol-version.js';

test('announced versions, lowest first; 14.1 is the highest', () => {
  assert.deepEqual([...EAS_VERSIONS], ['12.1', '14.0', '14.1']);
  assert.equal(HIGHEST_EAS_VERSION, '14.1');
  assert.ok(isEasVersion('12.1') && !isEasVersion('12.0') && !isEasVersion('2.5') && !isEasVersion('16.1') && !isEasVersion('14'));
});

test('negotiation: requested version (announced only), else the remembered one, else the highest', () => {
  assert.deepEqual(negotiateVersion('12.1', '14.1'), { ok: true, version: '12.1' });
  assert.deepEqual(negotiateVersion(' 14.0 ', null), { ok: true, version: '14.0' });
  for (const v of ['2.5', '12.0', '16.0', '16.1', '14', 'abc']) {
    assert.deepEqual(negotiateVersion(v, '14.1'), { ok: false, requested: v }, v);
  }
  assert.deepEqual(negotiateVersion(undefined, '12.1'), { ok: true, version: '12.1' });
  assert.deepEqual(negotiateVersion('', '14.0'), { ok: true, version: '14.0' });
  assert.deepEqual(negotiateVersion(undefined, null), { ok: true, version: '14.1' });
  assert.deepEqual(negotiateVersion(undefined, '2.5'), { ok: true, version: '14.1' }, 'a stale remembered value is not trusted');
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
