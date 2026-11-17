/**
 * "Ältere Clients erlauben (TLS 1.0/1.1)" on real loopback handshakes:
 *  - default listener: TLS 1.0 and 1.1 are refused, TLS 1.2/1.3 work;
 *  - legacy listener: TLS 1.0/1.1 work (ECDHE-AES-SHA), TLS 1.2+ keeps AEAD;
 *  - a client that only offers RC4 / 3DES / NULL suites is refused even then;
 *  - both implicit TLS (createSmtpServer, port 465 type) and STARTTLS (session).
 * Throw-away certificate, in-memory handlers and mail-auth store.
 * Run: node --import tsx --test src/core/legacy-tls-handshake.test.ts (in packages/smtp-server)
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';
process.env['LOG_LEVEL'] ??= 'error';

// No database: every model call resolves to null (connection handling may log).
const model = new Proxy({}, { get: () => async () => null });
(globalThis as Record<string, unknown>)['__prisma'] = new Proxy({}, {
  get: (_t, p) => (p === '$on' || p === '$connect' ? () => undefined : p === 'then' ? undefined : model),
});
const storage = await import('@coremail/storage');
(globalThis as Record<string, unknown>)['__mailAuthRedis'] = storage.createMemoryAuthRedis();
const { SmtpSession } = await import('./session.js');
const { createSmtpServer } = await import('./factory.js');
const { selfSignedTestCert } = await import('../test-cert.js');
type Config = import('./types.js').SmtpSessionConfig;

const CERT = selfSignedTestCert();

function config(allowLegacyTls: boolean): Config {
  return {
    hostname: 'mx.example.test',
    maxSize: 1024 * 1024,
    maxRcpt: 10,
    requireAuth: false,
    tls: CERT,
    allowLegacyTls,
    handlers: {
      onConnect: async () => true,
      onMailFrom: async () => null,
      onRcptTo: async () => null,
      onMessage: async () => undefined,
    },
  };
}

interface Outcome { ok: boolean; protocol?: string | null; cipher?: string }

/**
 * Client side of a handshake pinned to one protocol version. A cipher list the
 * linked OpenSSL cannot build at all (e.g. RC4 compiled out) cannot be
 * negotiated either — reported as a failed handshake.
 */
function handshake(opts: tls.ConnectionOptions, version: tls.SecureVersion, ciphers = 'DEFAULT:@SECLEVEL=0'): Promise<Outcome> {
  return new Promise((resolve) => {
    let s: tls.TLSSocket;
    try {
      s = tls.connect({ ...opts, rejectUnauthorized: false, minVersion: version, maxVersion: version, ciphers });
    } catch {
      resolve({ ok: false });
      return;
    }
    s.once('secureConnect', () => { resolve({ ok: true, protocol: s.getProtocol(), cipher: s.getCipher().name }); s.destroy(); });
    s.once('error', () => resolve({ ok: false }));
  });
}

const servers: net.Server[] = [];
after(() => { for (const s of servers) s.close(); });

async function listen(server: net.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return (server.address() as net.AddressInfo).port;
}

async function implicitPort(allowLegacyTls: boolean): Promise<number> {
  const handle = createSmtpServer(config(allowLegacyTls), true);
  return listen(handle.server);
}

/** Plain SMTP up to "220 Ready to start TLS", then the TLS handshake on that socket. */
async function starttls(port: number, version: tls.SecureVersion, ciphers?: string): Promise<Outcome> {
  const socket = net.connect(port, '127.0.0.1');
  socket.setEncoding('latin1');
  let buf = '';
  const waitFor = (re: RegExp) => new Promise<void>((resolve, reject) => {
    const check = () => { if (re.test(buf)) { socket.off('data', onData); resolve(); } };
    const onData = (c: string) => { buf += c; check(); };
    socket.on('data', onData);
    socket.once('error', reject);
    check();
  });
  await waitFor(/^220 /m);
  socket.write('EHLO c.example.test\r\n');
  await waitFor(/^250 /m);
  buf = '';
  socket.write('STARTTLS\r\n');
  await waitFor(/^220 /m);
  socket.removeAllListeners('data');
  const out = await handshake({ socket }, version, ciphers);
  socket.destroy();
  return out;
}

async function starttlsPort(allowLegacyTls: boolean): Promise<number> {
  return listen(net.createServer((s) => new SmtpSession(s, config(allowLegacyTls)).start()));
}

describe('implicit TLS listener (createSmtpServer)', () => {
  test('default: TLS 1.0/1.1 refused, TLS 1.2 and 1.3 accepted', async () => {
    const port = await implicitPort(false);
    assert.equal((await handshake({ port, host: '127.0.0.1' }, 'TLSv1')).ok, false);
    assert.equal((await handshake({ port, host: '127.0.0.1' }, 'TLSv1.1')).ok, false);
    assert.equal((await handshake({ port, host: '127.0.0.1' }, 'TLSv1.2')).protocol, 'TLSv1.2');
    assert.equal((await handshake({ port, host: '127.0.0.1' }, 'TLSv1.3')).protocol, 'TLSv1.3');
  });

  test('legacy: TLS 1.0/1.1 accepted with a forward-secret AES suite; TLS 1.2 keeps AEAD', async () => {
    const port = await implicitPort(true);
    for (const v of ['TLSv1', 'TLSv1.1'] as const) {
      const r = await handshake({ port, host: '127.0.0.1' }, v);
      assert.equal(r.ok, true, v);
      assert.equal(r.protocol, v);
      assert.match(r.cipher ?? '', /^ECDHE-RSA-AES(128|256)-SHA$/);
    }
    const modern = await handshake({ port, host: '127.0.0.1' }, 'TLSv1.2');
    assert.match(modern.cipher ?? '', /GCM|CHACHA20/);
    assert.equal((await handshake({ port, host: '127.0.0.1' }, 'TLSv1.3')).protocol, 'TLSv1.3');
  });

  test('legacy: clients offering only RC4 / 3DES / NULL suites are refused', async () => {
    const port = await implicitPort(true);
    for (const weak of ['DES-CBC3-SHA:@SECLEVEL=0', 'RC4-SHA:@SECLEVEL=0', 'NULL-SHA:@SECLEVEL=0', 'EXP-RC4-MD5:@SECLEVEL=0']) {
      const r = await handshake({ port, host: '127.0.0.1' }, 'TLSv1', weak);
      assert.equal(r.ok, false, weak);
    }
    // the plain-RSA AES fallback (no ECDHE) still works for very old stacks
    assert.equal((await handshake({ port, host: '127.0.0.1' }, 'TLSv1', 'AES128-SHA:@SECLEVEL=0')).cipher, 'AES128-SHA');
  });
});

describe('STARTTLS (SmtpSession)', () => {
  test('default listener refuses TLS 1.0 after STARTTLS', async () => {
    const port = await starttlsPort(false);
    assert.equal((await starttls(port, 'TLSv1')).ok, false);
    assert.equal((await starttls(port, 'TLSv1.2')).ok, true);
  });

  test('legacy listener accepts TLS 1.0 and 1.1 after STARTTLS', async () => {
    const port = await starttlsPort(true);
    assert.equal((await starttls(port, 'TLSv1')).protocol, 'TLSv1');
    assert.equal((await starttls(port, 'TLSv1.1')).protocol, 'TLSv1.1');
  });
});
