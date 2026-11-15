/**
 * 8.0.x OWASP wave — library-level regression tests:
 * CSV formula neutralisation + keyed export signature, folder re-parenting,
 * recipient validation, per-user rate limiter, request size cap (multer),
 * In-Reply-To resolution, proxy header rewriting, HTTP→HTTPS redirect + HSTS,
 * SSE tickets, image proxy (SSRF / type / size / redirects), audited GETs.
 * Run: node --import tsx --test --test-force-exit src/lib/owasp-hardening.test.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { installFakePrisma, setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();
installFakePrisma();

const express = (await import('express')).default;
const multer = (await import('multer')).default;
const { csvCell, csvCellQuoted, exportSignature, verifyExportSignature } = await import('./export-safety.js');
const { checkFolderParent } = await import('./folder-tree.js');
const { checkRecipients, recipientAddress, withBodyLimit } = await import('./send-limits.js');
const { createUserRateLimiter } = await import('./user-rate-limit.js');
const { resolveReplyHeaders, rawHeader } = await import('./reply-headers.js');
const { applyUpstreamHeaders, isUntrustedForwardingHeader } = await import('./proxy-headers.js');
const { createHttpsRedirect, hstsOnHttps, httpRedirectEnabled } = await import('./https-redirect.js');
const { issueEventTicket, redeemEventTicket } = await import('./event-tickets.js');
const { fetchProxiedImage, checkImageUrl, ImageProxyError } = await import('./image-proxy.js');
const { AUDIT_SENSITIVE_GET } = await import('./audit.js');

const servers: http.Server[] = [];
after(() => { for (const s of servers) s.close(); });
async function listen(handler: http.RequestListener): Promise<string> {
  const s = http.createServer(handler as http.RequestListener);
  s.listen(0, '127.0.0.1');
  servers.push(s);
  await new Promise((r) => s.once('listening', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

// ── #8 CSV + signature ────────────────────────────────────────────────────────

test('csvCell neutralises formula prefixes (= + - @ TAB CR) and quotes', () => {
  assert.equal(csvCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
  assert.equal(csvCell('+1'), `'+1`);
  assert.equal(csvCell('-2'), `'-2`);
  assert.equal(csvCell('@SUM(A1)'), `'@SUM(A1)`);
  assert.equal(csvCell('\tcmd'), `'\tcmd`);
  assert.equal(csvCell('\rcmd'), `"'\rcmd"`);
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCellQuoted('=1+1'), `"'=1+1"`);
  assert.equal(csvCellQuoted('x@y.z'), '"x@y.z"');
});

test('export signature is HMAC-SHA256 keyed by JWT_SECRET+PEPPER', () => {
  const sig = exportSignature('payload');
  assert.match(sig, /^hmac-sha256=[0-9a-f]{64}$/);
  assert.ok(verifyExportSignature('payload', sig));
  assert.ok(!verifyExportSignature('payload!', sig));
  const other = exportSignature('payload', { JWT_SECRET: 'another-secret-another-secret-12345', PEPPER: 'p'.repeat(32) });
  assert.notEqual(other, sig, 'a different server key gives a different signature');
  // not the unkeyed sha256 of the payload
  assert.ok(!sig.endsWith('239f59ed55e737c77147cf55ad0c1b030b6d7ee748a7426952f9b852d5a935e5'));
});

// ── #4 folder parent ──────────────────────────────────────────────────────────

test('checkFolderParent: same mailbox only, no cycles', async () => {
  const folders: Record<string, { parentId: string | null; mailboxId: string }> = {
    a: { parentId: null, mailboxId: 'mb1' },
    b: { parentId: 'a', mailboxId: 'mb1' },
    c: { parentId: 'b', mailboxId: 'mb1' },
    foreign: { parentId: null, mailboxId: 'mb2' },
  };
  const db = { folder: { findUnique: async (q: { where: { id: string } }) => folders[q.where.id] ?? null } };
  assert.deepEqual(await checkFolderParent(db, 'c', 'a', 'mb1'), { ok: true });
  assert.equal((await checkFolderParent(db, 'a', 'a', 'mb1')).ok, false);
  const cyc = await checkFolderParent(db, 'a', 'c', 'mb1');
  assert.equal(cyc.ok, false);
  assert.equal(!cyc.ok && cyc.status, 400);
  const foreign = await checkFolderParent(db, 'c', 'foreign', 'mb1');
  assert.equal(!foreign.ok && foreign.status, 404, 'a parent in another mailbox is "not found"');
  const missing = await checkFolderParent(db, 'c', 'nope', 'mb1');
  assert.equal(!missing.ok && missing.status, 404);
});

// ── #3 recipients / size / rate ───────────────────────────────────────────────

test('recipient validation: syntax, CR/LF, max. count', () => {
  assert.equal(recipientAddress('a@ex.com'), 'a@ex.com');
  assert.equal(recipientAddress('Ann Example <ann@ex.com>'), 'ann@ex.com');
  assert.equal(recipientAddress('müller@bücher.de'), 'müller@bücher.de');
  assert.equal(recipientAddress('no-at-sign'), null);
  assert.equal(recipientAddress('a@ex.com\r\nBcc: victim@x.com'), null);
  assert.equal(recipientAddress('a@localhost'), null);
  assert.equal(recipientAddress('a b@ex.com'), null);
  assert.deepEqual(checkRecipients([['a@ex.com'], [], ['b@ex.com']]), { ok: true });
  const many = Array.from({ length: 501 }, (_, i) => `u${i}@ex.com`);
  assert.equal(checkRecipients([many]).ok, false);
  assert.equal(checkRecipients([many.slice(0, 250)], 500).ok, true);
  const bad = checkRecipients([['ok@ex.com', 'bad']]);
  assert.equal(bad.ok, false);
  assert.deepEqual(!bad.ok && bad.invalid, ['bad']);
});

test('per-user rate limiter: Redis counter, window, in-process fallback', async () => {
  const kv = new Map<string, number>();
  let t = 1_000_000;
  const store = { incr: async (k: string) => { const n = (kv.get(k) ?? 0) + 1; kv.set(k, n); return n; }, expire: async () => 1 };
  const rl = createUserRateLimiter({ scope: 's', limit: 2, windowSec: 60, store: () => store, now: () => t });
  assert.equal((await rl.hit('u1')).allowed, true);
  assert.equal((await rl.hit('u1')).allowed, true);
  const third = await rl.hit('u1');
  assert.equal(third.allowed, false);
  assert.ok(third.retryAfterSec >= 1 && third.retryAfterSec <= 60);
  assert.equal((await rl.hit('u2')).allowed, true, 'per user');
  t += 60_000;
  assert.equal((await rl.hit('u1')).allowed, true, 'new window');

  const broken = { incr: async () => { throw new Error('down'); }, expire: async () => 1 };
  const fb = createUserRateLimiter({ scope: 'f', limit: 1, windowSec: 60, store: () => broken });
  assert.equal((await fb.hit('u')).allowed, true);
  assert.equal((await fb.hit('u')).allowed, false, 'fallback still limits');
  const off = createUserRateLimiter({ scope: 'o', limit: 0, windowSec: 60, store: () => broken });
  assert.equal((await off.hit('u')).allowed, true);
});

test('multipart send body is capped at the max. message size (declared and streamed)', async () => {
  const app = express();
  app.post('/send', withBodyLimit((limit) => multer({ storage: multer.memoryStorage(), limits: { fileSize: limit, files: 2 } })
    .array('attachments', 2), async () => 1024), (req, res) => {
    res.json({ files: (req.files as unknown[] | undefined)?.length ?? 0 });
  });
  const base = await listen(app);
  const form = (size: number) => {
    const fd = new FormData();
    fd.append('to', 'a@ex.com');
    fd.append('attachments', new Blob([Buffer.alloc(size, 65)]), 'a.bin');
    return fd;
  };
  const ok = await fetch(`${base}/send`, { method: 'POST', body: form(100) });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { files: 1 });
  const big = await fetch(`${base}/send`, { method: 'POST', body: form(5000) });
  assert.equal(big.status, 413, 'Content-Length over the limit');

  // chunked upload without Content-Length: counted while streaming
  const status = await new Promise<number>((resolve, reject) => {
    const u = new URL(`${base}/send`);
    const boundary = 'XBOUNDARY';
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'transfer-encoding': 'chunked' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.write(`--${boundary}\r\nContent-Disposition: form-data; name="attachments"; filename="x.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    for (let i = 0; i < 4; i++) req.write(Buffer.alloc(600, 66));
    req.end(`\r\n--${boundary}--\r\n`);
  });
  assert.equal(status, 413);
});

// ── #9 In-Reply-To ────────────────────────────────────────────────────────────

test('In-Reply-To: internal ids are resolved to the parent Message-ID, never emitted', async () => {
  const raw = Buffer.from('Message-ID: <p@ex.com>\r\nReferences: <r1@ex.com>\r\n <r2@ex.com>\r\nSubject: x\r\n\r\nbody\r\nReferences: <fake@x>');
  assert.equal(rawHeader(raw, 'References'), '<r1@ex.com> <r2@ex.com>');
  const seen: Array<[string, string]> = [];
  const lookup = {
    findParent: async (id: string, userId: string) => {
      seen.push([id, userId]);
      return id === 'cmparent0000000000000000x' ? { id, messageId: '<p@ex.com>', inReplyTo: '<r2@ex.com>', storagePath: 'raw/1' } : null;
    },
    loadRaw: async () => raw,
  };
  assert.deepEqual(await resolveReplyHeaders('cmparent0000000000000000x', 'u1', lookup),
    { inReplyTo: '<p@ex.com>', references: '<r1@ex.com> <r2@ex.com> <p@ex.com>' });
  assert.deepEqual(seen, [['cmparent0000000000000000x', 'u1']], 'lookup is scoped to the caller');
  assert.deepEqual(await resolveReplyHeaders('cmunknown000000000000000x', 'u1', lookup), {}, 'unknown id → no header');
  assert.deepEqual(await resolveReplyHeaders('abc@ex.com', 'u1', lookup), { inReplyTo: '<abc@ex.com>', references: '<abc@ex.com>' });
  assert.deepEqual(await resolveReplyHeaders('<a@b>\r\nBcc: x@y', 'u1', lookup), {});
  // without raw: References from the parent's In-Reply-To
  const noRaw = { findParent: lookup.findParent };
  assert.deepEqual(await resolveReplyHeaders('cmparent0000000000000000x', 'u1', noRaw),
    { inReplyTo: '<p@ex.com>', references: '<r2@ex.com> <p@ex.com>' });
});

// ── #6 proxy headers ──────────────────────────────────────────────────────────

test('proxied requests: client forwarding / internal identity headers are replaced', async () => {
  const seen: http.IncomingHttpHeaders[] = [];
  const upstream = await listen((req, res) => { seen.push(req.headers); res.end('ok'); });
  const app = express();
  const noTrust = () => false;
  app.use((req, res) => {
    const u = new URL(upstream);
    const proxyReq = http.request({ host: u.hostname, port: u.port, path: '/', method: 'GET', headers: { ...req.headers } }, (r) => { r.resume(); res.end(); });
    applyUpstreamHeaders(proxyReq, req, noTrust);
    proxyReq.end();
  });
  const base = await listen(app);
  await fetch(`${base}/x`, { headers: {
    'X-Forwarded-For': '10.9.9.9', 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Port': '1',
    Forwarded: 'for=1.2.3.4;host=evil', 'X-Real-IP': '1.2.3.4', 'X-Internal-Token': 'guess', 'X-User-Id': 'admin', 'X-Accept': 'kept',
  } });
  const h = seen[0]!;
  assert.match(String(h['x-forwarded-for']), /127\.0\.0\.1$/);
  assert.equal(h['x-forwarded-proto'], 'http');
  assert.match(String(h['x-forwarded-host']), /^127\.0\.0\.1:\d+$/);
  for (const k of ['x-forwarded-port', 'forwarded', 'x-real-ip', 'x-internal-token', 'x-user-id']) assert.equal(h[k], undefined, k);
  assert.equal(h['x-accept'], 'kept');
  assert.equal(isUntrustedForwardingHeader('X-CoreMail-Signature'), true);
  assert.equal(isUntrustedForwardingHeader('Authorization'), false);
});

// ── #7 HTTPS redirect + HSTS ──────────────────────────────────────────────────

test('HTTP→HTTPS redirect: active cert only, exemptions, no open redirect; HSTS on HTTPS only', async () => {
  let active = true;
  const app = express();
  app.use(hstsOnHttps);
  app.use(createHttpsRedirect({
    enabled: true,
    state: () => ({ active, port: 443, covers: (h) => h === 'mail.ex.com' || h === 'autodiscover.ex.com' }),
    publicHostname: async () => 'mail.ex.com',
  }));
  app.get('*', (_req, res) => { res.send('plain'); });
  const base = await listen(app);
  // the test client is loopback → exempt; simulate a remote peer via a socket override
  const fetchAs = async (path: string, host?: string) => {
    const req = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const u = new URL(base);
      const r = http.request({ host: u.hostname, port: u.port, path, headers: { ...(host ? { host } : {}), 'x-test-remote': '1' } }, resolve);
      r.on('error', reject); r.end();
    });
    req.resume();
    return { status: req.statusCode, location: req.headers['location'], hsts: req.headers['strict-transport-security'] };
  };
  // loopback peers are never redirected
  const loop = await fetchAs('/inbox');
  assert.equal(loop.status, 200);
  assert.equal(loop.hsts, undefined, 'no HSTS over plain HTTP');

  // remote peer: wrap the middleware with a fake remote address
  const remoteApp = express();
  remoteApp.use((req, _res, next) => { Object.defineProperty(req, 'socket', { value: { remoteAddress: '203.0.113.5' } }); next(); });
  remoteApp.use(createHttpsRedirect({
    enabled: true,
    state: () => ({ active, port: 443, covers: (h) => h === 'mail.ex.com' || h === 'autodiscover.ex.com' }),
    publicHostname: async () => 'mail.ex.com',
  }));
  remoteApp.get('*', (_req, res) => { res.send('plain'); });
  const rbase = await listen(remoteApp);
  const get = async (path: string, host: string) => new Promise<{ status: number | undefined; location: string | undefined }>((resolve, reject) => {
    const u = new URL(rbase);
    const r = http.request({ host: u.hostname, port: u.port, path, headers: { host } }, (res) => { res.resume(); resolve({ status: res.statusCode, location: res.headers['location'] }); });
    r.on('error', reject); r.end();
  });
  assert.deepEqual(await get('/inbox?a=1', 'autodiscover.ex.com'), { status: 308, location: 'https://autodiscover.ex.com/inbox?a=1' });
  assert.deepEqual(await get('/x', 'evil.example'), { status: 308, location: 'https://mail.ex.com/x' }, 'unknown host → publicHostname');
  assert.equal((await get('/.well-known/acme-challenge/tok', 'mail.ex.com')).status, 200);
  assert.equal((await get('/healthz', 'mail.ex.com')).status, 200);
  assert.equal((await get('/livez', 'mail.ex.com')).status, 200);
  active = false;
  assert.equal((await get('/inbox', 'mail.ex.com')).status, 200, 'no active HTTPS cert → no redirect');

  assert.equal(httpRedirectEnabled({}), true);
  assert.equal(httpRedirectEnabled({ HTTP_REDIRECT_HTTPS: 'false' }), false);

  // HSTS on a secure request
  const headers: Record<string, string> = {};
  hstsOnHttps({ secure: true } as never, { setHeader: (k: string, v: string) => { headers[k] = v; } } as never, () => undefined);
  assert.match(headers['Strict-Transport-Security'] ?? '', /max-age=31536000/);
});

// ── #5 SSE tickets ────────────────────────────────────────────────────────────

test('SSE tickets: single use, opaque, bound to the issuing session', async () => {
  const kv = new Map<string, string>();
  (globalThis as Record<string, unknown>)['__ticketRedis'] = {
    setex: async (k: string, _s: number, v: string) => { kv.set(k, v); return 'OK'; },
    get: async (k: string) => kv.get(k) ?? null,
    del: async (k: string) => (kv.delete(k) ? 1 : 0),
  };
  const { ticket, expiresIn } = await issueEventTicket({ userId: 'u1', email: 'u@ex.com', role: 'USER', sessionId: 's1', mfaVerified: false, issuedAt: 10, issuedAtMs: 10_000 });
  assert.equal(expiresIn, 60);
  assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(![...kv.keys()].some((k) => k.includes(ticket)), 'only the hash is stored');
  const claims = await redeemEventTicket(ticket);
  assert.deepEqual(claims, { sub: 'u1', role: 'USER', email: 'u@ex.com', sessionId: 's1', mfaVerified: false, iat: 10, iatMs: 10_000 });
  assert.equal(await redeemEventTicket(ticket), null, 'second redemption fails');
  assert.equal(await redeemEventTicket('x'.repeat(43)), null);
  assert.equal(await redeemEventTicket('../../etc'), null);
  delete (globalThis as Record<string, unknown>)['__ticketRedis'];
});

// ── #10 image proxy ───────────────────────────────────────────────────────────

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

test('image proxy: SSRF checks on the URL and every redirect hop', async () => {
  assert.throws(() => checkImageUrl('ftp://x.example/a.png'), ImageProxyError);
  assert.throws(() => checkImageUrl('https://user:pw@x.example/a.png'), ImageProxyError);
  assert.throws(() => checkImageUrl('http://127.0.0.1/a.png'), (e: unknown) => (e as InstanceType<typeof ImageProxyError>).status === 403);
  assert.throws(() => checkImageUrl('http://169.254.169.254/latest/meta-data'), ImageProxyError);
  assert.throws(() => checkImageUrl('http://[::ffff:10.0.0.1]/a.png'), ImageProxyError);
  assert.throws(() => checkImageUrl('http://intranet/a.png'), ImageProxyError);
  assert.throws(() => checkImageUrl('http://printer.local/a.png'), ImageProxyError);
  assert.equal(checkImageUrl('https://cdn.example.com/a.png').hostname, 'cdn.example.com');
  // DNS answer pointing to a private address
  await assert.rejects(fetchProxiedImage('https://cdn.example.com/a.png', { resolve: async () => ['10.0.0.5'] }),
    (e: unknown) => (e as InstanceType<typeof ImageProxyError>).status === 403);
});

test('image proxy: image types only, size cap, re-validated redirects', async () => {
  const up = await listen((req, res) => {
    if (req.url === '/a.png') { res.setHeader('Content-Type', 'image/png'); res.setHeader('Set-Cookie', 'x=1'); res.end(PNG); return; }
    if (req.url === '/svg') { res.setHeader('Content-Type', 'image/svg+xml'); res.end('<svg/>'); return; }
    if (req.url === '/html') { res.setHeader('Content-Type', 'text/html'); res.end('<b>'); return; }
    if (req.url === '/big') { res.setHeader('Content-Type', 'image/png'); res.end(Buffer.alloc(2048)); return; }
    if (req.url === '/hop') { res.statusCode = 302; res.setHeader('Location', '/a.png'); res.end(); return; }
    if (req.url === '/meta') { res.statusCode = 302; res.setHeader('Location', 'http://169.254.169.254/latest'); res.end(); return; }
    if (req.url?.startsWith('/loop')) { res.statusCode = 302; res.setHeader('Location', `/loop${Math.random()}`); res.end(); return; }
    if (req.url === '/cookie') { res.setHeader('Content-Type', 'image/png'); res.end(Buffer.from(JSON.stringify(req.headers))); return; }
    res.statusCode = 404; res.end();
  });
  // the test upstream lives on loopback: allow it explicitly, keep the metadata range blocked
  const opts = { isBlocked: (ip: string) => ip.startsWith('169.254.'), maxBytes: 1024 };
  const ok = await fetchProxiedImage(`${up}/a.png`, opts);
  assert.equal(ok.contentType, 'image/png');
  assert.deepEqual(ok.body, PNG);
  await assert.rejects(fetchProxiedImage(`${up}/svg`, opts), (e: unknown) => (e as InstanceType<typeof ImageProxyError>).status === 415);
  await assert.rejects(fetchProxiedImage(`${up}/html`, opts), (e: unknown) => (e as InstanceType<typeof ImageProxyError>).status === 415);
  await assert.rejects(fetchProxiedImage(`${up}/big`, opts), (e: unknown) => (e as InstanceType<typeof ImageProxyError>).status === 413);
  assert.deepEqual((await fetchProxiedImage(`${up}/hop`, opts)).body, PNG);
  await assert.rejects(fetchProxiedImage(`${up}/meta`, opts), (e: unknown) => (e as InstanceType<typeof ImageProxyError>).status === 403);
  await assert.rejects(fetchProxiedImage(`${up}/loop`, opts), /too many redirects/);
  const echoed = JSON.parse((await fetchProxiedImage(`${up}/cookie`, { ...opts, maxBytes: 10_000 })).body.toString()) as Record<string, string>;
  assert.equal(echoed['cookie'], undefined);
  assert.equal(echoed['authorization'], undefined);
});

// ── #2 audited GETs ───────────────────────────────────────────────────────────

test('backup + message-trace downloads are audited GETs', () => {
  const audited = (p: string) => AUDIT_SENSITIVE_GET.some((re) => re.test(p));
  assert.ok(audited('/backups/download/cjob00000000000000000000x'));
  assert.ok(audited('/backups/archive/download'));
  assert.ok(audited('/message-trace/export'));
  assert.ok(audited('/audit-log/export.csv'));
  assert.ok(!audited('/backups/jobs'));
});
