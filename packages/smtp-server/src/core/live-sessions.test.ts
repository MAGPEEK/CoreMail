/**
 * v7.1.0: authenticated SMTP submission sessions end with
 * "421 4.7.0 … Credentials changed" after a credential change — never in the
 * middle of a DATA transfer (the body is read to its end and the message is
 * rejected), a delivery already in progress completes first, app password
 * revocation only ends sessions that used THAT app password, other users and
 * neutral events are left alone.
 * 9.4: submission switched off → open sessions end with "421 … Mail submission
 * has been disabled", AUTH with correct credentials gets 535 5.7.1.
 * Loopback TLS sockets, in-memory handlers.
 * Run: node --import tsx --test src/core/live-sessions.test.ts (in packages/smtp-server)
 */
import { test, describe, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';
process.env['LOG_LEVEL'] ??= 'error';

const core = await import('@coremail/core');
const { SmtpSession } = await import('./session.js');
const { smtpLiveSessions } = await import('./live-sessions.js');
const { selfSignedTestCert } = await import('../test-cert.js');
type Config = import('./types.js').SmtpSessionConfig;

const CERT = selfSignedTestCert();
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
smtpLiveSessions.attachInvalidation();
const publish = (event: Parameters<typeof core.publishAuthInvalidation>[0]) => core.publishAuthInvalidation(event, { redis: null });

const delivered: string[] = [];
let deliveryGate: Promise<void> | null = null;

const ACCOUNTS: Record<string, Awaited<ReturnType<NonNullable<Config['verifyCredentials']>>>> = {
  'bob@example.test:secret': { id: 'u1', email: 'bob@example.test', credential: 'password' },
  'bob@example.test:APP-ONE': { id: 'u1', email: 'bob@example.test', credential: 'app_password', appPasswordId: 'ap1' },
  'bob@example.test:APP-TWO': { id: 'u1', email: 'bob@example.test', credential: 'app_password', appPasswordId: 'ap2' },
  'carol@example.test:secret': { id: 'u2', email: 'carol@example.test', credential: 'password' },
  // 9.4: correct credentials, submission switched off (verifySmtpCredentials → protocol_disabled)
  'dave@example.test:secret': { failure: 'protocol_disabled' },
};

const config: Config = {
  hostname: 'mx.example.test',
  maxSize: 1024 * 1024,
  maxRcpt: 10,
  requireAuth: true,
  tls: CERT,
  handlers: {
    onConnect: async () => true,
    onMailFrom: async () => null,
    onRcptTo: async () => null,
    onMessage: async (raw) => { if (deliveryGate) await deliveryGate; delivered.push(raw.toString('latin1')); },
  },
  verifyCredentials: async (u, p) => ACCOUNTS[`${u}:${p}`] ?? null,
};

class Client {
  buffer = '';
  closed = false;
  private wake: (() => void) | null = null;
  constructor(public socket: net.Socket) {
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
  async cmd(c: string): Promise<string> { this.write(`${c}\r\n`); return (await this.reply()).at(-1) ?? ''; }
  async waitClosed(ms = 3000): Promise<void> {
    const end = Date.now() + ms;
    while (!this.closed) {
      if (Date.now() > end) throw new Error('connection not closed');
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

let server: tls.Server | null = null;
async function port(): Promise<number> {
  if (!server) {
    server = tls.createServer({ ...CERT }, (s) => new SmtpSession(s, config).start());
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    server.unref();
  }
  return (server.address() as net.AddressInfo).port;
}

async function login(t: TestContext, user: string, password: string): Promise<Client> {
  const socket = tls.connect({ port: await port(), host: '127.0.0.1', rejectUnauthorized: false });
  await new Promise<void>((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
  const c = new Client(socket);
  t.after(() => socket.destroy());
  await c.reply(); // greeting
  assert.match(await c.cmd('EHLO c.example.test'), /^250 /);
  assert.match(await c.cmd(`AUTH PLAIN ${b64(`\0${user}\0${password}`)}`), /^235 /);
  return c;
}

const CLOSE = /^421 4\.7\.0 mx\.example\.test Credentials changed/;
async function expectClosed(c: Client): Promise<void> {
  assert.match(await c.line(), CLOSE);
  await c.waitClosed();
}
async function expectAlive(c: Client): Promise<void> {
  assert.match(await c.cmd('NOOP'), /^250 /);
}

describe('SMTP submission sessions after credential changes', () => {
  for (const reason of ['password-change', 'password-reset', 'admin-password-reset', 'mfa-change', 'deactivated', 'deleted', 'admin-revoke:x'] as const) {
    test(`${reason}: 421 and close, other users keep their session`, async (t) => {
      const bob = await login(t, 'bob@example.test', 'secret');
      const carol = await login(t, 'carol@example.test', 'secret');
      await publish({ userId: 'u1', reason });
      await expectClosed(bob);
      await expectAlive(carol);
    });
  }

  test('app password revoked: only the session with that app password ends', async (t) => {
    const one = await login(t, 'bob@example.test', 'APP-ONE');
    const two = await login(t, 'bob@example.test', 'APP-TWO');
    const pw = await login(t, 'bob@example.test', 'secret');
    await publish({ userId: 'u1', reason: 'app-password-revoked', appPasswordId: 'ap1' });
    await expectClosed(one);
    await expectAlive(two);
    await expectAlive(pw);
  });

  test('neutral events and MFA (for app-password sessions) keep the session', async (t) => {
    const app = await login(t, 'bob@example.test', 'APP-TWO');
    for (const reason of ['role-change', 'app-password-created', 'reactivated', 'mfa-change'] as const) await publish({ userId: 'u1', reason });
    await publish({ userId: 'u1', reason: 'sessions-revoked', sessionIds: ['web'] });
    await expectAlive(app);
  });

  test('open transaction (after RCPT): 421 immediately', async (t) => {
    const bob = await login(t, 'bob@example.test', 'secret');
    assert.match(await bob.cmd('MAIL FROM:<bob@example.test>'), /^250 /);
    assert.match(await bob.cmd('RCPT TO:<x@example.org>'), /^250 /);
    await publish({ userId: 'u1', reason: 'password-change' });
    await expectClosed(bob);
  });

  test('during DATA: the body is read to its end, then rejected with 421 (not delivered)', async (t) => {
    const bob = await login(t, 'bob@example.test', 'secret');
    assert.match(await bob.cmd('MAIL FROM:<bob@example.test>'), /^250 /);
    assert.match(await bob.cmd('RCPT TO:<x@example.org>'), /^250 /);
    assert.match(await bob.cmd('DATA'), /^354 /);
    bob.write('Subject: during-data\r\n\r\nfirst half\r\n');
    await new Promise((r) => setTimeout(r, 30));
    await publish({ userId: 'u1', reason: 'mfa-change' });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(bob.closed, false, 'never closed in the middle of the body');
    assert.equal(bob.buffer, '', 'no reply in the middle of the body');
    bob.write('QUIT is body text here\r\n.\r\nMAIL FROM:<bob@example.test>\r\n');
    await expectClosed(bob);
    assert.ok(!delivered.some((m) => m.includes('during-data')), 'message must not be accepted');
  });

  test('a delivery in progress completes (250) before the 421', async (t) => {
    const bob = await login(t, 'bob@example.test', 'secret');
    let release!: () => void;
    deliveryGate = new Promise<void>((r) => { release = r; });
    try {
      assert.match(await bob.cmd('MAIL FROM:<bob@example.test>'), /^250 /);
      assert.match(await bob.cmd('RCPT TO:<x@example.org>'), /^250 /);
      assert.match(await bob.cmd('DATA'), /^354 /);
      bob.write('Subject: in-delivery\r\n\r\nbody\r\n.\r\nNOOP\r\n');
      await new Promise((r) => setTimeout(r, 30));
      await publish({ userId: 'u1', reason: 'password-reset' });
      release();
      assert.match(await bob.line(), /^250 2\.0\.0 OK/);
      await expectClosed(bob); // the pipelined NOOP never runs
      assert.ok(delivered.some((m) => m.includes('in-delivery')));
    } finally {
      deliveryGate = null;
    }
  });

  test('closed sessions leave the registry', async (t) => {
    const bob = await login(t, 'bob@example.test', 'secret');
    assert.ok(smtpLiveSessions.count('u1') >= 1);
    assert.match(await bob.cmd('QUIT'), /^221 /);
    await bob.waitClosed();
    for (let i = 0; i < 20 && smtpLiveSessions.count('u1') > 0; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(smtpLiveSessions.count('u1'), 0);
  });
});

describe('SMTP submission switch (9.4)', () => {
  test('submission off: the session ends with 421, other protocols\' events and users are left alone', async (t) => {
    const bob = await login(t, 'bob@example.test', 'APP-ONE');
    const carol = await login(t, 'carol@example.test', 'secret');
    await publish({ userId: 'u1', reason: 'protocol-access-change', disabledProtocols: ['imap', 'mapi'] });
    await expectAlive(bob);
    await publish({ userId: 'u1', reason: 'protocol-access-change', disabledProtocols: ['smtp', 'mapi'] });
    assert.match(await bob.line(), /^421 4\.7\.0 mx\.example\.test Mail submission has been disabled for this account/);
    await bob.waitClosed();
    await expectAlive(carol);
  });

  test('AUTH with correct credentials while submission is off: 535 5.7.1, not counted as a failure', async (t) => {
    const socket = tls.connect({ port: await port(), host: '127.0.0.1', rejectUnauthorized: false });
    await new Promise<void>((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
    const c = new Client(socket);
    t.after(() => socket.destroy());
    await c.reply();
    assert.match(await c.cmd('EHLO c.example.test'), /^250 /);
    for (let i = 0; i < 4; i++) {
      assert.equal(await c.cmd(`AUTH PLAIN ${b64('\0dave@example.test\0secret')}`), '535 5.7.1 Mail submission is disabled for this account');
    }
    assert.equal(c.closed, false, 'the AUTH failure limit does not apply');
  });
});
