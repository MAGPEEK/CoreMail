/**
 * 10.5 BCP send limit form: view → form → PUT body.
 * Run: node --test src/lib/sendRate.test.ts  (in packages/admin-panel)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendRateForm, sendRatePayload } from './sendRate.ts';

const view = { enabled: true, messagesPerHour: 200, recipientsPerHour: 1000, blockOnExceed: false };

test('view → form → body round trip', () => {
  const f = sendRateForm(view);
  assert.equal(f.messagesPerHour, '200');
  assert.deepEqual(sendRatePayload(f), { ok: true, value: view });
  assert.deepEqual(sendRatePayload({ ...f, messagesPerHour: ' 50 ', blockOnExceed: true }), { ok: true, value: { ...view, messagesPerHour: 50, blockOnExceed: true } });
});

test('invalid limits name their field (0, fractions, text, above the bound)', () => {
  const f = sendRateForm(view);
  for (const bad of ['0', '', '2.5', 'abc', '100001']) {
    assert.deepEqual(sendRatePayload({ ...f, messagesPerHour: bad }), { ok: false, field: 'messagesPerHour' }, bad);
  }
  assert.deepEqual(sendRatePayload({ ...f, recipientsPerHour: '1000001' }), { ok: false, field: 'recipientsPerHour' });
});
