/**
 * 9.1.x: BCP Health & Status — aggregation of the reachability checks.
 * Run: node --import tsx --test src/lib/service-health.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { collectHealth, hostPort, probeHost, tcpProbe, type HealthDeps } from './service-health.js';

const deps = (over: Partial<HealthDeps> = {}): HealthDeps => ({
  listenerPorts: async () => ({ SMTP_RECEIVE: [{ port: 25, address: '0.0.0.0' }, { port: 587, address: '0.0.0.0' }], IMAP: [{ port: 993, address: '10.0.0.5' }], POP3: [] }),
  probe: async (_h, port) => port !== 587,
  db: async () => undefined,
  redis: async () => { throw new Error('ECONNREFUSED'); },
  storage: () => ({ driver: 'filesystem', status: 'ok', blocking: false }),
  env: {},
  ...over,
});

test('protocol services: every active listener port is probed, a dead one marks the service down', async () => {
  const r = await collectHealth(deps());
  const smtp = r.services.find((s) => s.name === 'smtp-server')!;
  assert.equal(smtp.ports, '25/587');
  assert.equal(smtp.status, 'down');
  assert.match(smtp.detail ?? '', /587/);
  assert.equal(r.services.find((s) => s.name === 'pop3-server')!.status, 'unknown', 'no active listener');
  assert.equal(r.services.find((s) => s.name === 'imap-server')!.status, 'up');
});

test('a listener bound to a concrete IP is probed on that IP', async () => {
  const seen: string[] = [];
  await collectHealth(deps({ probe: async (h, p) => { seen.push(`${h}:${p}`); return true; } }));
  assert.ok(seen.includes('10.0.0.5:993'));
  assert.ok(seen.includes('127.0.0.1:25'));
  assert.equal(probeHost('::', 'x'), 'x');
});

test('internal services use their *_URL env; dependencies report db / redis / storage', async () => {
  const r = await collectHealth(deps({ env: { JMAP_SERVICE_URL: 'http://jmap.internal:4006' } }));
  assert.equal(r.services.find((s) => s.name === 'jmap-server')!.ports, '4006');
  const dep = Object.fromEntries(r.dependencies.map((d) => [d.name, d.status]));
  assert.deepEqual(dep, { PostgreSQL: 'up', Redis: 'down', 'Object storage': 'up' });
  const blocked = await collectHealth(deps({ storage: () => ({ driver: 's3', status: 'missing objects', blocking: true }) }));
  assert.equal(blocked.dependencies.find((d) => d.name === 'Object storage')!.status, 'down');
});

test('listener lookup failure → unknown, never a fake "up"', async () => {
  const r = await collectHealth(deps({ listenerPorts: async () => { throw new Error('db down'); } }));
  assert.equal(r.services.find((s) => s.name === 'smtp-server')!.status, 'unknown');
});

test('hostPort + tcpProbe', async () => {
  assert.deepEqual(hostPort('https://x.example.com'), { host: 'x.example.com', port: 443 });
  assert.deepEqual(hostPort('http://[::1]:3003'), { host: '::1', port: 3003 });
  assert.equal(hostPort('not a url'), null);
  const srv = createServer().listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const port = (srv.address() as { port: number }).port;
  assert.equal(await tcpProbe('127.0.0.1', port), true);
  srv.close();
  await new Promise((r) => srv.once('close', r));
  assert.equal(await tcpProbe('127.0.0.1', port, 500), false);
});
