/**
 * v6 crash safety + trust-proxy behaviour on a real loopback Express app:
 *  - async route rejection → 500 via error middleware, process stays alive
 *  - Prisma P2002/P2025 → 409/404 without leaking the Prisma message
 *  - TRUST_PROXY matrix for req.ip; loopback exemption ignores X-Forwarded-For;
 *    auditContext uses req.ip, never the raw header
 *  - 10.5 connection hardening (lib/http-hardening.ts): config, per-IP (/64) +
 *    global caps, slowloris / slow POST / keep-alive / TLS handshake timeouts,
 *    long-lived responses and upgrades not cut by requestTimeout
 * Run: node --import tsx --test --test-force-exit src/lib/http-hardening.test.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { installFakePrisma, setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();
installFakePrisma();

const express = (await import('express')).default;
const core = await import('@coremail/core');
const { isLoopback } = await import('../middleware/security.js');
const { auditContext } = await import('./audit.js');

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

async function listen(app: ReturnType<typeof express>): Promise<string> {
  const s = app.listen(0, '127.0.0.1');
  servers.push(s);
  await new Promise((r) => s.once('listening', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

function prismaError(code: string): Error {
  return Object.assign(new Error(`Invalid prisma.user.create() — Unique constraint failed on users_email_key (passwordHash)`), {
    name: 'PrismaClientKnownRequestError', code, clientVersion: '5.20.0',
  });
}

test('async handler rejections no longer kill the process', async () => {
  core.installAsyncErrorHandling(express);
  const app = express();
  const router = express.Router();
  router.get('/boom', async () => { throw new Error('db exploded: postgres://u:pw@db'); });
  router.get('/dup', async () => { throw prismaError('P2002'); });
  router.get('/gone', async () => { throw prismaError('P2025'); });
  router.get('/mw', async (_req, _res, next) => { await Promise.resolve(); next(); }, (_req, res) => { res.json({ ok: true }); });
  app.use('/r', router);
  app.use(core.errorMiddleware({ error: () => undefined, warn: () => undefined }));
  const base = await listen(app);

  let unhandled = 0;
  const onUnhandled = () => { unhandled++; };
  process.on('unhandledRejection', onUnhandled);
  try {
    const boom = await fetch(`${base}/r/boom`);
    assert.equal(boom.status, 500);
    const text = await boom.text();
    assert.deepEqual(JSON.parse(text), { error: 'Internal server error' });
    assert.ok(!text.includes('pw@db'));

    const dup = await fetch(`${base}/r/dup`);
    assert.equal(dup.status, 409);
    assert.ok(!(await dup.text()).includes('passwordHash'));
    assert.equal((await fetch(`${base}/r/gone`)).status, 404);
    assert.equal((await fetch(`${base}/r/mw`)).status, 200);
    // the server still answers after the crashes
    assert.equal((await fetch(`${base}/r/mw`)).status, 200);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(unhandled, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('TRUST_PROXY matrix: req.ip, loopback exemption and audit IP', async () => {
  const probe = async (trust: string | undefined, xff?: string) => {
    const app = express();
    app.set('trust proxy', core.parseTrustProxy(trust));
    app.get('/ip', (req, res) => res.json({ ip: req.ip, loopbackExempt: isLoopback(req), audit: auditContext(req).ipAddress }));
    const base = await listen(app);
    const r = await fetch(`${base}/ip`, { headers: xff ? { 'x-forwarded-for': xff } : {} });
    return await r.json() as { ip: string; loopbackExempt: boolean; audit: string };
  };

  // default (unset) → forwarded header ignored
  const def = await probe(undefined, '203.0.113.7');
  assert.match(def.ip, /127\.0\.0\.1$/);
  assert.equal(def.audit, def.ip, 'audit IP is req.ip, not the raw header');

  // trusted loopback proxy, one hop → client IP from XFF
  const hop = await probe('1', '203.0.113.7');
  assert.equal(hop.ip, '203.0.113.7');
  assert.equal(hop.audit, '203.0.113.7');
  assert.equal(hop.loopbackExempt, true, 'socket peer is loopback here (real gateway hop)');

  // CIDR list that does not contain the peer → header ignored
  const cidr = await probe('10.0.0.0/8', '203.0.113.7');
  assert.match(cidr.ip, /127\.0\.0\.1$/);

  // spoofing "127.0.0.1" via XFF never turns a remote peer into loopback:
  // isLoopback only looks at the socket address.
  const fakeReq = { socket: { remoteAddress: '198.51.100.9' }, ip: '127.0.0.1' } as unknown as Parameters<typeof isLoopback>[0];
  assert.equal(isLoopback(fakeReq), false);
});

test('TLS proxy path strips client-supplied forwarded headers', () => {
  const req = { headers: { 'x-forwarded-for': '127.0.0.1', 'x-forwarded-proto': 'https', host: 'mail.ex.com' } as Record<string, unknown> };
  core.stripForwardedHeaders(req);
  assert.deepEqual(req.headers, { host: 'mail.ex.com' });
});

// ── 10.5: connection hardening (lib/http-hardening.ts) ───────────────────────
// slowloris / slow POST / idle floods: timeouts, per-IP (/64) + global caps;
// long-lived responses (SSE, EAS Ping, MAPI NotificationWait) and WebSocket
// upgrades are not cut by requestTimeout.

const http = await import('node:http');
const https = await import('node:https');
const net = await import('node:net');
const tls = await import('node:tls');
const hh = await import('./http-hardening.js');
type HardeningConfig = import('./http-hardening.js').HttpHardeningConfig;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('http hardening config: defaults, env overrides, invalid values, timeout ordering', () => {
  const def = hh.loadHttpHardeningConfig({});
  assert.deepEqual(def.config, { ...hh.HTTP_HARDENING_DEFAULTS });
  assert.deepEqual(def.warnings, []);
  assert.ok(def.config.headersTimeoutMs > def.config.keepAliveTimeoutMs);
  assert.ok(def.config.requestTimeoutMs >= def.config.headersTimeoutMs);

  const env = hh.loadHttpHardeningConfig({
    HTTP_HEADERS_TIMEOUT_MS: '15000', HTTP_REQUEST_TIMEOUT_MS: '0', HTTP_KEEPALIVE_TIMEOUT_MS: '4000',
    HTTP_MAX_REQUESTS_PER_SOCKET: '100', HTTP_MAX_CONNS: '8000', HTTP_MAX_CONNS_PER_IP: '0',
    HTTP_CONN_EXEMPT_CIDRS: ' 10.0.0.0/8 ', HTTPS_HANDSHAKE_TIMEOUT_MS: '5000', HTTP_CONNECTIONS_CHECK_INTERVAL_MS: '1000',
  });
  assert.deepEqual(env.config, {
    headersTimeoutMs: 15000, requestTimeoutMs: 0, keepAliveTimeoutMs: 4000, maxRequestsPerSocket: 100,
    connectionsCheckingIntervalMs: 1000, maxConnections: 8000, maxConnectionsPerIp: 0, exemptCidrs: '10.0.0.0/8',
    tlsHandshakeTimeoutMs: 5000,
  });
  assert.deepEqual(env.warnings, []);

  const bad = hh.loadHttpHardeningConfig({ HTTP_MAX_CONNS: '-1', HTTP_HEADERS_TIMEOUT_MS: 'abc', HTTPS_HANDSHAKE_TIMEOUT_MS: '10' });
  assert.equal(bad.config.maxConnections, 4000);
  assert.equal(bad.config.headersTimeoutMs, 20000);
  assert.equal(bad.config.tlsHandshakeTimeoutMs, 10000);
  assert.equal(bad.warnings.length, 3);

  // headers must exceed keep-alive; request (when on) must not be below headers
  const order = hh.loadHttpHardeningConfig({ HTTP_KEEPALIVE_TIMEOUT_MS: '30000', HTTP_HEADERS_TIMEOUT_MS: '20000', HTTP_REQUEST_TIMEOUT_MS: '25000' });
  assert.equal(order.config.headersTimeoutMs, 31000);
  assert.equal(order.config.requestTimeoutMs, 31000);
  assert.equal(order.warnings.length, 2);

  const opts = hh.httpsServerOptions(def.config) as Record<string, unknown>;
  assert.equal(opts['headersTimeout'], 20000);
  assert.equal(opts['requestTimeout'], 300000);
  assert.equal(opts['handshakeTimeout'], 10000);
  assert.equal(opts['connectionsCheckingInterval'], 5000);
});

test('connectionKey: IPv4 as is, IPv4-mapped unwrapped, IPv6 grouped per /64', () => {
  assert.equal(hh.connectionKey('203.0.113.7'), '203.0.113.7');
  assert.equal(hh.connectionKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(hh.connectionKey('2001:db8:1:2::1'), '2001:db8:1:2::/64');
  assert.equal(hh.connectionKey('2001:DB8:1:2:ffff:ffff:ffff:5'), '2001:db8:1:2::/64');
  assert.equal(hh.connectionKey('2001:db8:1:2::1%eth0'), '2001:db8:1:2::/64');
  assert.equal(hh.connectionKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.notEqual(hh.connectionKey('2001:db8:1:3::1'), hh.connectionKey('2001:db8:1:2::1'));
  assert.equal(hh.connectionKey('::1'), '0:0:0:0::/64');
  assert.equal(hh.connectionKey(undefined), '');
});

test('connection guard: per-IP cap, /64 sharing, exemptions, trusted proxy, total cap, release', () => {
  const g = new hh.HttpConnectionGuard({ maxPerIp: 2, maxTotal: 5, isExempt: (ip) => ip === '198.51.100.1' });
  const a1 = g.acquire('203.0.113.7');
  const a2 = g.acquire('::ffff:203.0.113.7');
  assert.ok(a1.ok && a2.ok);
  assert.deepEqual(g.acquire('203.0.113.7'), { ok: false, reason: 'per_ip', limit: 2 });
  // a TRUST_PROXY-trusted peer is not subject to the per-IP cap
  const viaProxy = g.acquire('203.0.113.7', false);
  assert.ok(viaProxy.ok);
  assert.equal(g.count('203.0.113.7'), 3);
  if (a1.ok) { a1.release(); a1.release(); } // idempotent
  assert.equal(g.count('203.0.113.7'), 2);
  if (viaProxy.ok) viaProxy.release();
  assert.ok(g.acquire('203.0.113.7').ok);

  // IPv6: one /64 shares the budget
  const g6 = new hh.HttpConnectionGuard({ maxPerIp: 1, maxTotal: 0, isExempt: () => false });
  assert.ok(g6.acquire('2001:db8:1:2::1').ok);
  assert.equal(g6.acquire('2001:db8:1:2::99').ok, false);
  assert.ok(g6.acquire('2001:db8:1:3::1').ok);

  // exempt IP: no per-IP cap, but it counts towards the total
  const t = new hh.HttpConnectionGuard({ maxPerIp: 1, maxTotal: 3, isExempt: (ip) => ip === '198.51.100.1' });
  assert.ok(t.acquire('198.51.100.1').ok && t.acquire('198.51.100.1').ok);
  assert.ok(t.acquire('203.0.113.9').ok);
  assert.deepEqual(t.acquire('203.0.113.10'), { ok: false, reason: 'total', limit: 3 });
  assert.equal(t.acquire('198.51.100.1').ok, false, 'exempt IPs still respect the total');
  // loopback (healthcheck, CLI) bypasses both caps by default
  assert.ok(t.acquire('127.0.0.1').ok);
  assert.ok(t.acquire('::1').ok);
  assert.equal(t.count(), 5);
  // 0 disables a cap
  const off = new hh.HttpConnectionGuard({ maxPerIp: 0, maxTotal: 0, isExempt: () => false });
  for (let i = 0; i < 50; i++) assert.ok(off.acquire('203.0.113.7').ok);
});

test('createHttpConnectionGuard: HTTP_CONN_EXEMPT_CIDRS, invalid entries reported', () => {
  const { guard, invalidExempt } = hh.createHttpConnectionGuard(
    { ...hh.HTTP_HARDENING_DEFAULTS, maxConnectionsPerIp: 1, exemptCidrs: '10.0.0.0/8, nonsense, 2001:db8::/32' },
  );
  assert.deepEqual(invalidExempt, ['nonsense']);
  assert.ok(guard.acquire('10.1.2.3').ok && guard.acquire('10.1.2.3').ok);
  assert.ok(guard.acquire('2001:db8:5::1').ok && guard.acquire('2001:db8:5::2').ok);
  assert.ok(guard.acquire('203.0.113.7').ok);
  assert.equal(guard.acquire('203.0.113.7').ok, false);
});

test('refusal log is rate limited per key and reason', () => {
  let now = 0;
  const seen: Array<{ key: string; suppressed: number }> = [];
  const g = new hh.HttpConnectionGuard({
    maxPerIp: 1, maxTotal: 0, isExempt: () => false, bypassAll: () => false, now: () => now, logWindowMs: 60_000,
    onRefused: (i) => seen.push({ key: i.key, suppressed: i.suppressed }),
  });
  const destroyed: boolean[] = [];
  const fakeSocket = (ip: string) => {
    const idx = destroyed.push(false) - 1;
    const s = { remoteAddress: ip, once: () => s, on: () => s, destroy: () => { destroyed[idx] = true; } };
    return s as unknown as import('node:net').Socket;
  };
  assert.equal(g.admit(fakeSocket('203.0.113.7'), 'https', true), true);
  for (let i = 0; i < 5; i++) assert.equal(g.admit(fakeSocket('203.0.113.7'), 'https', true), false);
  assert.equal(destroyed.filter(Boolean).length, 5, 'HTTPS refusals destroy the raw socket');
  assert.deepEqual(seen, [{ key: '203.0.113.7', suppressed: 0 }]);
  now = 61_000;
  g.admit(fakeSocket('203.0.113.7'), 'https', true);
  assert.deepEqual(seen[1], { key: '203.0.113.7', suppressed: 4 });
});

/** Hardened HTTP server with short test timeouts; loopback is NOT exempt here. */
async function hardenedHttp(overrides: Partial<HardeningConfig> = {}) {
  const config = hh.normalizeTimeouts({
    ...hh.HTTP_HARDENING_DEFAULTS,
    headersTimeoutMs: 600, requestTimeoutMs: 1200, keepAliveTimeoutMs: 300,
    connectionsCheckingIntervalMs: 100, maxConnectionsPerIp: 0, maxConnections: 0,
    ...overrides,
  });
  const guard = new hh.HttpConnectionGuard({
    maxPerIp: config.maxConnectionsPerIp, maxTotal: config.maxConnections, isExempt: () => false, bypassAll: () => false,
    onRefused: () => undefined,
  });
  const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    if (req.url === '/sse') { // like /api/v1/events: heartbeats, response outlives requestTimeout
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const iv = setInterval(() => res.write(':heartbeat\n\n'), 200);
      setTimeout(() => { clearInterval(iv); res.end('data: done\n\n'); }, 2_500);
      return;
    }
    if (req.url === '/ping') { // like EAS Ping / MAPI NotificationWait: small POST, silent long wait
      let body = '';
      req.on('data', (d: Buffer) => { body += d.toString(); });
      req.on('end', () => setTimeout(() => res.end(`pong ${body}`), 2_500));
      return;
    }
    if (req.url === '/upload') {
      let n = 0;
      req.on('data', (d: Buffer) => { n += d.length; });
      req.on('end', () => res.end(`got ${n}`));
      return;
    }
    res.end('ok');
  };
  const server = http.createServer(hh.httpServerOptions(config), hh.guardedRequestHandler(guard, handler));
  hh.hardenHttpServer(server, { kind: 'http', guard, config });
  server.on('upgrade', (req, socket) => { // like /jmap/ws: raw duplex after 101
    if (guard.isRefused(req.socket)) { socket.destroy(); return; }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n');
    setTimeout(() => { if (!socket.destroyed) socket.write('late-frame'); }, 2_000);
    socket.on('data', (d: Buffer) => socket.write(`echo:${d.toString()}`));
    socket.on('error', () => undefined);
    socket.on('end', () => socket.end()); // the HTTP server socket is half-open capable
  });
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  servers.push(server);
  return { server, guard, port: (server.address() as AddressInfo).port };
}

/** Raw TCP client: resolves with everything received and the time until close. */
function rawClient(port: number, onConnect: (c: import('node:net').Socket) => void): Promise<{ data: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let data = '';
    const c = net.connect(port, '127.0.0.1', () => onConnect(c));
    c.on('data', (d) => { data += d.toString(); });
    c.on('error', () => undefined);
    c.on('close', () => resolve({ data, ms: Date.now() - t0 }));
  });
}

test('slowloris: a client that never finishes its headers is cut after headersTimeout', async () => {
  const { port } = await hardenedHttp();
  const r = await rawClient(port, (c) => {
    c.write('GET / HTTP/1.1\r\nHost: x\r\n');
    const iv = setInterval(() => { if (!c.destroyed) c.write('X-a: b\r\n'); }, 100); // trickles header lines
    c.on('close', () => clearInterval(iv));
  });
  assert.ok(r.ms >= 550 && r.ms < 2_000, `closed after ${r.ms} ms`);
  // Node answers 408; the client may see a reset instead (it was still sending)
  assert.ok(r.data === '' || /^HTTP\/1\.1 408/.test(r.data), r.data);
  // a connection that sends nothing at all is cut the same way
  const idle = await rawClient(port, () => undefined);
  assert.ok(idle.ms >= 550 && idle.ms < 2_000, `idle closed after ${idle.ms} ms`);
});

test('slow POST: a body that does not arrive within requestTimeout is cut', async () => {
  const { port } = await hardenedHttp();
  const r = await rawClient(port, (c) => {
    c.write('POST /upload HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\n');
    const iv = setInterval(() => { if (!c.destroyed) c.write('a'); }, 100);
    c.on('close', () => clearInterval(iv));
  });
  assert.ok(r.ms >= 1_100 && r.ms < 3_000, `closed after ${r.ms} ms`);
  // the request was already dispatched (headers complete), so Node closes without a 408
  assert.ok(!/got \d+/.test(r.data), 'the truncated body never completes');
});

test('idle keep-alive connections are closed after keepAliveTimeout', async () => {
  const { port } = await hardenedHttp({ headersTimeoutMs: 5_000, requestTimeoutMs: 10_000 });
  const r = await rawClient(port, (c) => c.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'));
  assert.match(r.data, /^HTTP\/1\.1 200/);
  assert.ok(r.ms >= 250 && r.ms < 1_500, `closed after ${r.ms} ms`);
});

test('long-lived responses (SSE, long-poll POST) and WebSocket upgrades outlive requestTimeout', async () => {
  const { port } = await hardenedHttp();
  const t0 = Date.now();
  const [sse, ping, ws] = await Promise.all([
    rawClient(port, (c) => c.write('GET /sse HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')),
    rawClient(port, (c) => c.write('POST /ping HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: 4\r\n\r\nPING')),
    rawClient(port, (c) => {
      c.write('GET /jmap/ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n');
      setTimeout(() => c.write('hello'), 1_800);
      setTimeout(() => c.end(), 2_400);
    }),
  ]);
  assert.ok(Date.now() - t0 >= 2_400);
  assert.match(sse.data, /^HTTP\/1\.1 200/);
  assert.match(sse.data, /data: done/);
  assert.ok(sse.ms >= 2_400, `SSE lasted ${sse.ms} ms`);
  assert.match(ping.data, /pong PING/);
  assert.match(ws.data, /^HTTP\/1\.1 101/);
  assert.match(ws.data, /echo:hello/);
  assert.match(ws.data, /late-frame/);
  assert.ok(ws.ms >= 2_300 && ws.ms < 5_000, `upgraded socket lasted ${ws.ms} ms`);
});

test('per-IP cap: the N+1st concurrent connection gets 503, a slot frees on close', async () => {
  const { port, guard } = await hardenedHttp({ maxConnectionsPerIp: 2, headersTimeoutMs: 5_000, requestTimeoutMs: 10_000 });
  const open: import('node:net').Socket[] = [];
  for (let i = 0; i < 2; i++) {
    open.push(await new Promise((r) => { const c = net.connect(port, '127.0.0.1', () => r(c)); c.on('error', () => undefined); }));
  }
  await sleep(50);
  assert.equal(guard.count('127.0.0.1'), 2);
  const refused = await rawClient(port, (c) => c.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n'));
  assert.match(refused.data, /^HTTP\/1\.1 503 Service Unavailable/);
  assert.match(refused.data, /Too many connections\n$/);
  assert.ok(!refused.data.includes('\r\n\r\nok'), 'the request on the refused socket never reaches the app');
  open[0]!.destroy();
  await sleep(50);
  const again = await rawClient(port, (c) => c.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
  assert.match(again.data, /^HTTP\/1\.1 200/);
  for (const c of open) c.destroy();
});

test('HTTPS: handshake timeout, and over-cap connections are destroyed before TLS', async (t) => {
  let pair: { certPem: string; keyPem: string };
  try { pair = core.generateSelfSignedCert('localhost'); } catch { t.skip('openssl not available'); return; }
  const config = hh.normalizeTimeouts({
    ...hh.HTTP_HARDENING_DEFAULTS, headersTimeoutMs: 5_000, requestTimeoutMs: 10_000, keepAliveTimeoutMs: 300,
    connectionsCheckingIntervalMs: 100, tlsHandshakeTimeoutMs: 1_000, maxConnectionsPerIp: 1, maxConnections: 0,
  });
  const guard = new hh.HttpConnectionGuard({ maxPerIp: 1, maxTotal: 0, isExempt: () => false, bypassAll: () => false, onRefused: () => undefined });
  const server = https.createServer({ ...hh.httpsServerOptions(config), cert: pair.certPem, key: pair.keyPem }, (_req, res) => res.end('ok'));
  hh.hardenHttpServer(server, { kind: 'https', guard, config });
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  servers.push(server as unknown as Server);
  const port = (server.address() as AddressInfo).port;

  // TCP connect without a ClientHello → closed after the handshake timeout
  const noHello = await rawClient(port, () => undefined);
  assert.ok(noHello.ms >= 900 && noHello.ms < 3_000, `closed after ${noHello.ms} ms`);
  await sleep(50);

  // one TLS connection holds the only slot; the second one never completes the handshake
  const first = await new Promise<import('node:tls').TLSSocket>((r) => {
    const c = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false }, () => r(c));
  });
  const second = await new Promise<string>((r) => {
    const c = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false }, () => { r('secure'); c.destroy(); });
    c.on('error', (e: NodeJS.ErrnoException) => r(e.code ?? 'error'));
    c.on('close', () => r('closed'));
  });
  assert.notEqual(second, 'secure');
  first.destroy();
  await sleep(50);
  const third = await new Promise<string>((r) => {
    const c = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false }, () => { r('secure'); c.destroy(); });
    c.on('error', (e: NodeJS.ErrnoException) => r(e.code ?? 'error'));
  });
  assert.equal(third, 'secure');
});
