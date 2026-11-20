/**
 * 10.5 attack protection at SMTP connect: a block list entry gets
 * 554 5.7.1 on the plaintext listeners (25/587) and is dropped on the raw
 * socket before the TLS handshake on 465; everybody else gets the greeting.
 * Loopback sockets with an injected guard (loopback itself is never blocked).
 * Run: node --import tsx --test src/core/connect-guard.test.ts (in packages/smtp-server)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';
process.env['LOG_LEVEL'] ??= 'error';

const model = new Proxy({}, { get: () => async () => null });
(globalThis as Record<string, unknown>)['__prisma'] = new Proxy({}, {
  get: (_t, p) => (p === '$on' || p === '$connect' ? () => undefined : p === 'then' ? undefined : model),
});
const storage = await import('@coremail/storage');
(globalThis as Record<string, unknown>)['__mailAuthRedis'] = storage.createMemoryAuthRedis();
const { createSmtpServer, SMTP_BLOCKED_REPLY } = await import('./factory.js');
const { selfSignedTestCert } = await import('../test-cert.js');
type Config = import('./types.js').SmtpSessionConfig;
const CERT = selfSignedTestCert();

const config = (): Config => ({
  hostname: 'mx.example.test', maxSize: 1024 * 1024, maxRcpt: 10, requireAuth: false, tls: CERT,
  handlers: { onConnect: async () => true, onMailFrom: async () => null, onRcptTo: async () => null, onMessage: async () => undefined },
});

function guard(blocked: boolean) {
  const refused: string[] = [];
  return {
    refused,
    guard: {
      isBlocked: () => blocked,
      lockedFor: async () => 0,
      refused: (_ip: unknown, protocol: string, reason: string) => { refused.push(`${protocol}:${reason}`); },
    },
  };
}

const servers: net.Server[] = [];
after(() => { for (const s of servers) s.close(); });
async function listen(server: net.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return (server.address() as net.AddressInfo).port;
}

function collect(port: number, implicit: boolean, ms = 1500): Promise<{ data: string; closed: boolean; secure: boolean }> {
  return new Promise((resolve) => {
    const socket = implicit ? tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false }) : net.connect(port, '127.0.0.1');
    let data = '';
    let secure = false;
    socket.setEncoding('utf8');
    socket.on('secureConnect', () => { secure = true; });
    socket.on('data', (c: string) => { data += c; });
    socket.on('error', () => undefined);
    const t = setTimeout(() => { socket.destroy(); resolve({ data, closed: false, secure }); }, ms);
    socket.on('close', () => { clearTimeout(t); resolve({ data, closed: true, secure }); });
  });
}

test('plaintext listener: a blocked IP gets 554 5.7.1 and the connection closes', async () => {
  const g = guard(true);
  const port = await listen(createSmtpServer(config(), false, g.guard).server);
  const r = await collect(port, false);
  assert.equal(r.data, SMTP_BLOCKED_REPLY);
  assert.equal(r.closed, true);
  assert.deepEqual(g.refused, ['smtp:blocked']);
});

test('plaintext listener: other clients get the 220 greeting', async () => {
  const g = guard(false);
  const port = await listen(createSmtpServer(config(), false, g.guard).server);
  const r = await collect(port, false, 500);
  assert.match(r.data, /^220 mx\.example\.test/);
  assert.deepEqual(g.refused, []);
});

test('implicit TLS (465): a blocked IP is dropped on the raw socket, before the handshake', async () => {
  const g = guard(true);
  const port = await listen(createSmtpServer(config(), true, g.guard).server);
  const r = await collect(port, true);
  assert.equal(r.closed, true);
  assert.equal(r.secure, false);
  assert.equal(r.data, '');
  assert.deepEqual(g.refused, ['smtp:blocked']);
  const ok = guard(false);
  const port2 = await listen(createSmtpServer(config(), true, ok.guard).server);
  const r2 = await collect(port2, true, 800);
  assert.equal(r2.secure, true);
  assert.match(r2.data, /^220 /);
});
