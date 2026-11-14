/**
 * v7 SMTP submission security: AUTH only after TLS, STARTTLS discards
 * pipelined plaintext, AUTH failure limit per session, lockout/temporary
 * failure replies. Loopback sockets, in-memory handlers, throw-away cert.
 * Run: node --import tsx --test src/core/session-auth-tls.test.ts (in packages/smtp-server)
 */
import { test, describe, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';

const { SmtpSession } = await import('./session.js');
const { selfSignedTestCert } = await import('../test-cert.js');
type Config = import('./types.js').SmtpSessionConfig;
type VerifyResult = Awaited<ReturnType<NonNullable<Config['verifyCredentials']>>>;

const CERT = selfSignedTestCert();
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

class Client {
  buffer = '';
  closed = false;
  private wake: (() => void) | null = null;
  constructor(public socket: net.Socket) { this.attach(socket); }
  attach(socket: net.Socket): void {
    this.socket = socket;
    socket.setEncoding('latin1');
    socket.on('data', (c: string) => { this.buffer += c; this.wake?.(); });
    socket.on('close', () => { this.closed = true; this.wake?.(); });
    socket.on('error', () => undefined);
  }
  write(s: string): void { this.socket.write(s, 'latin1'); }
  async line(timeoutMs = 3000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.buffer.indexOf('\r\n');
      if (i !== -1) { const l = this.buffer.slice(0, i); this.buffer = this.buffer.slice(i + 2); return l; }
      if (this.closed) throw new Error('closed');
      const rest = deadline - Date.now();
      if (rest <= 0) throw new Error(`timeout (buffer ${JSON.stringify(this.buffer)})`);
      await new Promise<void>((r) => { const t = setTimeout(r, rest); this.wake = () => { clearTimeout(t); r(); }; });
    }
  }
  async reply(): Promise<string[]> {
    const lines: string[] = [];
    for (;;) { const l = await this.line(); lines.push(l); if (/^\d{3}( |$)/.test(l)) return lines; }
  }
  async cmd(c: string): Promise<string[]> { this.write(`${c}\r\n`); return this.reply(); }
  /** Upgrades to TLS after a 220 to STARTTLS. */
  async startTls(): Promise<void> {
    this.socket.removeAllListeners('data');
    this.socket.removeAllListeners('close');
    const secure = tls.connect({ socket: this.socket, rejectUnauthorized: false });
    await new Promise<void>((resolve, reject) => { secure.once('secureConnect', resolve); secure.once('error', reject); });
    this.buffer = '';
    this.attach(secure);
  }
  async waitClosed(ms = 2000): Promise<boolean> {
    const end = Date.now() + ms;
    while (!this.closed && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    return this.closed;
  }
}

interface Opts {
  implicitTls?: boolean;
  verify?: (u: string, p: string) => Promise<VerifyResult>;
  starttls?: boolean;
  requireAuth?: boolean;
}

async function connect(t: TestContext, opts: Opts = {}) {
  const seen = { commands: [] as string[], credentials: [] as string[] };
  const config: Config = {
    hostname: 'mx.example.test',
    maxSize: 1024 * 1024,
    maxRcpt: 10,
    requireAuth: opts.requireAuth ?? true,
    ...(opts.starttls === false ? {} : { tls: CERT }),
    handlers: {
      onConnect: async () => true,
      onMailFrom: async (from) => { seen.commands.push(`MAIL ${from}`); return null; },
      onRcptTo: async (to) => { seen.commands.push(`RCPT ${to}`); return null; },
      onMessage: async () => undefined,
    },
    verifyCredentials: async (u, p) => {
      seen.credentials.push(`${u}:${p}`);
      if (opts.verify) return opts.verify(u, p);
      return u === 'user@example.test' && p === 'secret' ? { id: 'u1', email: u } : null;
    },
  };
  const server = opts.implicitTls
    ? tls.createServer({ ...CERT }, (s) => new SmtpSession(s, config).start())
    : net.createServer((s) => new SmtpSession(s, config).start());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as net.AddressInfo;
  const socket = opts.implicitTls
    ? tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false })
    : net.connect(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    socket.once(opts.implicitTls ? 'secureConnect' : 'connect', resolve);
    socket.once('error', reject);
  });
  const client = new Client(socket);
  t.after(() => { client.socket.destroy(); server.close(); });
  await client.reply(); // greeting
  return { client, seen };
}

const keywords = (lines: string[]) => lines.slice(1).map((l) => l.slice(4).split(' ')[0]);

describe('AUTH only after TLS (port 587)', () => {
  test('EHLO on plaintext advertises STARTTLS but not AUTH', async (t) => {
    const { client } = await connect(t);
    const ehlo = await client.cmd('EHLO c.example.test');
    assert.ok(keywords(ehlo).includes('STARTTLS'));
    assert.ok(!keywords(ehlo).includes('AUTH'), ehlo.join('|'));
  });

  test('AUTH before STARTTLS is refused with 538 and the verifier is never called', async (t) => {
    const { client, seen } = await connect(t);
    await client.cmd('EHLO c.example.test');
    const reply = await client.cmd(`AUTH PLAIN ${b64('\0user@example.test\0secret')}`);
    assert.match(reply.at(-1) ?? '', /^538 5\.7\.11/);
    const login = await client.cmd('AUTH LOGIN');
    assert.match(login.at(-1) ?? '', /^538 /);
    assert.deepEqual(seen.credentials, []);
  });

  test('without a certificate AUTH stays unavailable on plaintext', async (t) => {
    const { client } = await connect(t, { starttls: false });
    const ehlo = await client.cmd('EHLO c.example.test');
    assert.ok(!keywords(ehlo).includes('AUTH') && !keywords(ehlo).includes('STARTTLS'));
    assert.match((await client.cmd(`AUTH PLAIN ${b64('\0user@example.test\0secret')}`)).at(-1) ?? '', /^538 /);
  });

  test('after STARTTLS, EHLO advertises AUTH (and no STARTTLS) and AUTH succeeds', async (t) => {
    const { client } = await connect(t);
    await client.cmd('EHLO c.example.test');
    assert.match((await client.cmd('STARTTLS')).at(-1) ?? '', /^220 /);
    await client.startTls();
    const ehlo = await client.cmd('EHLO c.example.test');
    assert.ok(keywords(ehlo).includes('AUTH'));
    assert.ok(!keywords(ehlo).includes('STARTTLS'));
    assert.match((await client.cmd(`AUTH PLAIN ${b64('\0user@example.test\0secret')}`)).at(-1) ?? '', /^235 /);
  });

  test('implicit TLS (port 465) advertises AUTH right away', async (t) => {
    const { client } = await connect(t, { implicitTls: true });
    const ehlo = await client.cmd('EHLO c.example.test');
    assert.ok(keywords(ehlo).includes('AUTH'));
    assert.ok(!keywords(ehlo).includes('STARTTLS'));
  });
});

describe('STARTTLS discards pipelined plaintext (CVE-2011-0411 class)', () => {
  test('commands sent in the same packet after STARTTLS are not executed', async (t) => {
    const { client, seen } = await connect(t, { requireAuth: false });
    await client.cmd('EHLO c.example.test');
    client.write('STARTTLS\r\nMAIL FROM:<injected@evil.test>\r\nRCPT TO:<victim@example.test>\r\n');
    assert.match((await client.reply()).at(-1) ?? '', /^220 /);
    await client.startTls();
    // The injected commands must not have produced plaintext or TLS replies.
    const ehlo = await client.cmd('EHLO c.example.test');
    assert.match(ehlo[0] ?? '', /^250[- ]/);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(seen.commands, []);
    // No transaction leaked into the TLS session: RCPT without MAIL is a bad sequence.
    assert.match((await client.cmd('RCPT TO:<b@example.test>')).at(-1) ?? '', /^503 /);
  });
});

describe('AUTH failure handling', () => {
  test('the third failure is answered with 535 followed by 421', async (t) => {
    const { client } = await connect(t, { implicitTls: true });
    await client.cmd('EHLO c.example.test');
    await client.cmd(`AUTH PLAIN ${b64('\0user@example.test\0x1')}`);
    await client.cmd(`AUTH PLAIN ${b64('\0user@example.test\0x2')}`);
    assert.match((await client.cmd(`AUTH PLAIN ${b64('\0user@example.test\0x3')}`)).at(-1) ?? '', /^535 /);
    assert.match((await client.reply()).at(-1) ?? '', /^421 4\.7\.0/);
    assert.equal(await client.waitClosed(), true);
  });

  test('a lockout is answered with 454 4.7.0', async (t) => {
    const { client } = await connect(t, { implicitTls: true, verify: async () => ({ failure: 'locked', retryAfterSec: 60 }) });
    await client.cmd('EHLO c.example.test');
    assert.match((await client.cmd(`AUTH PLAIN ${b64('\0user@example.test\0secret')}`)).at(-1) ?? '', /^454 4\.7\.0/);
  });

  test('a temporary failure (database down) is answered with 454 4.7.0, not 535', async (t) => {
    const { client } = await connect(t, { implicitTls: true, verify: async () => ({ failure: 'temporary' }) });
    await client.cmd('EHLO c.example.test');
    assert.match((await client.cmd(`AUTH PLAIN ${b64('\0user@example.test\0secret')}`)).at(-1) ?? '', /^454 4\.7\.0/);
    // temporary failures do not count towards the per-session limit
    await client.cmd(`AUTH PLAIN ${b64('\0user@example.test\0secret')}`);
    await client.cmd(`AUTH PLAIN ${b64('\0user@example.test\0secret')}`);
    assert.match((await client.cmd('NOOP')).at(-1) ?? '', /^250 /);
  });

  test('AUTH LOGIN with the username as initial response prompts for the password', async (t) => {
    const { client } = await connect(t, { implicitTls: true });
    await client.cmd('EHLO c.example.test');
    assert.equal((await client.cmd(`AUTH LOGIN ${b64('user@example.test')}`)).at(-1), '334 UGFzc3dvcmQ6');
    assert.match((await client.cmd(b64('secret'))).at(-1) ?? '', /^235 /);
  });
});
