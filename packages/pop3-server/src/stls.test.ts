/**
 * v7 POP3 transport security + shared credential check:
 *  - plaintext: CAPA offers STLS (not USER), USER/PASS refused with -ERR [AUTH]
 *  - STLS upgrade discards pipelined input; USER/PASS work afterwards
 *  - without a certificate: no STLS, USER/PASS still refused
 *  - MFA → app password only; database error → -ERR [SYS/TEMP]
 * Loopback sockets, fake Prisma via globalThis.__prisma, in-memory Redis.
 * Run: node --import tsx --test src/stls.test.ts (in packages/pop3-server)
 */
import { test, describe, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';

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
  domain: { findFirst: async () => { guard(); return { name: 'example.test' }; } },
  user: { findFirst: async ({ where }: { where: { email: string } }) => { guard(); return users.find((u) => u.email === where.email) ?? null; } },
  appPassword: {
    findMany: async ({ where }: { where: { userId: string } }) => { guard(); return where.userId === 'u2' ? [{ id: 'ap2', hash: 'hash:APP-PW' }] : []; },
    update: async () => ({}),
  },
  mailbox: { findFirst: async () => ({ id: 'mb', folders: [{ messages: [] }] }) },
};
const storage = await import('@coremail/storage');
(globalThis as Record<string, unknown>)['__mailAuthRedis'] = storage.createMemoryAuthRedis();
// Maildrop lock: in-process layer only (no Redis in tests).
(globalThis as Record<string, unknown>)['__pop3LockRedis'] = null;
storage.configureMailAuth({
  verifyPassword: async (p: string, h: string) => h === `hash:${p}`,
  dummyHash: async () => 'hash:\0dummy',
});
const { POP3Session } = await import('./session.js');
const { selfSignedTestCert } = await import('./test-cert.js');
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
  async cmd(c: string): Promise<string> { this.write(`${c}\r\n`); return this.line(); }
  async multi(c: string): Promise<string[]> {
    const status = await this.cmd(c);
    const lines = [status];
    if (!status.startsWith('+OK')) return lines;
    for (let l = await this.line(); l !== '.'; l = await this.line()) lines.push(l);
    return lines;
  }
  async startTls(): Promise<void> {
    this.socket.removeAllListeners('data');
    this.socket.removeAllListeners('close');
    const secure = tls.connect({ socket: this.socket, rejectUnauthorized: false });
    await new Promise<void>((resolve, reject) => { secure.once('secureConnect', resolve); secure.once('error', reject); });
    this.buffer = '';
    this.attach(secure);
  }
}

async function connect(t: TestContext, mode: 'stls' | 'nocert' | 'implicit' = 'stls') {
  const server = mode === 'implicit'
    ? tls.createServer({ ...CERT }, (s) => new POP3Session(s, true).start())
    : net.createServer((s) => new POP3Session(s, false, mode === 'stls' ? { starttls: () => CERT } : {}).start());
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
  await client.line(); // greeting
  return client;
}

describe('plaintext listener (port 110)', () => {
  test('CAPA offers STLS but not USER', async (t) => {
    const client = await connect(t);
    const capa = await client.multi('CAPA');
    assert.ok(capa.includes('STLS') && !capa.includes('USER'), capa.join('|'));
  });

  test('USER and PASS are refused with -ERR [AUTH] before TLS', async (t) => {
    const client = await connect(t);
    assert.match(await client.cmd('USER bob@example.test'), /^-ERR \[AUTH\]/);
    assert.match(await client.cmd('PASS secret'), /^-ERR \[AUTH\]/);
    assert.match(await client.cmd('STAT'), /^-ERR/);
  });

  test('without a certificate: no STLS, STLS answers -ERR, USER stays refused', async (t) => {
    const client = await connect(t, 'nocert');
    const capa = await client.multi('CAPA');
    assert.ok(!capa.includes('STLS') && !capa.includes('USER'), capa.join('|'));
    assert.match(await client.cmd('STLS'), /^-ERR/);
    assert.match(await client.cmd('USER bob@example.test'), /^-ERR \[AUTH\]/);
  });
});

describe('STLS (RFC 2595)', () => {
  test('upgrade → CAPA offers USER and no STLS, login works', async (t) => {
    const client = await connect(t);
    assert.match(await client.cmd('STLS'), /^\+OK/);
    await client.startTls();
    const capa = await client.multi('CAPA');
    assert.ok(capa.includes('USER') && !capa.includes('STLS'), capa.join('|'));
    assert.match(await client.cmd('USER bob@example.test'), /^\+OK/);
    assert.match(await client.cmd('PASS secret'), /^\+OK/);
  });

  test('commands pipelined after STLS are discarded', async (t) => {
    const client = await connect(t);
    client.write('STLS\r\nUSER bob@example.test\r\nPASS secret\r\n');
    assert.match(await client.line(), /^\+OK/);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(client.buffer, '', 'no plaintext reply after the STLS +OK');
    await client.startTls();
    // The injected USER/PASS never ran: still AUTHORIZATION, no user given.
    assert.match(await client.cmd('PASS secret'), /^-ERR send USER first/);
  });

  test('STLS on a TLS connection is refused', async (t) => {
    const client = await connect(t, 'implicit');
    assert.match(await client.cmd('STLS'), /^-ERR/);
  });
});

describe('shared credential check over TLS', () => {
  test('MFA account: primary password refused, app password accepted', async (t) => {
    const client = await connect(t, 'implicit');
    await client.cmd('USER mfa@example.test');
    assert.match(await client.cmd('PASS secret'), /^-ERR \[AUTH\]/);
    await client.cmd('USER mfa@example.test');
    assert.match(await client.cmd('PASS APP-PW'), /^\+OK/);
  });

  test('a database error is a temporary failure (-ERR [SYS/TEMP])', async (t) => {
    const client = await connect(t, 'implicit');
    await client.cmd('USER bob@example.test');
    state.dbDown = true;
    try {
      assert.match(await client.cmd('PASS secret'), /^-ERR \[SYS\/TEMP\]/);
    } finally {
      state.dbDown = false;
    }
  });
});
