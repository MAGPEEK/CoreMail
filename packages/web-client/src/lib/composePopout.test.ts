import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  POPOUT_ROUTE, acceptsMessage, isDraftId, parsePopoutMessage, popoutUrl, popoutWindowName, returnedMessage, sendMessage,
} from './composePopout.ts';

test('popout URL: /compose/<draftId>, ids are checked before they reach a URL', () => {
  assert.equal(POPOUT_ROUTE, '/compose/:draftId');
  assert.equal(popoutUrl('clx1abc_DEF-2'), '/compose/clx1abc_DEF-2');
  assert.ok(isDraftId('clx1abc'));
  for (const bad of ['', '../x', 'a/b', 'a b', 'x'.repeat(101), 5, null, '<script>']) assert.equal(isDraftId(bad), false, String(bad));
  assert.equal(popoutWindowName('compose-3'), 'coremail-compose-compose-3');
  assert.equal(popoutWindowName('a b/c'), 'coremail-compose-abc');
});

test('messages: send / returned round trip, everything else refused', () => {
  assert.deepEqual(parsePopoutMessage(sendMessage('d1', true)), sendMessage('d1', true));
  assert.deepEqual(parsePopoutMessage(returnedMessage('d1', 'Angebot')), returnedMessage('d1', 'Angebot'));
  assert.equal(parsePopoutMessage({ ...sendMessage('d1', true), requestReceipt: 'yes' })?.type === 'send'
    && (parsePopoutMessage({ ...sendMessage('d1', true), requestReceipt: 'yes' }) as { requestReceipt: boolean }).requestReceipt, false,
  'only a real true asks for a receipt');
  for (const bad of [null, 'send', {}, { kind: 'other', type: 'send', draftId: 'd1' }, { ...sendMessage('d1', false), draftId: '../x' },
    { ...sendMessage('d1', false), type: 'delete' }]) {
    assert.equal(parsePopoutMessage(bad), null, JSON.stringify(bad));
  }
  assert.equal(returnedMessage('d1', 'x'.repeat(900)).subject.length, 500);
});

test('messages count only from the own origin and from a window this tab opened', () => {
  assert.ok(acceptsMessage('https://mail.example.test', 'https://mail.example.test', true));
  assert.equal(acceptsMessage('https://evil.example.test', 'https://mail.example.test', true), false);
  assert.equal(acceptsMessage('https://mail.example.test', 'https://mail.example.test', false), false, 'another tab / frame');
});
