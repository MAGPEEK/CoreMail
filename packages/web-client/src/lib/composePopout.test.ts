import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HANDOFF_ACK_MS, POPOUT_ROUTE, PRESENCE_TIMEOUT_MS, acceptedMessage, acceptsMessage, draftIdSet, holdsDraft, isDraftId,
  parsePopoutMessage, parsePresenceMessage, popoutUrl, popoutWindowName, presenceQuery, presenceReply, returnedMessage, sendMessage,
} from './composePopout.ts';
import { IMPORTANCE_LEVELS, importanceBadge, toImportance } from './importance.ts';

const flags = { requestReceipt: true, requestDeliveryReceipt: false };

test('popout URL: /compose/<draftId>, ids are checked before they reach a URL', () => {
  assert.equal(POPOUT_ROUTE, '/compose/:draftId');
  assert.equal(popoutUrl('clx1abc_DEF-2'), '/compose/clx1abc_DEF-2');
  assert.ok(isDraftId('clx1abc'));
  for (const bad of ['', '../x', 'a/b', 'a b', 'x'.repeat(101), 5, null, '<script>']) assert.equal(isDraftId(bad), false, String(bad));
  assert.equal(popoutWindowName('compose-3'), 'coremail-compose-compose-3');
  assert.equal(popoutWindowName('a b/c'), 'coremail-compose-abc');
});

test('messages: send / accepted / returned round trip, everything else refused', () => {
  assert.deepEqual(parsePopoutMessage(sendMessage('d1', flags)), sendMessage('d1', flags));
  assert.deepEqual(parsePopoutMessage(sendMessage('d1', { requestReceipt: false, requestDeliveryReceipt: true })),
    sendMessage('d1', { requestReceipt: false, requestDeliveryReceipt: true }), 'delivery receipt travels with the send');
  assert.deepEqual(parsePopoutMessage(acceptedMessage('d1')), acceptedMessage('d1'));
  assert.deepEqual(parsePopoutMessage(returnedMessage('d1', 'Angebot')), returnedMessage('d1', 'Angebot'));
  const sloppy = parsePopoutMessage({ ...sendMessage('d1', flags), requestReceipt: 'yes', requestDeliveryReceipt: 1 });
  assert.deepEqual(sloppy, sendMessage('d1', { requestReceipt: false, requestDeliveryReceipt: false }), 'only a real true asks for a receipt');
  for (const bad of [null, 'send', {}, { kind: 'other', type: 'send', draftId: 'd1' }, { ...sendMessage('d1', flags), draftId: '../x' },
    { ...sendMessage('d1', flags), type: 'delete' }]) {
    assert.equal(parsePopoutMessage(bad), null, JSON.stringify(bad));
  }
  assert.equal((returnedMessage('d1', 'x'.repeat(900)) as { subject: string }).subject.length, 500);
});

test('messages count only from the own origin and from a window this window opened', () => {
  assert.ok(acceptsMessage('https://mail.example.test', 'https://mail.example.test', true));
  assert.equal(acceptsMessage('https://evil.example.test', 'https://mail.example.test', true), false);
  assert.equal(acceptsMessage('https://mail.example.test', 'https://mail.example.test', false), false, 'another tab / frame');
  assert.ok(HANDOFF_ACK_MS >= 1000, 'the main window has time to answer');
});

test('presence: a window answers for any id the draft had; queries and replies are validated', () => {
  assert.equal(PRESENCE_TIMEOUT_MS, 300);
  const q = presenceQuery('nonce-1234', ['d3', null, 'd3', '../bad', undefined, 'd2']);
  assert.deepEqual(q, { kind: 'coremail-compose', type: 'presence?', nonce: 'nonce-1234', draftIds: ['d3', 'd2'] });
  assert.deepEqual(parsePresenceMessage(q), q);
  assert.ok(holdsDraft(q, new Set(['d1', 'd2'])), 'an older version id matches');
  assert.equal(holdsDraft(q, new Set(['d9'])), false);
  assert.equal(holdsDraft(presenceReply('nonce-1234'), new Set(['d3'])), false, 'a reply is no question');
  assert.deepEqual(parsePresenceMessage(presenceReply('nonce-1234')), presenceReply('nonce-1234'));
  for (const bad of [null, {}, { ...q, nonce: 'x' }, { ...q, draftIds: 'd1' }, { ...q, draftIds: ['../x'] }, { ...q, kind: 'other' }, { ...q, type: 'presence' }]) {
    assert.equal(parsePresenceMessage(bad), null, JSON.stringify(bad));
  }
  assert.equal(draftIdSet(Array.from({ length: 80 }, (_, i) => `d${i}`)).length, 50, 'bounded');
});

test('importance: levels, server values and the reader badge', () => {
  assert.deepEqual(IMPORTANCE_LEVELS, ['high', 'normal', 'low']);
  assert.equal(toImportance('high'), 'high');
  assert.equal(toImportance('HIGH'), 'normal');
  assert.equal(toImportance(undefined), 'normal');
  assert.equal(importanceBadge('high'), 'high');
  assert.equal(importanceBadge('low'), 'low');
  assert.equal(importanceBadge(null), null);
  assert.equal(importanceBadge('normal'), null);
});
