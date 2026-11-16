import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quotaPercent, quotaColor, fmtQuotaBytes } from './quota.ts';

test('quotaPercent: share of the prohibit-send-receive quota, capped, 0 when unlimited', () => {
  assert.equal(quotaPercent({ usedBytes: 50, prohibitSendReceiveBytes: 200 }), 25);
  assert.equal(quotaPercent({ usedBytes: 500, prohibitSendReceiveBytes: 200 }), 100);
  assert.equal(quotaPercent({ usedBytes: 500, prohibitSendReceiveBytes: 0 }), 0);
});

test('quotaColor: amber at the warning level, red once sending is blocked', () => {
  assert.equal(quotaColor('ok').bar, 'bg-accent');
  assert.equal(quotaColor('warning').bar, 'bg-warning');
  assert.equal(quotaColor('prohibitSend').bar, 'bg-danger');
  assert.equal(quotaColor('prohibitSendReceive').bar, 'bg-danger');
  assert.equal(quotaColor('warning').text, 'text-warning-fg');
});

test('fmtQuotaBytes', () => {
  assert.equal(fmtQuotaBytes(2.5 * 1024 ** 3), '2.5 GB');
  assert.equal(fmtQuotaBytes(300 * 1024 ** 2), '300 MB');
  assert.equal(fmtQuotaBytes(10), '10 B');
});
