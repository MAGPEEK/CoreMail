/**
 * 10.5: local / private host names (setup wizard "local domain first") and the
 * parity of the three copies (api-gateway, web-client, admin-panel).
 * Run: node --import tsx --test src/lib/local-hostname.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isLocalHostname, LOCAL_HOSTNAME_SUFFIXES } from './local-hostname.js';

test('private suffixes, single labels and bare IP addresses are local', () => {
  for (const h of [
    'example.local', 'mail.example.local', 'MAIL.Example.LOCAL.', 'box.lan', 'mx.corp.internal', 'mail.home.arpa',
    'mail.example.test', 'server.localdomain', 'mail.localhost', 'localhost', 'intranet', 'mail.local',
    '192.168.1.10', '10.0.0.1:8443', '::1', '[fe80::1]', '[2001:db8::5]:443', 'https://mail.example.local/owa/',
  ]) {
    assert.equal(isLocalHostname(h), true, h);
  }
});

test('public names are not local; empty is not local', () => {
  for (const h of [
    'example.com', 'mail.example.de', 'mail.firma.co.uk', 'local.example.com', 'mail.localhost.example.org',
    'mytest.de', 'lan.example.net', 'mail.example.de:8443', 'https://mail.example.com/',
  ]) {
    assert.equal(isLocalHostname(h), false, h);
  }
  for (const h of ['', '   ', null, undefined]) assert.equal(isLocalHostname(h), false, String(h));
});

test('the suffix list is the one the wizard and the BCP name', () => {
  assert.deepEqual([...LOCAL_HOSTNAME_SUFFIXES], ['local', 'lan', 'internal', 'home.arpa', 'test', 'localdomain', 'localhost']);
});

test('the web-client and admin-panel copies are identical to this module', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
  const own = read('./local-hostname.ts');
  assert.equal(read('../../../web-client/src/lib/localHostname.ts'), own, 'web-client copy differs');
  assert.equal(read('../../../admin-panel/src/lib/localHostname.ts'), own, 'admin-panel copy differs');
});
