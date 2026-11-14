/**
 * v6 crash safety + trust-proxy behaviour on a real loopback Express app:
 *  - async route rejection → 500 via error middleware, process stays alive
 *  - Prisma P2002/P2025 → 409/404 without leaking the Prisma message
 *  - TRUST_PROXY matrix for req.ip; loopback exemption ignores X-Forwarded-For;
 *    auditContext uses req.ip, never the raw header
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
