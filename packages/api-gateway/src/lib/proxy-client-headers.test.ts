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
