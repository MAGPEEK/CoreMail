/**
 * v7 IMAP transport security + shared credential check:
 *  - plaintext listener: STARTTLS + LOGINDISABLED, no AUTH=, LOGIN/AUTHENTICATE
 *    refused with NO [PRIVACYREQUIRED] (also for literals, before the continuation)
 *  - STARTTLS upgrade discards pipelined input, re-advertises capabilities
 *  - without a certificate: no STARTTLS, authentication still refused
 *  - MFA → app password only, database error → NO [UNAVAILABLE]
 * Loopback sockets, fake Prisma via globalThis.__prisma, in-memory Redis.
 * Run: node --import tsx --test src/server/starttls.test.ts (in packages/imap-server)
 */
import { test, describe, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { noProtocolPolicies } from '@coremail/storage/auth/testing';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';

const state = { dbDown: false };
const users = [
  { id: 'u1', email: 'bob@example.test', displayName: 'Bob', domainId: 'd1', role: 'USER', active: true,
    passwordHash: 'hash:secret', authSource: 'LOCAL', mfa: null, mailbox: { id: 'mb1' } },
  { id: 'u2', email: 'mfa@example.test', displayName: 'Mfa', domainId: 'd1', role: 'USER', active: true,
    passwordHash: 'hash:secret', authSource: 'LOCAL', mfa: { totpEnabled: true, webAuthnCredentials: [] }, mailbox: { id: 'mb2' } },
];
const guard = () => { if (state.dbDown) throw new Error('db down'); };
(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  ...noProtocolPolicies(),
  domain: { findFirst: async () => { guard(); return { name: 'example.test' }; } },
  user: {
    findFirst: async ({ where }: { where: { email: string } }) => { guard(); return users.find((u) => u.email === where.email) ?? null; },
  },
  appPassword: {
    findMany: async ({ where }: { where: { userId: string } }) => { guard(); return where.userId === 'u2' ? [{ id: 'ap2', hash: 'hash:APP-PW' }] : []; },
    update: async () => ({}),
  },
};
const noop = () => undefined;
// IDLE push subscriber (getRedisClient().duplicate()) — never connects in tests.
process.env['REDIS_URL'] = 'redis://127.0.0.1:1';
const { getRedisClient } = await import('@coremail/core');
const redisClient = getRedisClient();
redisClient.disconnect(); // no reconnect loop in tests
(redisClient as unknown as Record<string, unknown>)['duplicate'] = () => ({ subscribe: async () => 1, on: noop });

const storage = await import('@coremail/storage');
(globalThis as Record<string, unknown>)['__mailAuthRedis'] = storage.createMemoryAuthRedis();
storage.configureMailAuth({
  verifyPassword: async (p: string, h: string) => h === `hash:${p}`,
  dummyHash: async () => 'hash:\0dummy',
});
const { createImapServer } = await import('./index.js');
const { selfSignedTestCert } = await import('../test-cert.js');
const CERT = selfSignedTestCert();

class Client {
  buffer = '';
  closed = false;
  private wake: (() => void) | null = null;
  constructor(public socket: net.Socket) { this.attach(socket); }
  attach(socket: net.Socket): void {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (c: string) => { this.buffer += c; this.wake?.(); });
    socket.on('close', () => { this.closed = true; this.wake?.(); });
    socket.on('error', () => undefined);
  }
  write(s: string): void { this.socket.write(s); }
  async line(timeoutMs = 3000): Promise<string> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const i = this.buffer.indexOf('\r\n');
      if (i !== -1) { const l = this.buffer.slice(0, i); this.buffer = this.buffer.slice(i + 2); return l; }
      if (this.closed) throw new Error('closed');
      const rest = end - Date.now();
      if (rest <= 0) throw new Error(`timeout (buffer ${JSON.stringify(this.buffer)})`);
      await new Promise<void>((r) => { const t = setTimeout(r, rest); this.wake = () => { clearTimeout(t); r(); }; });
    }
  }
  async tagged(tag: string): Promise<{ status: string; line: string; untagged: string[] }> {
    const untagged: string[] = [];
    for (;;) {
      const l = await this.line();
      if (l.startsWith(`${tag} `)) return { status: l.split(' ')[1] ?? '', line: l, untagged };
      untagged.push(l);
    }
  }
  async cmd(tag: string, c: string) { this.write(`${tag} ${c}\r\n`); return this.tagged(tag); }
  async startTls(): Promise<void> {
    this.socket.removeAllListeners('data');
    this.socket.removeAllListeners('close');
    const secure = tls.connect({ socket: this.socket, rejectUnauthorized: false });
    await new Promise<void>((resolve, reject) => { secure.once('secureConnect', resolve); secure.once('error', reject); });
    this.buffer = '';
    this.attach(secure);
  }
}

async function connect(t: TestContext, mode: 'starttls' | 'nocert' | 'implicit' = 'starttls') {
  const server = mode === 'implicit'
    ? createImapServer(CERT)
    : createImapServer(undefined, mode === 'starttls' ? { starttls: () => CERT } : {});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as net.AddressInfo;
  const socket = mode === 'implicit'
    ? tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false })
    : net.connect(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    socket.once(mode === 'implicit' ? 'secureConnect' : 'connect', resolve);
    socket.once('error', reject);
  });
  const client = new Client(socket);
  t.after(() => { client.socket.destroy(); server.close(); });
  const greeting = await client.line();
  return { client, greeting };
}

const caps = (line: string): string[] => (/CAPABILITY ([^\]]+?)(\]|$)/.exec(line)?.[1] ?? '').trim().split(' ');
const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('plaintext listener (port 143)', () => {
  test('greeting advertises STARTTLS and LOGINDISABLED and no AUTH= mechanism', async (t) => {
    const { greeting } = await connect(t);
    const c = caps(greeting);
    assert.ok(c.includes('STARTTLS') && c.includes('LOGINDISABLED'), c.join(' '));
    assert.ok(!c.some((x) => x.startsWith('AUTH=')), c.join(' '));
  });

  test('LOGIN is refused with NO [PRIVACYREQUIRED]', async (t) => {
    const { client } = await connect(t);
    const r = await client.cmd('A1', 'LOGIN bob@example.test secret');
    assert.match(r.line, /^A1 NO \[PRIVACYREQUIRED\]/);
  });

  test('AUTHENTICATE PLAIN (with and without SASL-IR) is refused before any continuation', async (t) => {
    const { client } = await connect(t);
    assert.match((await client.cmd('A1', `AUTHENTICATE PLAIN ${b64('\0bob@example.test\0secret')}`)).line, /^A1 NO \[PRIVACYREQUIRED\]/);
    const r = await client.cmd('A2', 'AUTHENTICATE PLAIN');
    assert.match(r.line, /^A2 NO \[PRIVACYREQUIRED\]/);
    assert.deepEqual(r.untagged, []);
  });

  test('a LOGIN literal is refused before the continuation request', async (t) => {
    const { client } = await connect(t);
    client.write('A1 LOGIN {16}\r\n');
    const l = await client.line();
    assert.match(l, /^A1 NO \[PRIVACYREQUIRED\]/);
  });

  test('without a certificate: no STARTTLS, LOGINDISABLED, STARTTLS answers NO and LOGIN stays refused', async (t) => {
    const { client, greeting } = await connect(t, 'nocert');
    const c = caps(greeting);
    assert.ok(!c.includes('STARTTLS') && c.includes('LOGINDISABLED'), c.join(' '));
    assert.equal((await client.cmd('A1', 'STARTTLS')).status, 'NO');
    assert.match((await client.cmd('A2', 'LOGIN bob@example.test secret')).line, /PRIVACYREQUIRED/);
  });
});

describe('STARTTLS (RFC 9051 §6.2.1)', () => {
  test('upgrade → capabilities re-advertised with AUTH= and without STARTTLS/LOGINDISABLED, LOGIN works', async (t) => {
    const { client } = await connect(t);
    assert.equal((await client.cmd('A1', 'STARTTLS')).status, 'OK');
    await client.startTls();
    const capa = await client.cmd('A2', 'CAPABILITY');
    const c = caps(capa.untagged[0] ?? '');
    assert.ok(c.includes('AUTH=PLAIN'), c.join(' '));
    assert.ok(!c.includes('STARTTLS') && !c.includes('LOGINDISABLED'), c.join(' '));
    const login = await client.cmd('A3', 'LOGIN bob@example.test secret');
    assert.equal(login.status, 'OK', login.line);
    assert.ok(!caps(login.line).includes('LOGINDISABLED'));
  });

  test('input pipelined after STARTTLS in the same packet is discarded', async (t) => {
    const { client } = await connect(t);
    client.write('A1 STARTTLS\r\nA2 LOGIN bob@example.test secret\r\nA3 NOOP\r\n');
    const r = await client.tagged('A1');
    assert.equal(r.status, 'OK');
    assert.equal(client.buffer, '', 'no plaintext reply after the STARTTLS OK');
    await client.startTls();
    // The injected LOGIN was not executed: the TLS session is still unauthenticated
    // and the first reply we see belongs to our own command.
    const sel = await client.cmd('B1', 'SELECT INBOX');
    assert.equal(sel.status, 'NO');
    assert.ok(!sel.untagged.some((l) => /^A[23] /.test(l)), sel.untagged.join('|'));
  });

  test('STARTTLS on a TLS connection is BAD', async (t) => {
    const { client } = await connect(t, 'implicit');
    assert.equal((await client.cmd('A1', 'STARTTLS')).status, 'BAD');
  });
});

describe('shared credential check over TLS', () => {
  test('implicit TLS advertises AUTH=PLAIN and AUTHENTICATE PLAIN works', async (t) => {
    const { client, greeting } = await connect(t, 'implicit');
    assert.ok(caps(greeting).includes('AUTH=PLAIN'));
    assert.equal((await client.cmd('A1', `AUTHENTICATE PLAIN ${b64('\0bob@example.test\0secret')}`)).status, 'OK');
  });

  test('MFA account: primary password refused, app password accepted', async (t) => {
    const { client } = await connect(t, 'implicit');
    const bad = await client.cmd('A1', 'LOGIN mfa@example.test secret');
    assert.match(bad.line, /^A1 NO \[AUTHENTICATIONFAILED\]/);
    assert.equal((await client.cmd('A2', 'LOGIN mfa@example.test APP-PW')).status, 'OK');
  });

  test('a bare user name is completed with the primary domain (LOGIN, as for AUTHENTICATE)', async (t) => {
    const { client } = await connect(t, 'implicit');
    assert.equal((await client.cmd('A1', 'LOGIN bob secret')).status, 'OK');
  });

  test('a database error is answered with NO [UNAVAILABLE], not AUTHENTICATIONFAILED', async (t) => {
    const { client } = await connect(t, 'implicit');
    state.dbDown = true;
    try {
      assert.match((await client.cmd('A1', 'LOGIN bob@example.test secret')).line, /^A1 NO \[UNAVAILABLE\]/);
    } finally {
      state.dbDown = false;
    }
  });
});
