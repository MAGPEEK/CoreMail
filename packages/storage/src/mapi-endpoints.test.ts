/**
 * MAPI endpoint URLs and the trusted-HTTPS rule (Autodiscover mapiHttp block,
 * NSPI GetMailboxUrl / GetAddressBookUrl).
 * Run: node --import tsx --test src/mapi-endpoints.test.ts  (in packages/storage)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';

let cert: Record<string, unknown> | null = null;
let failing = false;
(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  certificate: {
    findFirst: async (a: { where: { isActiveHttps?: boolean } }) => {
      if (failing) throw new Error('db down');
      assert.equal(a.where.isActiveHttps, true);
      return cert;
    },
  },
};
const { mapiEndpointsFor, isTrustedHttpsCertificate, mapiHttpsTrusted } = await import('./mapi-endpoints.js');

test('URLs: the https webmail origin, else https://<public host>; an unconfigured host gives none', () => {
  assert.deepEqual(mapiEndpointsFor({ owaUrl: 'https://mail.example.com:8443/owa/', publicHostname: 'x.example.com' }), {
    mailStore: 'https://mail.example.com:8443/mapi/emsmdb/', addressBook: 'https://mail.example.com:8443/mapi/nspi/',
  });
  assert.equal(mapiEndpointsFor({ owaUrl: 'http://mail.example.com/owa/', publicHostname: 'mail.example.com' })?.mailStore,
    'https://mail.example.com/mapi/emsmdb/', 'plain-http webmail URL → the host name over https');
  assert.equal(mapiEndpointsFor({ owaUrl: 'https://mail.local:8080/owa/', publicHostname: 'mail.local' }), null);
  assert.equal(mapiEndpointsFor({ owaUrl: null, publicHostname: '' }), null);
  assert.equal(mapiEndpointsFor({ owaUrl: 'not a url', publicHostname: 'Mail.Example.COM' })?.addressBook, 'https://mail.example.com/mapi/nspi/');
});

test('trusted certificate: CA-issued (Let\'s Encrypt production, uploaded) and in force', () => {
  assert.equal(isTrustedHttpsCertificate({ type: 'LETSENCRYPT', status: 'ACTIVE', acmeStaging: false }), true);
  assert.equal(isTrustedHttpsCertificate({ type: 'CUSTOM', status: 'EXPIRING', acmeStaging: false }), true);
  assert.equal(isTrustedHttpsCertificate({ type: 'SELF_SIGNED', status: 'ACTIVE', acmeStaging: false }), false);
  assert.equal(isTrustedHttpsCertificate({ type: 'LETSENCRYPT', status: 'ACTIVE', acmeStaging: true }), false);
  for (const status of ['PENDING', 'EXPIRED', 'ERROR', 'RENEWING']) {
    assert.equal(isTrustedHttpsCertificate({ type: 'CUSTOM', status, acmeStaging: false }), false, status);
  }
});

test('mapiHttpsTrusted: the HTTPS certificate, or MAPI_HTTPS_TRUSTED for an external TLS terminator; a database error propagates', async () => {
  cert = null;
  assert.equal(await mapiHttpsTrusted({}), false);
  assert.equal(await mapiHttpsTrusted({ MAPI_HTTPS_TRUSTED: 'true' }), true);
  cert = { type: 'LETSENCRYPT', status: 'ACTIVE', acmeStaging: false };
  assert.equal(await mapiHttpsTrusted({}), true);
  failing = true;
  await assert.rejects(mapiHttpsTrusted({}));
  failing = false;
});
