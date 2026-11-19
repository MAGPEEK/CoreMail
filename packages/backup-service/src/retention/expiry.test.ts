/**
 * Unit tests for the retention expiry decision.
 * Run: corepack pnpm --filter @coremail/backup-service test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RESTORE_RETENTION_GRACE_DAYS, retentionDecision } from './expiry.js';

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

describe('retentionDecision — restored messages (9.5)', () => {
  const deliveredLongAgo = new Date('2020-01-01T00:00:00Z');

  test('a restored message with an old delivery date is not expired right after the restore', () => {
    const restoredAt = new Date(now.getTime() - 1 * DAY);
    const decision = retentionDecision(deliveredLongAgo, tag30, now, restoredAt);
    assert.equal(decision.expired, false);
    assert.deepEqual(decision.expiresAt, new Date(restoredAt.getTime() + RESTORE_RETENTION_GRACE_DAYS * DAY));
  });

  test('the policy applies again once the grace period is over', () => {
    const restoredAt = new Date(now.getTime() - RESTORE_RETENTION_GRACE_DAYS * DAY);
    assert.equal(retentionDecision(deliveredLongAgo, tag30, now, restoredAt).expired, true);
  });

  test('a recent delivery keeps its own, later expiry', () => {
    const deliveredAt = new Date(now.getTime() - 5 * DAY);
    const restoredAt = new Date(now.getTime() - 20 * DAY);
    const tag365 = { enabled: true, retentionDays: 365 };
    assert.deepEqual(retentionDecision(deliveredAt, tag365, now, restoredAt).expiresAt, new Date(deliveredAt.getTime() + 365 * DAY));
  });

  test('no / invalid restore time = the plain delivery rule', () => {
    assert.equal(retentionDecision(deliveredLongAgo, tag30, now, null).expired, true);
    assert.equal(retentionDecision(deliveredLongAgo, tag30, now, new Date('invalid')).expired, true);
  });
});
