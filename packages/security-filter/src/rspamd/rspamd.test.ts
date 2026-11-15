/**
 * v7.1.0: the security-filter reads RSPAMD_URL (what compose, Helm and the
 * api-gateway set) with RSPAMD_HOST/RSPAMD_PORT as the legacy fallback.
 * Before, RSPAMD_URL was ignored here and scanning silently used the
 * hard-coded host `rspamd`.
 * Run: node --import tsx --test src/rspamd/rspamd.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';
process.env['RSPAMD_URL'] = 'http://spam-filter.internal:21334/';
process.env['RSPAMD_HOST'] = 'must-not-be-used';

const { resolveRspamdEndpoints, parseRspamdUrl, scanMessage, learnSpam, learnHam } = await import('./index.js');

test('RSPAMD_URL is preferred and used for scanning and learning (controller)', () => {
  const e = resolveRspamdEndpoints({ RSPAMD_URL: 'http://rspamd:11334', RSPAMD_HOST: 'x', RSPAMD_PORT: '1' });
  assert.deepEqual(e, { scan: 'http://rspamd:11334', controller: 'http://rspamd:11334', source: 'RSPAMD_URL' });
});

test('RSPAMD_URL: https, IPv6, path prefix and trailing slash are normalised', () => {
  assert.equal(resolveRspamdEndpoints({ RSPAMD_URL: 'https://filter.example.test/rspamd/' }).scan, 'https://filter.example.test/rspamd');
  assert.equal(resolveRspamdEndpoints({ RSPAMD_URL: 'http://[fd00::5]:11334' }).controller, 'http://[fd00::5]:11334');
  assert.equal(resolveRspamdEndpoints({ RSPAMD_URL: '  http://rspamd:11334  ' }).scan, 'http://rspamd:11334');
});

test('legacy RSPAMD_HOST/RSPAMD_PORT when RSPAMD_URL is unset or empty', () => {
  assert.deepEqual(resolveRspamdEndpoints({}), { scan: 'http://rspamd:11333', controller: 'http://rspamd:11334', source: 'RSPAMD_HOST/RSPAMD_PORT' });
  assert.deepEqual(resolveRspamdEndpoints({ RSPAMD_URL: '', RSPAMD_HOST: '10.0.0.7', RSPAMD_PORT: '12333' }),
    { scan: 'http://10.0.0.7:12333', controller: 'http://10.0.0.7:11334', source: 'RSPAMD_HOST/RSPAMD_PORT' });
  assert.equal(resolveRspamdEndpoints({ RSPAMD_HOST: '::1' }).scan, 'http://[::1]:11333');
});

test('an invalid RSPAMD_URL is reported and falls back to HOST/PORT', () => {
  for (const bad of ['rspamd:11334', 'ftp://rspamd', 'http://user:pw@rspamd:11334', 'http://rspamd:11334/?x=1']) {
    const warnings: string[] = [];
    const e = resolveRspamdEndpoints({ RSPAMD_URL: bad, RSPAMD_HOST: 'legacy' }, (m) => warnings.push(m));
    assert.equal(e.source, 'RSPAMD_HOST/RSPAMD_PORT', bad);
    assert.equal(e.scan, 'http://legacy:11333');
    assert.equal(warnings.length, 1, bad);
    assert.ok(!warnings[0]!.includes('pw'), 'credentials are not logged');
  }
  assert.deepEqual(parseRspamdUrl('http://rspamd:11334'), { url: 'http://rspamd:11334' });
});

test('scanMessage / learnSpam / learnHam call the RSPAMD_URL endpoints', async () => {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ score: 7.5, action: 'add header', symbols: {} }), { status: 200 });
  }) as typeof fetch;
  try {
    const r = await scanMessage(Buffer.from('Subject: x\r\n\r\nbody'));
    assert.equal(r.score, 7.5);
    assert.equal(r.isSpam, true);
    await learnSpam(Buffer.from('a'));
    await learnHam(Buffer.from('b'));
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(calls, [
    'http://spam-filter.internal:21334/checkv2',
    'http://spam-filter.internal:21334/learnspam',
    'http://spam-filter.internal:21334/learnham',
  ]);
});
