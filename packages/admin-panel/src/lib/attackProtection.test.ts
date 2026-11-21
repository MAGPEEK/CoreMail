import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_REFRESH_MS, EXPIRY_CHOICES, eventsView, formatRemaining, lastRefreshedAt, looksLikeCidr, protocolLabel, totalEvents } from './attackProtection.ts';

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

test('10.6: last refresh = the newest successful fetch of the page queries', () => {
  assert.equal(lastRefreshedAt([]), null);
  assert.equal(lastRefreshedAt([0, undefined, 0]), null);
  assert.equal(lastRefreshedAt([1000, 5000, 0, 3000]), 5000);
  assert.equal(lastRefreshedAt([Number.NaN, 42]), 42);
  assert.equal(AUTO_REFRESH_MS, 30_000);
});

test('10.6: events section — error, loading, empty state, list (an error is never "no attacks")', () => {
  assert.equal(eventsView(undefined, true), 'error');
  assert.equal(eventsView(undefined, false), 'loading');
  assert.equal(eventsView({ byProtocol: [], total24h: 0 }, false), 'empty');
  assert.equal(eventsView({ byProtocol: [] }, false), 'empty');
  assert.equal(eventsView({ byProtocol: [{ protocol: 'imap', count: 3 }], total24h: 3 }, false), 'list');
  assert.equal(eventsView({ byProtocol: [{ protocol: 'imap', count: 3 }] }, false), 'list');
  // a failed refresh keeps showing the last data
  assert.equal(eventsView({ byProtocol: [{ protocol: 'web', count: 1 }], total24h: 1 }, true), 'list');
});
