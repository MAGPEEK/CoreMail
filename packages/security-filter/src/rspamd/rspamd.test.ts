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

const { resolveRspamdEndpoints, parseRspamdUrl, scanMessage, learnSpam, learnHam, rspamdControllerHeaders } = await import('./index.js');

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

test('v8.1: learn calls send the controller Password header from RSPAMD_CONTROLLER_PASSWORD', async () => {
  assert.deepEqual(rspamdControllerHeaders({}), {});
  assert.deepEqual(rspamdControllerHeaders({ RSPAMD_CONTROLLER_PASSWORD: 's3cret' }), { Password: 's3cret' });
  assert.deepEqual(rspamdControllerHeaders({ RSPAMD_CONTROLLER_PASSWORD: 'x\r\nX-Evil: 1' }), {}, 'no header injection');

  const seen: Array<string | null> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get('password'));
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  const prev = process.env['RSPAMD_CONTROLLER_PASSWORD'];
  try {
    process.env['RSPAMD_CONTROLLER_PASSWORD'] = 'ctrl-pw';
    await learnSpam(Buffer.from('a'));
    await learnHam(Buffer.from('b'));
    delete process.env['RSPAMD_CONTROLLER_PASSWORD'];
    await learnSpam(Buffer.from('c'));
  } finally {
    globalThis.fetch = realFetch;
    if (prev === undefined) delete process.env['RSPAMD_CONTROLLER_PASSWORD'];
    else process.env['RSPAMD_CONTROLLER_PASSWORD'] = prev;
  }
  assert.deepEqual(seen, ['ctrl-pw', 'ctrl-pw', null]);
});

test('scanMessage passes the SMTP session (IP, Helo, From, Rcpt, User) to rspamd', async () => {
  let sent: Headers | undefined;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    sent = new Headers(init?.headers);
    return new Response(JSON.stringify({ score: 1, action: 'no action' }), { status: 200 });
  }) as typeof fetch;
  try {
    await scanMessage(Buffer.from('Subject: x\r\n\r\nb'), {
      ip: '203.0.113.9', helo: 'mx.sender.example', from: 'a@sender.example',
      rcpts: ['u1@corp.test', 'u2@corp.test'], hostname: 'mx.corp.test',
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(sent?.get('IP'), '203.0.113.9');
  assert.equal(sent?.get('Helo'), 'mx.sender.example');
  assert.equal(sent?.get('From'), 'a@sender.example');
  assert.equal(sent?.get('Rcpt'), 'u1@corp.test, u2@corp.test');
  assert.equal(sent?.get('MTA-Name'), 'mx.corp.test');
  assert.equal(sent?.get('User'), null);
});

test('rspamd headers: null sender is <>, injection attempts are dropped', async () => {
  const { buildRspamdHeaders } = await import('./index.js');
  const h = buildRspamdHeaders({ from: '', helo: 'evil\r\nX-Inject: 1', user: 'alice@corp.test' });
  assert.equal(h.get('From'), '<>');
  assert.equal(h.get('Helo'), null);
  assert.equal(h.get('User'), 'alice@corp.test');
});
