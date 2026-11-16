import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeDerivedUrls, publicOrigin } from './serverSettings.ts';

test('derive merges only the URL fields — orgName / ports of the form survive', () => {
  const form = {
    publicHostname: 'mail.example.com', useHttps: true, httpPort: 443,
    owaUrl: 'http://mail.local:8080/owa/', easUrl: 'x', autodiscoverBase: 'y',
    jmapEnabled: false, orgName: 'Acme', imapPort: 143,
  };
  const derived = {
    owaUrl: 'https://mail.example.com/owa/', easUrl: 'https://mail.example.com/Microsoft-Server-ActiveSync',
    autodiscoverBase: 'https://autodiscover.example.com', orgName: 'CoreMail', imapPort: 993,
  };
  const next = mergeDerivedUrls(form, derived);
  assert.equal(next.owaUrl, 'https://mail.example.com/owa/');
  assert.equal(next.autodiscoverBase, 'https://autodiscover.example.com');
  assert.equal(next.orgName, 'Acme');
  assert.equal(next.imapPort, 143);
  assert.equal(next.jmapEnabled, false);
  assert.notEqual(next, form, 'new object');
});

test('derive ignores missing / non-string URL fields', () => {
  const form = { owaUrl: 'a', easUrl: 'b', autodiscoverBase: 'c' };
  assert.deepEqual(mergeDerivedUrls(form, { owaUrl: '', easUrl: 5 }), form);
});

test('publicOrigin omits standard ports', () => {
  assert.equal(publicOrigin('mail.example.com', true, 443), 'https://mail.example.com');
  assert.equal(publicOrigin('mail.example.com', false, 80), 'http://mail.example.com');
  assert.equal(publicOrigin('mail.example.com', false, 8080), 'http://mail.example.com:8080');
});
