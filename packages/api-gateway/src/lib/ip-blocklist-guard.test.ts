/**
 * 10.5 block list for every HTTP surface of the gateway (lib/ip-blocklist-guard.ts)
 * + the per-protocol counts of the attack summary.
 * Run: node --import tsx --test --test-force-exit src/lib/ip-blocklist-guard.test.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { installFakePrisma, setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();
installFakePrisma();

const express = (await import('express')).default;
const storage = await import('@coremail/storage');
const { createIpBlocklistGuard, httpProtocolOf, upgradeBlocked } = await import('./ip-blocklist-guard.js');
const { mergeProtocolCounts } = await import('../routes/admin/security-attacks.js');

after(() => storage.setIpAccessRulesForTests(null));

test('httpProtocolOf maps the gateway paths to protocols', () => {
  assert.equal(httpProtocolOf('/Microsoft-Server-ActiveSync'), 'activesync');
  assert.equal(httpProtocolOf('/dav/calendars/x'), 'caldav');
  assert.equal(httpProtocolOf('/.well-known/carddav'), 'caldav');
  assert.equal(httpProtocolOf('/jmap/session'), 'jmap');
  assert.equal(httpProtocolOf('/.well-known/jmap'), 'jmap');
  assert.equal(httpProtocolOf('/mapi/emsmdb'), 'mapi');
  assert.equal(httpProtocolOf('/Autodiscover/Autodiscover.xml'), 'autodiscover');
  assert.equal(httpProtocolOf('/mcp'), 'mcp');
  assert.equal(httpProtocolOf('/auth/login'), 'web');
  assert.equal(httpProtocolOf('/api/v1/mail/folders'), 'web');
  assert.equal(httpProtocolOf('/bcp/'), 'http');
});

test('a blocked client gets 403 IP_BLOCKED on every path; others pass; the refusal is reported', async () => {
  const refused: Array<{ ip: unknown; protocol: string }> = [];
  const blocked = new Set(['198.51.100.7', '2001:db8::bad']);
  const app = express();
  app.set('trust proxy', true);
  app.use(createIpBlocklistGuard({
    isBlocked: (ip) => blocked.has(String(ip)),
    refused: (ip, protocol) => { refused.push({ ip, protocol }); },
  }));
  app.use((_req, res) => { res.json({ ok: true }); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const get = (path: string, ip: string) => fetch(`${base}${path}`, { headers: { 'x-forwarded-for': ip } });
    const r1 = await get('/Microsoft-Server-ActiveSync?Cmd=Sync', '198.51.100.7');
    assert.equal(r1.status, 403);
    assert.deepEqual(await r1.json(), { error: 'Access denied', code: 'IP_BLOCKED' });
    assert.equal((await get('/api/v1/user/me', '2001:db8::bad')).status, 403);
    assert.equal((await get('/api/v1/user/me', '198.51.100.8')).status, 200);
    assert.deepEqual(refused, [{ ip: '198.51.100.7', protocol: 'activesync' }, { ip: '2001:db8::bad', protocol: 'web' }]);
  } finally {
    server.close();
  }
});

test('the default guard uses the shared block list; loopback is never blocked', async () => {
  storage.setIpAccessRulesForTests([{ kind: 'BLOCK', cidr: '198.51.100.0/24' }]);
  const guard = createIpBlocklistGuard();
  const run = (ip: string) => new Promise<number>((resolve) => {
    const res = {
      statusCode: 200,
      setHeader: () => res,
      status(c: number) { this.statusCode = c; return this; },
      json() { resolve(this.statusCode); return this; },
    };
    guard({ ip, path: '/dav', socket: {} } as never, res as never, () => resolve(0));
  });
  assert.equal(await run('198.51.100.33'), 403);
  assert.equal(await run('127.0.0.1'), 0);
  assert.equal(await run('203.0.113.1'), 0);
  // WebSocket upgrades (JMAP /jmap/ws) use the socket peer
  assert.equal(upgradeBlocked({ url: '/jmap/ws', socket: { remoteAddress: '198.51.100.5' } } as unknown as IncomingMessage), true);
  assert.equal(upgradeBlocked({ url: '/jmap/ws', socket: { remoteAddress: '203.0.113.5' } } as unknown as IncomingMessage), false);
});

test('10.5 review: WebSocket upgrades derive the client IP with the same trust function as requests', () => {
  storage.setIpAccessRulesForTests([{ kind: 'BLOCK', cidr: '198.51.100.0/24' }]);
  const refused: unknown[] = [];
  const guard = { isBlocked: (ip: string | null | undefined) => storage.ipAccessVerdict(ip) === 'block', refused: (ip: unknown) => { refused.push(ip); } };
  const viaProxy = (xff: string) => ({
    url: '/jmap/ws', headers: { 'x-forwarded-for': xff }, socket: { remoteAddress: '172.18.0.5' },
  }) as unknown as IncomingMessage;
  const trustProxy = (addr: string) => addr === '172.18.0.5'; // TRUST_PROXY=172.18.0.5
  const trustNone = () => false;                              // TRUST_PROXY unset
  // behind the trusted reverse proxy the blocked client is found in X-Forwarded-For
  assert.equal(upgradeBlocked(viaProxy('198.51.100.9'), guard, trustProxy), true);
  assert.deepEqual(refused, ['198.51.100.9']);
  assert.equal(upgradeBlocked(viaProxy('203.0.113.9'), guard, trustProxy), false);
  // without TRUST_PROXY a forged header is ignored (the socket peer counts) — as for requests
  assert.equal(upgradeBlocked(viaProxy('198.51.100.9'), guard, trustNone), false);
  storage.setIpAccessRulesForTests([]);
});

test('per-protocol counts merge 10.5 rows with older rows (service column)', () => {
  assert.deepEqual(
    mergeProtocolCounts(
      [{ key: 'imap', count: 5 }, { key: 'smtp', count: 2 }, { key: 'web', count: 5 }],
      [{ key: 'smtp', count: 4 }],
    ),
    [{ protocol: 'smtp', count: 6 }, { protocol: 'imap', count: 5 }, { protocol: 'web', count: 5 }],
  );
});
