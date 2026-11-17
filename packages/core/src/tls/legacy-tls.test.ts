/**
 * Legacy TLS policy: default stays TLS 1.2+, the opt-in list is closed and
 * contains no RC4 / 3DES / NULL / EXPORT suites. Real TLS 1.0/1.1 handshakes
 * are covered in smtp-server (src/core/legacy-tls-handshake.test.ts).
 * Run: node --import tsx --test src/tls/legacy-tls.test.ts  (in packages/core)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import {
  tlsProtocolOptions, tlsServerOptions, LEGACY_TLS_CIPHERS, LEGACY_TLS_CIPHER_SUITES,
  LEGACY_TLS_EXCLUSIONS, FORBIDDEN_CIPHER_FRAGMENTS,
} from './legacy-tls.js';

test('default policy is unchanged: TLS 1.2 minimum, OpenSSL default ciphers', () => {
  assert.deepEqual(tlsProtocolOptions(), { minVersion: 'TLSv1.2' });
  assert.deepEqual(tlsProtocolOptions(false), { minVersion: 'TLSv1.2' });
});

test('legacy policy accepts TLS 1.0 with the explicit cipher list and server order', () => {
  const o = tlsProtocolOptions(true);
  assert.equal(o.minVersion, 'TLSv1');
  assert.equal(o.ciphers, LEGACY_TLS_CIPHERS);
  assert.equal(o.honorCipherOrder, true);
});

test('the legacy allow-list contains no weak suite', () => {
  for (const suite of LEGACY_TLS_CIPHER_SUITES) {
    for (const bad of FORBIDDEN_CIPHER_FRAGMENTS) {
      assert.ok(!suite.toUpperCase().includes(bad), `${suite} contains ${bad}`);
    }
    assert.ok(!suite.startsWith('DHE-'), `${suite}: DHE needs DH parameters, none are configured`);
  }
});

test('weak classes are excluded explicitly and @SECLEVEL=0 comes last', () => {
  for (const ex of ['!aNULL', '!eNULL', '!EXPORT', '!3DES', '!RC4', '!MD5']) {
    assert.ok(LEGACY_TLS_EXCLUSIONS.includes(ex), `missing ${ex}`);
  }
  assert.ok(LEGACY_TLS_CIPHERS.endsWith(':@SECLEVEL=0'));
  assert.equal(LEGACY_TLS_CIPHERS.split('@SECLEVEL').length, 2);
});

test('every listed suite is known to the linked OpenSSL and the string is accepted', () => {
  const known = new Set(tls.getCiphers().map((c) => c.toUpperCase()));
  for (const suite of LEGACY_TLS_CIPHER_SUITES) assert.ok(known.has(suite), `unknown suite ${suite}`);
  assert.doesNotThrow(() => tls.createSecureContext({ ciphers: LEGACY_TLS_CIPHERS, minVersion: 'TLSv1' }));
});

test('tlsServerOptions merges material and policy', () => {
  const m = { cert: Buffer.from('c'), key: Buffer.from('k') };
  assert.deepEqual(tlsServerOptions(m), { cert: m.cert, key: m.key, minVersion: 'TLSv1.2' });
  const legacy = tlsServerOptions(m, true);
  assert.equal(legacy.minVersion, 'TLSv1');
  assert.equal(legacy.cert, m.cert);
});
