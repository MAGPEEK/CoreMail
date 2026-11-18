import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tooLargeText } from './errorTexts.ts';

test('a 413 (draft or mail over the size limit) names the limit and what to do', () => {
  assert.equal(tooLargeText(25 * 1024 * 1024), 'Die Nachricht ist zu groß (höchstens 25 MB). Bitte Anhänge entfernen oder verkleinern.');
  assert.equal(tooLargeText(undefined), 'Die Nachricht ist zu groß. Bitte Anhänge entfernen oder verkleinern.');
  assert.equal(tooLargeText('25'), 'Die Nachricht ist zu groß. Bitte Anhänge entfernen oder verkleinern.');
});
