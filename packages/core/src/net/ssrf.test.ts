import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedAddress, normalizeIp, assertPublicHttpsUrl, checkPublicHttpsUrlSyntax, UnsafeUrlError } from './ssrf.js';

test('normalizeIp unwraps IPv4-mapped IPv6', () => {
  assert.equal(normalizeIp('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeIp('::FFFF:7f00:0001'), '127.0.0.1');
  assert.equal(normalizeIp('0:0:0:0:0:ffff:10.1.2.3'), '10.1.2.3');
  assert.equal(normalizeIp('[2001:db8::1]'), '2001:db8::1');
  assert.equal(normalizeIp('fe80::1%eth0'), 'fe80::1');
});

test('isBlockedAddress: private, loopback, link-local, metadata, mapped', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.3.4', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fd00::1', 'fc12::3', '::ffff:192.168.0.1',
    '::ffff:a9fe:a9fe', 'fd00:ec2::254', 'not-an-ip']) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

test('checkPublicHttpsUrlSyntax rejects non-https, credentials, literal private IPs, internal names', () => {
  for (const u of ['http://push.example.com/x', 'https://user:pw@push.example.com/', 'https://127.0.0.1/', 'https://[::1]/',
    'https://169.254.169.254/latest', 'https://localhost/', 'https://metadata.google.internal/', 'https://intranet/', 'ftp://x.example.com', 'nonsense']) {
    assert.throws(() => checkPublicHttpsUrlSyntax(u), UnsafeUrlError, u);
  }
  assert.equal(checkPublicHttpsUrlSyntax('https://fcm.googleapis.com/fcm/send/abc').hostname, 'fcm.googleapis.com');
});

test('assertPublicHttpsUrl checks every resolved address', async () => {
  const resolver = (map: Record<string, string[]>) => async (h: string) => map[h] ?? [];
  await assert.doesNotReject(assertPublicHttpsUrl('https://push.example.com/a', resolver({ 'push.example.com': ['93.184.216.34'] })));
  await assert.rejects(assertPublicHttpsUrl('https://evil.example.com/', resolver({ 'evil.example.com': ['93.184.216.34', '10.0.0.1'] })), UnsafeUrlError);
  await assert.rejects(assertPublicHttpsUrl('https://rebind.example.com/', resolver({ 'rebind.example.com': ['::ffff:127.0.0.1'] })), UnsafeUrlError);
  await assert.rejects(assertPublicHttpsUrl('https://nx.example.com/', resolver({})), UnsafeUrlError);
});
