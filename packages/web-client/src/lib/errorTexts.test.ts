import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tooLargeText } from './errorTexts.ts';

test('a 413 (draft or mail over the size limit) names the limit and what to do', () => {
  assert.equal(tooLargeText(25 * 1024 * 1024), 'Die Nachricht ist zu groß (höchstens 25 MB). Bitte Anhänge entfernen oder verkleinern.');
  assert.equal(tooLargeText(undefined), 'Die Nachricht ist zu groß. Bitte Anhänge entfernen oder verkleinern.');
  assert.equal(tooLargeText('25'), 'Die Nachricht ist zu groß. Bitte Anhänge entfernen oder verkleinern.');
});

test('the 413 text follows the UI language (DE / EN; ES / IT use the English text)', () => {
  assert.equal(tooLargeText(25 * 1024 * 1024, 'de'), 'Die Nachricht ist zu groß (höchstens 25 MB). Bitte Anhänge entfernen oder verkleinern.');
  assert.equal(tooLargeText(25 * 1024 * 1024, 'en'), 'The message is too large (at most 25 MB). Please remove or shrink attachments.');
  assert.equal(tooLargeText(null, 'en'), 'The message is too large. Please remove or shrink attachments.');
  assert.equal(tooLargeText(10 * 1024 * 1024, 'es'), tooLargeText(10 * 1024 * 1024, 'en'));
  assert.equal(tooLargeText(512 * 1024, 'en'), 'The message is too large (at most 1 MB). Please remove or shrink attachments.', 'below 1 MB: 1 MB');
});
