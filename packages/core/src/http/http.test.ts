/**
 * v6 HTTP hardening helpers: error classification (no leaks), async handler
 * forwarding, Layer patch, process guards, TRUST_PROXY parsing, internal guard.
 * Run: node --import tsx --test src/http/http.test.ts  (in packages/core)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  classifyError, errorMiddleware, HttpError,
  asyncHandler, installAsyncErrorHandling,
  parseTrustProxy, isLoopbackAddress, stripForwardedHeaders, resolveBindHost,
  requireInternal, safeEqual,
} from './index.js';

const here = dirname(fileURLToPath(import.meta.url));

function prismaErr(code: string): Error {
  const e = new Error(`Invalid \`prisma.user.create()\` invocation: secret column "passwordHash" ${code}`) as Error & { code: string; clientVersion: string };
  e.name = 'PrismaClientKnownRequestError';
  e.code = code;
  e.clientVersion = '5.20.0';
  return e;
}

test('classifyError maps Prisma P2002 → 409, P2025 → 404, P2003 → 409 without leaking the message', () => {
  for (const [code, status] of [['P2002', 409], ['P2025', 404], ['P2003', 409], ['P2023', 400]] as const) {
    const c = classifyError(prismaErr(code));
    assert.equal(c.status, status, code);
    assert.ok(!JSON.stringify(c.body).includes('passwordHash'), `${code} leaks message`);
    assert.ok(!JSON.stringify(c.body).includes('prisma'), `${code} leaks prisma`);
  }
  const unknownCode = classifyError(prismaErr('P1001'));
  assert.equal(unknownCode.status, 500);
  assert.deepEqual(unknownCode.body, { error: 'Internal server error' });
});

test('classifyError maps ZodError → 400 with path/message details only', () => {
  const r = z.object({ role: z.enum(['USER', 'HELP_DESK']) }).safeParse({ role: 'ADMIN' });
  assert.ok(!r.success);
  const c = classifyError(r.error);
  assert.equal(c.status, 400);
  assert.equal(c.body.error, 'Invalid request');
  assert.equal(c.body.details?.[0]?.path, 'role');
});

test('classifyError: unknown errors → generic 500, HttpError keeps its public message', () => {
  const secret = new Error('ECONNREFUSED postgres://coremail:hunter2@db/coremail');
  const c = classifyError(secret);
  assert.equal(c.status, 500);
  assert.deepEqual(c.body, { error: 'Internal server error' });
  assert.ok(!JSON.stringify(c.body).includes('hunter2'));
  assert.deepEqual(classifyError('string thrown').body, { error: 'Internal server error' });
  assert.deepEqual(classifyError(new HttpError(403, 'Nope', 'FORBIDDEN')), { status: 403, body: { error: 'Nope', code: 'FORBIDDEN' } });
  assert.equal(classifyError({ type: 'entity.parse.failed', message: 'Unexpected token' }).status, 400);
  assert.equal(classifyError({ type: 'entity.too.large' }).status, 413);
  const withStatus = classifyError(Object.assign(new Error('internal detail'), { status: 404 }));
  assert.deepEqual(withStatus, { status: 404, body: { error: 'Bad request' } });
});

test('errorMiddleware responds with classified body and never the stack', () => {
  const logged: unknown[] = [];
  const log = { error: (o: object) => logged.push(o), warn: (o: object) => logged.push(o) };
  let sent: { status?: number; body?: unknown } = {};
  const res = {
    headersSent: false,
    status(code: number) { sent.status = code; return this; },
    json(body: unknown) { sent.body = body; return this; },
  };
  const err = new Error('boom at /app/secret/path.ts:12');
  errorMiddleware(log)(err, { method: 'GET', originalUrl: '/x?token=abc' }, res, () => assert.fail('next called'));
  assert.equal(sent.status, 500);
  assert.deepEqual(sent.body, { error: 'Internal server error' });
  assert.equal(logged.length, 1);
  assert.equal((logged[0] as { url: string }).url, '/x'); // query (tokens) not logged

  // headers already sent → delegate to next(err)
  sent = {};
  let forwarded: unknown;
  errorMiddleware(log)(err, {}, { ...res, headersSent: true }, (e) => { forwarded = e; });
  assert.equal(forwarded, err);
  assert.equal(sent.status, undefined);
});

test('asyncHandler forwards rejections and sync throws to next(err)', async () => {
  const errs: unknown[] = [];
  const next = (e?: unknown) => { errs.push(e); };
  type Args = [unknown, unknown, (e?: unknown) => void];
  asyncHandler<Args>(async () => { throw new Error('a'); })({}, {}, next);
  asyncHandler<Args>(() => { throw new Error('b'); })({}, {}, next);
  asyncHandler<Args>(async () => Promise.reject(undefined))({}, {}, next);
  asyncHandler<Args>(async () => 'ok')({}, {}, next);
  await new Promise((r) => setImmediate(r));
  assert.equal(errs.length, 3);
  const msgs = errs.map((e) => (e as Error).message).sort();
  assert.deepEqual(msgs.filter((m) => m === 'a' || m === 'b'), ['a', 'b']);
  assert.ok(errs.every((e) => e instanceof Error), 'undefined rejection becomes an Error (never next(undefined))');
});

test('installAsyncErrorHandling patches the Layer prototype of an Express-like module', async () => {
  class Layer {
    handle: (...a: unknown[]) => unknown;
    constructor(fn: (...a: unknown[]) => unknown) { this.handle = fn; }
    handle_request(req: unknown, res: unknown, next: (e?: unknown) => void) {
      try { this.handle(req, res, next); } catch (e) { next(e); }
    }
    handle_error(err: unknown, req: unknown, res: unknown, next: (e?: unknown) => void) {
      try { this.handle(err, req, res, next); } catch (e) { next(e); }
    }
  }
  const fakeExpress = { Router: () => { const stack: Layer[] = []; return { stack, use: (fn: () => void) => stack.push(new Layer(fn)) }; } };
  assert.equal(installAsyncErrorHandling(fakeExpress), true);
  assert.equal(installAsyncErrorHandling(fakeExpress), true, 'idempotent');
  assert.equal(installAsyncErrorHandling({}), false);

  const got: unknown[] = [];
  new Layer(async () => { throw new Error('async boom'); }).handle_request({}, {}, (e) => got.push(e));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  new Layer(async (_e: unknown, _q: unknown, _s: unknown, _n: unknown) => { throw new Error('err-handler boom'); })
    .handle_error(new Error('orig'), {}, {}, (e) => got.push(e));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(got.map((e) => (e as Error).message), ['async boom', 'err-handler boom']);
});

test('installProcessGuards: unhandled rejection keeps the process alive, uncaught exception exits 1', () => {
  const fixture = join(here, 'process-guards.fixture.ts');
  const r = spawnSync(process.execPath, ['--import', 'tsx', fixture], { encoding: 'utf8', timeout: 20_000 });
  assert.match(r.stdout, /ALIVE_AFTER_REJECTION/);
  assert.match(r.stdout, /Unhandled promise rejection/);
  assert.match(r.stdout, /Uncaught exception/);
  assert.equal(r.status, 1);
});

test('parseTrustProxy matrix', () => {
  assert.equal(parseTrustProxy(undefined), false);
  assert.equal(parseTrustProxy(''), false);
  assert.equal(parseTrustProxy('false'), false);
  assert.equal(parseTrustProxy('0'), false);
  assert.equal(parseTrustProxy('true'), true);
  assert.equal(parseTrustProxy('2'), 2);
  assert.deepEqual(parseTrustProxy('loopback, 10.0.0.0/8 ,fd00::/8'), ['loopback', '10.0.0.0/8', 'fd00::/8']);
  assert.throws(() => parseTrustProxy('evil.example.com'), /Invalid TRUST_PROXY/);
});

test('isLoopbackAddress / stripForwardedHeaders / resolveBindHost', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.8.9.10']) assert.equal(isLoopbackAddress(a), true, a);
  for (const a of ['10.0.0.1', '::ffff:10.0.0.1', '', undefined, '1.127.0.0']) assert.equal(isLoopbackAddress(a), false, String(a));
  const req = { headers: { 'x-forwarded-for': '127.0.0.1', forwarded: 'for=127.0.0.1', 'x-real-ip': '1.1.1.1', host: 'a' } as Record<string, unknown> };
  stripForwardedHeaders(req);
  assert.deepEqual(Object.keys(req.headers), ['host']);
  assert.equal(resolveBindHost({}), '127.0.0.1');
  assert.equal(resolveBindHost({ INTERNAL_BIND_HOST: '0.0.0.0' }), '0.0.0.0');
});

test('requireInternal: loopback-only without token, token required when configured', () => {
  const run = (guard: ReturnType<typeof requireInternal>, remoteAddress: string, headers: Record<string, string> = {}) => {
    let status = 0; let passed = false;
    const res = { status(c: number) { status = c; return this; }, json() { return this; } };
    guard({ socket: { remoteAddress }, headers }, res, () => { passed = true; });
    return passed ? 200 : status;
  };
  const open = requireInternal({ token: '' });
  assert.equal(run(open, '127.0.0.1'), 200);
  assert.equal(run(open, '::ffff:127.0.0.1'), 200);
  assert.equal(run(open, '172.18.0.5', { 'x-forwarded-for': '127.0.0.1' }), 403);

  const tok = requireInternal({ token: 's3cret-token' });
  assert.equal(run(tok, '127.0.0.1'), 403, 'token configured → loopback alone is not enough');
  assert.equal(run(tok, '10.1.1.1', { 'x-internal-token': 'wrong' }), 403);
  assert.equal(run(tok, '10.1.1.1', { 'x-internal-token': 's3cret-token' }), 200);
  assert.equal(safeEqual('a', 'a'), true);
  assert.equal(safeEqual('a', 'ab'), false);
});
