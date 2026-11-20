import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXPIRY_CHOICES, formatRemaining, looksLikeCidr, protocolLabel, totalEvents } from './attackProtection.ts';

test('protocolLabel: known protocols and fallbacks', () => {
  assert.equal(protocolLabel('imap'), 'IMAP');
  assert.equal(protocolLabel('web'), 'Webmail/API');
  assert.equal(protocolLabel('caldav'), 'CalDAV/CardDAV');
  assert.equal(protocolLabel('activesync'), 'ActiveSync');
  assert.equal(protocolLabel('xyz'), 'XYZ');
  assert.equal(protocolLabel(null), '—');
});

test('formatRemaining: seconds, minutes, hours, days', () => {
  assert.equal(formatRemaining(45), '45 s');
  assert.equal(formatRemaining(720), '12 min');
  assert.equal(formatRemaining(3600), '1 h');
  assert.equal(formatRemaining(3900), '1 h 5 min');
  assert.equal(formatRemaining(2 * 86_400 + 3 * 3600), '2 d 3 h');
  assert.equal(formatRemaining(-5), '0 s');
});

test('looksLikeCidr: IPv4/IPv6 with optional prefix', () => {
  for (const ok of ['203.0.113.7', '203.0.113.0/24', '2001:db8::1', '2001:db8::/32', '::1', '::ffff:1.2.3.4']) assert.equal(looksLikeCidr(ok), true, ok);
  for (const bad of ['', 'x', '1.2.3', '256.1.1.1', '1.2.3.4/33', '1.2.3.4/a', '2001:db8::/129', '1::2::3', '1.2.3.4/8/8', '1.2.3.4 /8']) {
    assert.equal(looksLikeCidr(bad), false, bad);
  }
});

test('expiry choices start with permanent; totals', () => {
  assert.equal(EXPIRY_CHOICES[0], null);
  assert.equal(totalEvents([{ protocol: 'imap', count: 2 }, { protocol: 'smtp', count: 3 }]), 5);
  assert.equal(totalEvents(undefined), 0);
});
