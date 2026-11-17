/**
 * 9.4: local-spoof settings from the BCP with the 9.0 environment variables as override.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSpoofSettings, normalizeSpoofList, splitSpoofList, parseSpoofAllowEntry, isSpoofDomain } from './spoof-settings.js';

test('allow-list entries: IPv4/IPv6 with optional prefix, domains; anything else is invalid', () => {
  assert.deepEqual(parseSpoofAllowEntry('203.0.113.0/24'), { kind: 'ip', addr: '203.0.113.0', prefix: 24, family: 'ipv4' });
  assert.deepEqual(parseSpoofAllowEntry('2001:DB8::1'), { kind: 'ip', addr: '2001:db8::1', prefix: 128, family: 'ipv6' });
  assert.deepEqual(parseSpoofAllowEntry('Mailer.Example.'), { kind: 'domain', domain: 'mailer.example' });
  for (const bad of ['10.0.0.0/33', '10.0.0.0/x', 'not a domain!', 'localhost', '']) assert.equal(parseSpoofAllowEntry(bad), null, bad);
  assert.equal(isSpoofDomain('lists.example.org'), true);
  assert.equal(isSpoofDomain('198.51.100.1/8 x'), false);
  assert.equal(isSpoofDomain('10.0.0.1'), false, 'IP literal');
});

test('defaults without row and environment: policy, empty lists, no overrides', () => {
  assert.deepEqual(resolveSpoofSettings(null, {}), {
    action: 'policy', allow: [], arcTrustedSealers: [], envOverrides: [], invalidAction: null,
  });
});

test('BCP columns apply when the environment variables are unset or empty', () => {
  const r = resolveSpoofSettings(
    { localSpoofAction: 'junk', localSpoofAllow: ['203.0.113.0/24', 'Mailer.Example.'], arcTrustedSealers: ['lists.example.org', 7] },
    { LOCAL_SPOOF_ACTION: '', LOCAL_SPOOF_ALLOW: '  ' },
  );
  assert.equal(r.action, 'junk');
  assert.deepEqual(r.allow, ['203.0.113.0/24', 'mailer.example']);
  assert.deepEqual(r.arcTrustedSealers, ['lists.example.org']);
  assert.deepEqual(r.envOverrides, []);
});

test('a set environment variable overrides its column (per field)', () => {
  const r = resolveSpoofSettings(
    { localSpoofAction: 'junk', localSpoofAllow: ['198.51.100.1'], arcTrustedSealers: ['a.example'] },
    { LOCAL_SPOOF_ACTION: 'Reject', ARC_TRUSTED_SEALERS: 'google.com, b.example' },
  );
  assert.equal(r.action, 'reject');
  assert.deepEqual(r.allow, ['198.51.100.1'], 'not overridden');
  assert.deepEqual(r.arcTrustedSealers, ['google.com', 'b.example']);
  assert.deepEqual(r.envOverrides, ['localSpoofAction', 'arcTrustedSealers']);
});

test('an unknown action falls back to policy and is reported', () => {
  assert.deepEqual(
    [resolveSpoofSettings(null, { LOCAL_SPOOF_ACTION: 'bogus' }).action, resolveSpoofSettings(null, { LOCAL_SPOOF_ACTION: 'bogus' }).invalidAction],
    ['policy', 'bogus'],
  );
  assert.equal(resolveSpoofSettings({ localSpoofAction: 'nope' }, {}).invalidAction, 'nope');
});

test('list helpers split on commas/whitespace and drop non-strings', () => {
  assert.deepEqual(splitSpoofList('a.example,  B.example.\n10.0.0.0/8'), ['a.example', 'b.example', '10.0.0.0/8']);
  assert.deepEqual(normalizeSpoofList('a.example'), []);
  assert.deepEqual(normalizeSpoofList(['x.example', null, 'y.example']), ['x.example', 'y.example']);
});
