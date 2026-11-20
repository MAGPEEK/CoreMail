/**
 * Regression (v8.1 review): the auth-service proxy dropped X-CoreMail-Client /
 * X-CoreMail-App, so /auth/mfa/verify through the gateway returned the refresh
 * token in the JSON body instead of the HttpOnly cookie. Exactly these two
 * headers pass, with validated values; every other X-CoreMail-* is dropped.
 * Run: node --import tsx --test --test-force-exit src/lib/proxy-client-headers.test.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();
const express = (await import('express')).default;
const { createProxyMiddleware } = await import('http-proxy-middleware');
const { applyUpstreamHeaders, allowedClientHeader } = await import('./proxy-headers.js');

const servers: http.Server[] = [];
after(() => { for (const s of servers) s.close(); });
async function listen(handler: http.RequestListener): Promise<string> {
  const s = http.createServer(handler);
  s.listen(0, '127.0.0.1');
  servers.push(s);
  await new Promise((r) => s.once('listening', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

// upstream = stand-in for the auth-service: echoes the headers it received
const upstream = await listen((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ path: req.url, headers: req.headers }));
});

// gateway: same proxy configuration as the auth-service proxy in server.ts
const app = express();
const noTrust = () => false;
app.use('/auth/mfa', createProxyMiddleware({
  target: upstream,
  changeOrigin: true,
  on: {
    proxyReq: (proxyReq, req) => {
      proxyReq.path = (req as import('express').Request).originalUrl;
      applyUpstreamHeaders(proxyReq, req, noTrust);
    },
  },
}) as import('express').RequestHandler);
const gateway = await listen(app as unknown as http.RequestListener);

async function through(headers: Record<string, string>): Promise<Record<string, string | undefined>> {
  const r = await fetch(`${gateway}/auth/mfa/verify`, { method: 'POST', headers });
  const body = await r.json() as { path: string; headers: Record<string, string | undefined> };
  assert.equal(body.path, '/auth/mfa/verify');
  return body.headers;
}

test('gateway proxy forwards X-CoreMail-Client: web and X-CoreMail-App: bcp|mwa to the auth-service', async () => {
  const h = await through({ 'X-CoreMail-Client': 'web', 'X-CoreMail-App': 'BCP' });
  assert.equal(h['x-coremail-client'], 'web');
  assert.equal(h['x-coremail-app'], 'bcp');
  assert.equal((await through({ 'X-CoreMail-Client': 'web', 'X-CoreMail-App': 'mwa' }))['x-coremail-app'], 'mwa');
});

test('gateway proxy drops other X-CoreMail-* headers and unknown values', async () => {
  const h = await through({
    'X-CoreMail-Client': 'cli', 'X-CoreMail-App': 'admin', 'X-CoreMail-User': 'admin@x', 'X-CoreMail-Signature': 'x',
  });
  for (const k of ['x-coremail-client', 'x-coremail-app', 'x-coremail-user', 'x-coremail-signature']) assert.equal(h[k], undefined, k);
});

test('allowedClientHeader validates name and value', () => {
  assert.equal(allowedClientHeader('X-CoreMail-Client', ' Web '), 'web');
  assert.equal(allowedClientHeader('x-coremail-client', ['web', 'cli']), 'web');
  assert.equal(allowedClientHeader('x-coremail-client', 'web\r\nX-Evil: 1'), undefined);
  assert.equal(allowedClientHeader('x-coremail-user', 'web'), undefined);
  assert.equal(allowedClientHeader('x-coremail-app', undefined), undefined);
});

test('X-CoreMail-Proto-Verified: set by the gateway only when the scheme is known, never taken from the client', async () => {
  // direct plain-HTTP client: scheme known
  const direct = await through({});
  assert.equal(direct['x-forwarded-proto'], 'http');
  assert.equal(direct['x-coremail-proto-verified'], '1');
  // reverse proxy without TRUST_PROXY: "http" is only a guess (Autodiscover must not redirect → loop)
  const untrusted = await through({ 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '198.51.100.7' });
  assert.equal(untrusted['x-forwarded-proto'], 'http');
  assert.equal(untrusted['x-coremail-proto-verified'], undefined);
  // a client cannot claim it
  const forged = await through({ 'X-Forwarded-For': '198.51.100.7', 'X-CoreMail-Proto-Verified': '1' });
  assert.equal(forged['x-coremail-proto-verified'], undefined);
});

test('10.5 review: X-CoreMail-Ip-Verified — socket peer or explicit TRUST_PROXY list only, never a hop count, never from the client', async () => {
  const gatewayWith = async (setting: boolean | number | string, kind: import('./client-ip-trust.js').TrustProxyKind) => {
    const gw = express();
    gw.set('trust proxy', setting); // like server.ts: req.ip and the proxy share one trust function
    const trust = gw.get('trust proxy fn') as (a: string, i: number) => boolean;
    gw.use('/auth/mfa', createProxyMiddleware({
      target: upstream, changeOrigin: true,
      on: { proxyReq: (proxyReq, req) => { proxyReq.path = (req as import('express').Request).originalUrl; applyUpstreamHeaders(proxyReq, req, trust, kind); } },
    }) as import('express').RequestHandler);
    const base = await listen(gw as unknown as http.RequestListener);
    return async (headers: Record<string, string>) => {
      const r = await fetch(`${base}/auth/mfa/verify`, { method: 'POST', headers });
      return (await r.json() as { headers: Record<string, string | undefined> }).headers;
    };
  };
  // TRUST_PROXY unset: the socket peer is the client → verified; a client-sent mark changes nothing
  const none = await gatewayWith(false, 'none');
  const direct = await none({ 'X-Forwarded-For': '198.51.100.7', 'X-CoreMail-Ip-Verified': '1' });
  assert.equal(direct['x-forwarded-for'], '127.0.0.1');
  assert.equal(direct['x-coremail-ip-verified'], '1');
  // TRUST_PROXY=1 (hop count): the forwarded address is used but NOT verified
  const hops = await gatewayWith(1, 'hops');
  const hopped = await hops({ 'X-Forwarded-For': '198.51.100.7', 'X-CoreMail-Ip-Verified': '1' });
  assert.equal(hopped['x-forwarded-for'], '198.51.100.7');
  assert.equal(hopped['x-coremail-ip-verified'], undefined);
  // an explicit allow-list (TRUST_PROXY=loopback): verified
  const list = await gatewayWith('loopback', 'list');
  const listed = await list({ 'X-Forwarded-For': '198.51.100.7' });
  assert.equal(listed['x-forwarded-for'], '198.51.100.7');
  assert.equal(listed['x-coremail-ip-verified'], '1');
});

test('10.5 review: TRUST_PROXY kinds, the verdict, startup warnings and the request mark', async () => {
  const t = await import('./client-ip-trust.js');
  assert.equal(t.trustProxyKind(undefined), 'none');
  assert.equal(t.trustProxyKind('false'), 'none');
  assert.equal(t.trustProxyKind('true'), 'all');
  assert.equal(t.trustProxyKind('2'), 'hops');
  assert.equal(t.trustProxyKind('172.18.0.5, loopback'), 'list');
  assert.equal(t.trustProxyKind('not an address!'), 'none');
  assert.equal(t.clientIpVerified('203.0.113.7', '203.0.113.7', 'hops'), true, 'socket peer');
  assert.equal(t.clientIpVerified('203.0.113.7', '::ffff:172.18.0.1', 'hops'), false);
  assert.equal(t.clientIpVerified('203.0.113.7', '172.18.0.1', 'all'), false);
  assert.equal(t.clientIpVerified('203.0.113.7', '172.18.0.1', 'list'), true);
  // warnings: hop count / true always; a list only when it covers the Docker bridge gateway
  const gw = t.dockerGatewayCandidates({ eth0: [{ address: '172.20.0.3', netmask: '255.255.0.0', family: 'IPv4', mac: '', internal: false, cidr: '172.20.0.3/16' }] });
  assert.deepEqual(gw.sort(), ['172.17.0.1', '172.20.0.1']);
  assert.equal(t.trustProxyWarnings('true', () => true, gw).length, 1);
  assert.equal(t.trustProxyWarnings('1', () => true, gw).length, 1);
  assert.equal(t.trustProxyWarnings('', () => false, gw).length, 0);
  assert.equal(t.trustProxyWarnings('172.20.0.5', (a) => a === '172.20.0.5', gw).length, 0, 'the proxy container only');
  const wide = t.trustProxyWarnings('172.16.0.0/12', (a) => a.startsWith('172.'), gw);
  assert.equal(wide.length, 1);
  assert.match(wide[0]!, /172\.17\.0\.1|172\.20\.0\.1/);
  // the request mark: a client value is always removed first
  const mark = t.ipVerifiedMark('hops');
  const run = (ip: string, peer: string, headers: Record<string, string>) => {
    const req = { ip, socket: { remoteAddress: peer }, headers: { ...headers } } as unknown as import('express').Request;
    mark(req, {} as never, () => undefined);
    return req.headers['x-coremail-ip-verified'];
  };
  assert.equal(run('203.0.113.7', '172.18.0.1', { 'x-coremail-ip-verified': '1' }), undefined);
  assert.equal(run('203.0.113.7', '203.0.113.7', {}), '1');
});
