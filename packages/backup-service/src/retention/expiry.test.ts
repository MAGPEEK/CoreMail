/**
 * Unit tests for the retention expiry decision.
 * Run: corepack pnpm --filter @coremail/backup-service test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { retentionDecision } from './expiry.js';

const DAY = 86_400_000;
const now = new Date('2026-11-14T12:00:00Z');
const tag30 = { enabled: true, retentionDays: 30 };

describe('retentionDecision', () => {
  test('an old Date header with a recent delivery is not expired', () => {
    // The caller passes the delivery time; the forged Date header (1999) plays no role.
    const forgedHeaderDate = new Date('1999-01-01T00:00:00Z');
    const deliveredAt = new Date(now.getTime() - 1 * DAY);

    const decision = retentionDecision(deliveredAt, tag30, now);

    assert.equal(decision.expired, false);
    assert.ok(forgedHeaderDate < deliveredAt);
    assert.deepEqual(decision.expiresAt, new Date(deliveredAt.getTime() + 30 * DAY));
  });

  test('a delivery older than the retention period is expired', () => {
    const deliveredAt = new Date(now.getTime() - 31 * DAY);

    const decision = retentionDecision(deliveredAt, tag30, now);

    assert.equal(decision.expired, true);
    assert.deepEqual(decision.expiresAt, new Date(deliveredAt.getTime() + 30 * DAY));
  });

  test('expiry is reached exactly at delivery + retentionDays', () => {
    const deliveredAt = new Date(now.getTime() - 30 * DAY);

    assert.equal(retentionDecision(deliveredAt, tag30, now).expired, true);
    assert.equal(retentionDecision(new Date(deliveredAt.getTime() + 1), tag30, now).expired, false);
  });

  test('a disabled tag never expires anything', () => {
    const deliveredAt = new Date('2000-01-01T00:00:00Z');

    const decision = retentionDecision(deliveredAt, { enabled: false, retentionDays: 1 }, now);

    assert.deepEqual(decision, { expired: false, expiresAt: null });
  });

  test('no effective tag never expires anything', () => {
    assert.deepEqual(retentionDecision(new Date('2000-01-01T00:00:00Z'), null, now), { expired: false, expiresAt: null });
  });

  test('a non-positive retention period never expires anything', () => {
    const deliveredAt = new Date('2000-01-01T00:00:00Z');

    assert.equal(retentionDecision(deliveredAt, { enabled: true, retentionDays: 0 }, now).expired, false);
    assert.equal(retentionDecision(deliveredAt, { enabled: true, retentionDays: -5 }, now).expired, false);
  });

  test('an invalid delivery date never expires anything', () => {
    assert.equal(retentionDecision(new Date('invalid'), tag30, now).expired, false);
  });
});
