/**
 * 9.4 BCP mail flow form: view → form → PUT body.
 * Run: node --test src/lib/mailFlow.test.ts  (in packages/admin-panel)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formChanged, formFromView, limitFromInput, listFromText, patchFromForm } from './mailFlow.ts';

const view = {
  hiddenFromGal: false, forwardTo: null, forwardKeepCopy: true, acceptFrom: ['partner.example'], rejectFrom: [],
  maxReceiveSizeMb: null, maxSendSizeMb: 10, maxRecipients: null,
};

test('view → form: lists one per line, limits as text, empty for the global limit', () => {
  const f = formFromView(view);
  assert.equal(f.acceptFrom, 'partner.example');
  assert.equal(f.maxSendSizeMb, '10');
  assert.equal(f.maxReceiveSizeMb, '');
  assert.equal(f.forwardTo, '');
});

test('formChanged is false for the saved values and true after an edit', () => {
  const f = formFromView(view);
  assert.equal(formChanged(view, f), false);
  assert.equal(formChanged(view, { ...f, forwardTo: 'a@x.test' }), true);
  assert.equal(formChanged(view, { ...f, hiddenFromGal: true }), true);
});

test('lists split on lines, commas and semicolons; limits validated', () => {
  assert.deepEqual(listFromText(' a@x.test\n\n b.test, c.test; '), ['a@x.test', 'b.test', 'c.test']);
  assert.equal(limitFromInput(''), null);
  assert.equal(limitFromInput(' 25 '), 25);
  assert.equal(limitFromInput('0'), undefined);
  assert.equal(limitFromInput('2.5'), undefined);
});

test('form → body: user mailboxes carry send limits, shared ones do not; invalid fields are named', () => {
  const user = patchFromForm({ ...formFromView(view), forwardTo: ' boss@partner.example ', maxRecipients: '50' }, 'user');
  assert.deepEqual(user, {
    ok: true,
    patch: {
      hiddenFromGal: false, forwardTo: 'boss@partner.example', forwardKeepCopy: true, acceptFrom: ['partner.example'], rejectFrom: [],
      maxReceiveSizeMb: null, maxSendSizeMb: 10, maxRecipients: 50, maxMessagesPerHour: null, maxRecipientsPerHour: null,
    },
  });
  const shared = patchFromForm(formFromView({ ...view, maxSendSizeMb: undefined }), 'shared');
  assert.equal(shared.ok && 'maxSendSizeMb' in shared.patch, false);
  assert.equal(shared.ok && 'maxMessagesPerHour' in shared.patch, false, '10.5: no send rate for shared mailboxes');
  assert.deepEqual(patchFromForm({ ...formFromView(view), forwardTo: 'nope' }, 'user'), { ok: false, field: 'forwardTo' });
  assert.deepEqual(patchFromForm({ ...formFromView(view), maxRecipients: '-1' }, 'user'), { ok: false, field: 'maxRecipients' });
});

test('10.5: hourly send rate per mailbox — view → form → body, empty = global, invalid named', () => {
  const f = formFromView({ ...view, maxMessagesPerHour: 50, maxRecipientsPerHour: null });
  assert.equal(f.maxMessagesPerHour, '50');
  assert.equal(f.maxRecipientsPerHour, '');
  const body = patchFromForm({ ...f, maxRecipientsPerHour: '400' }, 'user');
  assert.equal(body.ok && body.patch['maxMessagesPerHour'], 50);
  assert.equal(body.ok && body.patch['maxRecipientsPerHour'], 400);
  assert.deepEqual(patchFromForm({ ...f, maxMessagesPerHour: 'x' }, 'user'), { ok: false, field: 'maxMessagesPerHour' });
});
