/**
 * Regression (v8.1 review): behind a reverse proxy that speaks plain HTTP to
 * port 3000 with TRUST_PROXY unset (Synology DSM portal, Traefik), activating an
 * HTTPS certificate caused an endless 308 loop; with "8443:443" the redirect
 * pointed at the internal port. Now: no redirect for forwarded requests without
 * TRUST_PROXY (one warning), URL port = HTTPS_PUBLIC_PORT (default 443).
 * Run: node --import tsx --test --test-force-exit src/lib/https-redirect.test.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();
const express = (await import('express')).default;
const { createHttpsRedirect, httpsPublicPort, trustProxyConfigured } = await import('./https-redirect.js');
type Opts = Parameters<typeof createHttpsRedirect>[0];

const servers: http.Server[] = [];
after(() => { for (const s of servers) s.close(); });

/** App with the redirect, seen from a remote (non-loopback) peer. */
async function remoteApp(opts: Partial<Opts>, trustProxy: string | false = false): Promise<string> {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.use((req, _res, next) => { Object.defineProperty(req, 'socket', { value: { remoteAddress: '172.18.0.1' } }); next(); });
  app.use(createHttpsRedirect({
    enabled: true,
    state: () => ({ active: true, port: 443, covers: (h) => h === 'mail.ex.com' }),
    publicHostname: async () => 'mail.ex.com',
    ...opts,
  }));
  app.get('*', (_req, res) => { res.send('plain'); });
  const s = app.listen(0, '127.0.0.1');
  servers.push(s);
  await new Promise((r) => s.once('listening', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

function get(base: string, headers: Record<string, string>): Promise<{ status: number | undefined; location: string | undefined }> {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const r = http.request({ host: u.hostname, port: u.port, path: '/inbox', headers: { host: 'mail.ex.com', ...headers } }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, location: res.headers['location'] });
    });
    r.on('error', reject); r.end();
  });
}

test('no redirect loop behind an untrusted reverse proxy (X-Forwarded-* / Forwarded, TRUST_PROXY unset)', async () => {
  let warnings = 0;
  const base = await remoteApp({ trustProxy: false, warnUntrustedProxy: () => { warnings++; } });
  assert.equal((await get(base, { 'X-Forwarded-Proto': 'https' })).status, 200);
  assert.equal((await get(base, { 'X-Forwarded-For': '203.0.113.9' })).status, 200);
  assert.equal((await get(base, { Forwarded: 'for=203.0.113.9;proto=http' })).status, 200);
  assert.equal(warnings, 1, 'warned once');
  // direct client (no forwarding headers) is still redirected
  assert.deepEqual(await get(base, {}), { status: 308, location: 'https://mail.ex.com/inbox' });
});

test('with TRUST_PROXY: X-Forwarded-Proto=https passes, plain http is redirected', async () => {
  const base = await remoteApp({ trustProxy: true }, 'uniquelocal');
  assert.equal((await get(base, { 'X-Forwarded-Proto': 'https' })).status, 200);
  assert.equal((await get(base, { 'X-Forwarded-Proto': 'http' })).status, 308);
});

test('redirect URL uses HTTPS_PUBLIC_PORT, not the internal listener port', async () => {
  const internal = await remoteApp({ trustProxy: false, publicPort: 443, state: () => ({ active: true, port: 8443, covers: () => true }) });
  assert.equal((await get(internal, {})).location, 'https://mail.ex.com/inbox', 'internal HTTPS_PORT is not leaked');
  const mapped = await remoteApp({ trustProxy: false, publicPort: 8443 });
  assert.equal((await get(mapped, {})).location, 'https://mail.ex.com:8443/inbox');

  assert.equal(httpsPublicPort({}), 443);
  assert.equal(httpsPublicPort({ HTTPS_PUBLIC_PORT: '8443' }), 8443);
  assert.equal(httpsPublicPort({ HTTPS_PUBLIC_PORT: '99999' }), 443);
  assert.equal(trustProxyConfigured({}), false);
  assert.equal(trustProxyConfigured({ TRUST_PROXY: 'false' }), false);
  assert.equal(trustProxyConfigured({ TRUST_PROXY: '1' }), true);
});

test('Autodiscover HTTP redirect method: plain-HTTP autodiscover.xml gets 302 (older Outlook does not follow 308)', async () => {
  const { redirectStatusFor } = await import('./https-redirect.js');
  assert.equal(redirectStatusFor('/autodiscover/autodiscover.xml'), 302);
  assert.equal(redirectStatusFor('/Autodiscover/Autodiscover.xml'), 302);
  assert.equal(redirectStatusFor('/AutoDiscover/AutoDiscover.XML'), 302);
  assert.equal(redirectStatusFor('/inbox'), 308);
  assert.equal(redirectStatusFor('/autodiscover/autodiscover.json'), 308);

  const base = await remoteApp({ trustProxy: false, state: () => ({ active: true, port: 443, covers: (h) => h === 'autodiscover.ex.com' }) });
  const res = await new Promise<{ status: number | undefined; location: string | undefined }>((resolve, reject) => {
    const u = new URL(base);
    const r = http.request({ host: u.hostname, port: u.port, path: '/autodiscover/autodiscover.xml', headers: { host: 'autodiscover.ex.com' } }, (rs) => {
      rs.resume();
      resolve({ status: rs.statusCode, location: rs.headers['location'] });
    });
    r.on('error', reject); r.end();
  });
  assert.deepEqual(res, { status: 302, location: 'https://autodiscover.ex.com/autodiscover/autodiscover.xml' });
});
