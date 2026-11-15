/**
 * v8.1 refresh-token cookie helpers (pure): cookie parsing/serialisation, the
 * browser-client switch and the same-origin check used for CSRF defence.
 * Run: node --import tsx --test src/auth/refresh-cookie.test.ts  (in packages/storage)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';

const { createFakePrisma } = await import('./testing.js');
(globalThis as Record<string, unknown>)['__prisma'] = createFakePrisma();
const rc = await import('./refresh-cookie.js');

test('readCookie: picks the named cookie, decodes, ignores look-alikes', () => {
  const h = { cookie: 'x=1; cm_rt_bcp=bcp%2Etoken; cm_rt=a.b.c; other=2' };
  assert.equal(rc.readCookie(h, 'cm_rt'), 'a.b.c');
  assert.equal(rc.readCookie(h, 'cm_rt_bcp'), 'bcp.token');
  assert.equal(rc.readCookie(h, 'missing'), undefined);
  assert.equal(rc.readCookie({}, 'cm_rt'), undefined);
  assert.equal(rc.readRefreshCookie({ headers: { ...h, 'x-coremail-app': 'bcp' } }), 'bcp.token');
  assert.equal(rc.readRefreshCookie({ headers: { cookie: `cm_rt=${'a'.repeat(5000)}` } }), undefined, 'oversized ignored');
});

test('cookie attributes: HttpOnly, SameSite=Strict, Path=/auth; Secure only for https', () => {
  const plain = rc.refreshCookieHeader({ headers: {} }, 'tok', 3600);
  assert.equal(plain, 'cm_rt=tok; Path=/auth; Max-Age=3600; HttpOnly; SameSite=Strict');
  assert.match(rc.refreshCookieHeader({ headers: {}, secure: true }, 'tok', 60), /; Secure$/);
  assert.match(rc.refreshCookieHeader({ headers: { origin: 'https://mail.example.com' } }, 'tok', 60), /; Secure$/);
  const cleared = rc.clearRefreshCookieHeader({ headers: { 'x-coremail-app': 'bcp' } });
  assert.match(cleared, /^cm_rt_bcp=; Path=\/auth; Max-Age=0; Expires=Thu, 01 Jan 1970/);
});

test('tokenPairResponse: browsers get a cookie and no body token; others the full pair', () => {
  const tokens = { accessToken: 'A', refreshToken: 'R', expiresIn: 900 };
  const web = rc.tokenPairResponse({ headers: { 'x-coremail-client': 'web' } }, tokens);
  assert.deepEqual(web.body, { accessToken: 'A', expiresIn: 900 });
  assert.match(web.setCookie!, /^cm_rt=R;/);
  const cli = rc.tokenPairResponse({ headers: {} }, tokens);
  assert.deepEqual(cli.body, tokens);
  assert.equal(cli.setCookie, undefined);
  assert.ok(rc.tokenPairResponse({ headers: {} }, tokens, { viaCookie: true }).setCookie, 'cookie in → cookie out');
});

test('isSameOriginRequest: Origin/Referer must match Host, hostname, extra hosts or COREMAIL_ALLOWED_ORIGINS', () => {
  const req = (h: Record<string, string>, hostname?: string) => ({ headers: { host: 'mail.example.com', ...h }, ...(hostname ? { hostname } : {}) });
  assert.equal(rc.isSameOriginRequest(req({ origin: 'https://mail.example.com' })), true);
  assert.equal(rc.isSameOriginRequest(req({ referer: 'https://mail.example.com/bcp/users' })), true);
  assert.equal(rc.isSameOriginRequest(req({ origin: 'https://evil.example' })), false);
  assert.equal(rc.isSameOriginRequest(req({ origin: 'https://mail.example.com.evil.example' })), false);
  assert.equal(rc.isSameOriginRequest(req({ origin: 'null' })), false);
  assert.equal(rc.isSameOriginRequest(req({})), false, 'no Origin, no Referer');
  assert.equal(rc.isSameOriginRequest(req({ origin: 'javascript:alert(1)' })), false);
  // proxy rewrote Host — trusted X-Forwarded-Host via req.hostname, or the public hostname
  assert.equal(rc.isSameOriginRequest({ headers: { host: 'coremail:3000', origin: 'https://mail.example.com' }, hostname: 'mail.example.com' }), true);
  assert.equal(rc.isSameOriginRequest({ headers: { host: 'coremail:3000', origin: 'https://mail.example.com' } }, ['mail.example.com']), true);
  process.env['COREMAIL_ALLOWED_ORIGINS'] = 'https://webmail.example.net, other.example.org';
  try {
    assert.equal(rc.isSameOriginRequest({ headers: { host: 'x', origin: 'https://webmail.example.net' } }), true);
    assert.equal(rc.isSameOriginRequest({ headers: { host: 'x', origin: 'http://webmail.example.net' } }), false, 'origin entries match scheme');
    assert.equal(rc.isSameOriginRequest({ headers: { host: 'x', origin: 'https://other.example.org' } }), true);
  } finally {
    delete process.env['COREMAIL_ALLOWED_ORIGINS'];
  }
});
