/**
 * v8.1 POP3 connection caps (admitConnection) and STLS handshake timeout.
 * Run: node --import tsx --test src/limits.test.ts (in packages/pop3-server)
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';
process.env['LOG_LEVEL'] ??= 'error';
(globalThis as Record<string, unknown>)['__prisma'] = { $on: () => undefined };

const { ConnectionLimiter } = await import('@coremail/core');
const { admitConnection } = await import('./limits.js');
const { POP3Session } = await import('./session.js');
const { selfSignedTestCert } = await import('./test-cert.js');
const CERT = selfSignedTestCert();

interface Conn { socket: net.Socket; data: string; closed: Promise<void> }

function open(port: number, implicit = false): Promise<Conn> {
  const socket = implicit
    ? tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false })
    : net.connect(port, '127.0.0.1');
  const conn: Conn = { socket, data: '', closed: new Promise((r) => socket.once('close', () => r())) };
  socket.setEncoding('utf8');
  socket.on('data', (c: string) => { conn.data += c; });
  socket.on('error', () => undefined);
  return new Promise((resolve) => {
    socket.once(implicit ? 'secureConnect' : 'connect', () => resolve(conn));
    socket.once('close', () => resolve(conn));
  });
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function listen(t: TestContext, server: net.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return (server.address() as net.AddressInfo).port;
}

test('per-IP cap: the connection above the limit gets -ERR [SYS/TEMP] and is closed; the slot is freed on close', async (t) => {
  const limiter = new ConnectionLimiter({ maxPerIp: 2, maxTotal: 100 });
  const server = net.createServer((raw) => { if (admitConnection(raw, false, limiter)) raw.write('+OK ready\r\n'); });
  const port = await listen(t, server);
  const a = await open(port);
  const b = await open(port);
  t.after(() => { a.socket.destroy(); b.socket.destroy(); });
  await waitFor(() => a.data.startsWith('+OK') && b.data.startsWith('+OK'));
  const c = await open(port);
  await c.closed;
  assert.match(c.data, /^-ERR \[SYS\/TEMP\] too many connections/);
  a.socket.destroy();
  await a.closed;
  await waitFor(() => limiter.count() === 1);
  const d = await open(port);
  t.after(() => d.socket.destroy());
  await waitFor(() => d.data.startsWith('+OK'));
});

test('global cap on implicit TLS drops the raw connection before the handshake', async (t) => {
  const limiter = new ConnectionLimiter({ maxPerIp: 0, maxTotal: 1 });
  const server = tls.createServer({ ...CERT }, (s) => { s.write('+OK ready\r\n'); });
  server.on('connection', (raw: net.Socket) => { admitConnection(raw, true, limiter); });
  const port = await listen(t, server);
  const a = await open(port, true);
  t.after(() => a.socket.destroy());
  await waitFor(() => a.data.startsWith('+OK'));
  const b = await open(port, true);
  await b.closed;
  assert.equal(b.data, '');
});

test('an STLS handshake that never starts is cut off', async (t) => {
  const server = net.createServer((s) => new POP3Session(s, false, { starttls: () => CERT, tlsHandshakeMs: 150 }).start());
  const port = await listen(t, server);
  const c = await open(port);
  t.after(() => c.socket.destroy());
  await waitFor(() => c.data.includes('\r\n'));
  c.socket.write('STLS\r\n');
  await waitFor(() => c.data.includes('+OK Begin TLS'));
  // no ClientHello
  await Promise.race([c.closed, new Promise((_r, rej) => setTimeout(() => rej(new Error('still open')), 2000))]);
});
