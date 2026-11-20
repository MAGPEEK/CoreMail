/**
 * 10.5: the primary domain decides the public host name — the setup wizard's
 * local placeholder (mail.example.local) is replaced once a public domain
 * becomes primary; an explicitly configured public host name is kept.
 * Run: node --import tsx --test --test-force-exit src/lib/server-urls.test.ts
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakePrisma, setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();

type Row = Record<string, unknown>;
let settings: Row = {};
const published: Array<[string, string]> = [];

installFakePrisma({
  serverSettings: {
    findUnique: () => ({ ...settings }),
    update: (a) => { settings = { ...settings, ...(a as { data: Row }).data }; return settings; },
  },
});
(globalThis as Record<string, unknown>)['__serverUrlsRedis'] = {
  publish: async (ch: string, msg: string) => { published.push([ch, msg]); return 1; },
};

const { primaryDomainHostname, syncFromPrimaryDomain, deriveServerUrls } = await import('./server-urls.js');

beforeEach(() => { published.length = 0; });

test('primaryDomainHostname: default and local placeholders are replaced, configured public names kept', () => {
  assert.equal(primaryDomainHostname(null, 'firma.de'), 'mail.firma.de');
  assert.equal(primaryDomainHostname('', 'firma.de'), 'mail.firma.de');
  assert.equal(primaryDomainHostname('mail.local', 'firma.de'), 'mail.firma.de');
  assert.equal(primaryDomainHostname('mail.example.local', 'firma.de'), 'mail.firma.de');
  assert.equal(primaryDomainHostname('MAIL.box.LAN', 'Firma.DE'), 'mail.firma.de');
  assert.equal(primaryDomainHostname('192.168.1.5', 'firma.de'), 'mail.firma.de');
  assert.equal(primaryDomainHostname('mx1.firma.de', 'other.de'), null, 'explicit public host name kept');
  assert.equal(primaryDomainHostname('mail.example.local', 'other.lan'), null, 'local → local keeps the admin choice');
  assert.equal(primaryDomainHostname('mx1.firma.de', 'other.de', true), 'mail.other.de', 'force');
  assert.equal(primaryDomainHostname('mail.firma.de', 'firma.de', true), null, 'already right');
});

test('make-primary of a public domain replaces mail.example.local, re-derives the URLs and re-opens the card', async () => {
  const dismissed = new Date();
  settings = {
    id: 'singleton', publicHostname: 'mail.example.local', useHttps: true, httpPort: 443,
    ...deriveServerUrls('mail.example.local', true, 443), setupCertificateHintDismissedAt: dismissed,
  };
  await syncFromPrimaryDomain('firma.de');
  assert.equal(settings['publicHostname'], 'mail.firma.de');
  assert.equal(settings['imapHost'], 'mail.firma.de');
  assert.equal(settings['owaUrl'], 'https://mail.firma.de/owa/');
  assert.equal(settings['autodiscoverBase'], 'https://autodiscover.firma.de');
  assert.equal(settings['setupCertificateHintDismissedAt'], null, '"Später" of the local hint no longer hides the card');
  assert.deepEqual(published.map(([, m]) => JSON.parse(m)), [{ type: 'hostname' }]);
});

test('an explicitly configured public host name stays; dismissal stays', async () => {
  const dismissed = new Date();
  settings = {
    id: 'singleton', publicHostname: 'mx1.firma.de', useHttps: true, httpPort: 443,
    ...deriveServerUrls('mx1.firma.de', true, 443), setupCertificateHintDismissedAt: dismissed,
  };
  await syncFromPrimaryDomain('other.de');
  assert.equal(settings['publicHostname'], 'mx1.firma.de');
  assert.equal(settings['setupCertificateHintDismissedAt'], dismissed);
  assert.equal(published.length, 0, 'URLs already right — nothing to publish');
});
