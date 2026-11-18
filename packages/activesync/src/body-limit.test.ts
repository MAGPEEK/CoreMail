/**
 * 9.4: the ActiveSync request-body cap follows the configured maximum message size
 * (+ protocol margin, upper bound) and applies a settings change at once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request, Response, NextFunction } from 'express';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';

let smtpMb = 10;
(globalThis as unknown as { __prisma: unknown }).__prisma = {
  $on: () => undefined,
  smtpSettings: { findUnique: async () => ({ maxMessageSizeMb: smtpMb }) },
  serverSettings: { findUnique: async () => ({ maxMessageSizeMb: 500 }) },
};

const { default: express } = await import('express');
const { easBodyLimit, easBodyParser, currentEasBodyLimit, EAS_MAX_BODY_BYTES, EAS_BODY_OVERHEAD_BYTES } = await import('./body-limit.js');
const { clearMessageSizeLimitCache } = await import('@coremail/storage');
const MB = 1024 * 1024;

test('cap = max message size × 4/3 + 1 MB, at most 150 MB', () => {
  assert.equal(easBodyLimit(25 * MB), Math.ceil((25 * MB * 4) / 3) + EAS_BODY_OVERHEAD_BYTES);
  assert.ok(easBodyLimit(25 * MB) > 25 * MB, 'a message at the limit always fits');
  assert.equal(easBodyLimit(1 * MB), Math.ceil((4 * MB) / 3) + MB);
  assert.equal(easBodyLimit(500 * MB), EAS_MAX_BODY_BYTES, 'upper bound');
});

test('the cap follows the configured size; a settings reload applies it at once', async () => {
  clearMessageSizeLimitCache();
  smtpMb = 10;
  assert.equal(await currentEasBodyLimit(), easBodyLimit(10 * MB), 'stricter of SMTP (10) and server (500)');
  smtpMb = 40;
  assert.equal(await currentEasBodyLimit(), easBodyLimit(10 * MB), 'cached until the reload');
  clearMessageSizeLimitCache(); // what the CHANNEL_SETTINGS_RELOAD subscriber does
  assert.equal(await currentEasBodyLimit(), easBodyLimit(40 * MB));
});

async function withServer(limit: () => Promise<number>, run: (url: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(easBodyParser(limit));
  app.post('/', (req, res) => { res.json({ size: Buffer.isBuffer(req.body) ? req.body.length : -1 }); });
  app.use((err: { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.status ?? 500).end();
  });
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const post = (url: string, size: number) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/vnd.ms-sync.wbxml' }, body: Buffer.alloc(size, 0x61),
});

test('parser: body up to the cap is read, above it 413; a changed cap is used for the next request', async () => {
  let cap = 1000;
  await withServer(async () => cap, async (url) => {
    const ok = await post(url, 1000);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { size: 1000 });
    assert.equal((await post(url, 1001)).status, 413);
    cap = 5000;
    assert.equal((await post(url, 1001)).status, 200, 'new limit without restart');
    assert.equal((await post(url, 5001)).status, 413);
  });
});

test('parser: an unreadable limit ends in the error middleware', async () => {
  await withServer(async () => { throw Object.assign(new Error('db down'), { status: 503 }); }, async (url) => {
    assert.equal((await post(url, 10)).status, 503);
  });
});
