import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALIGNMENTS, FORMAT_BAR, TEXT_DIRECTIONS, actionBarCommands, formatBarVisible, formatFlyout, formatSwitchLabel,
  moreMenuCommands, sizeInPoints, stepFontSize, tableCommandsFor, type FlyoutState,
} from './composeToolbar.ts';
import { TABLE_COMMANDS } from './composeFormat.ts';
import { SENSITIVITY_LEVELS, sensitivityBadge, toSensitivity } from './sensitivity.ts';
import { translations } from '../i18n/translations.ts';

const idle: FlyoutState = {
  inTable: false, inLink: false, align: 'left', direction: 'ltr',
  superscript: false, subscript: false, strike: false, quote: false, code: false,
};
const ids = (s: FlyoutState) => formatFlyout(s).map((section) => section.map((e) => e.id));

test('formatting toolbar: the buttons below the body, hidden in plain-text format', () => {
  assert.deepEqual(FORMAT_BAR, ['grow', 'shrink', 'bold', 'italic', 'underline', 'highlight', 'color', 'bullets', 'numbering', 'indent']);
  assert.equal(formatBarVisible(false), true);
  assert.equal(formatBarVisible(true), false);
  assert.deepEqual(ALIGNMENTS, ['left', 'center', 'right', 'justify']);
  assert.deepEqual(TEXT_DIRECTIONS, ['ltr', 'rtl']);
});

test('flyout: sections in order; "Link entfernen" only inside a link; toggles carry their state', () => {
  assert.deepEqual(ids(idle), [
    ['outdent', 'indent'],
    ['align', 'direction'],
    ['link', 'quote', 'code', 'superscript', 'subscript', 'strike'],
    ['image', 'table', 'rule'],
    ['style', 'font', 'size'],
    ['undo', 'redo', 'clear'],
  ]);
  assert.deepEqual(ids({ ...idle, inLink: true })[2], ['link', 'unlink', 'quote', 'code', 'superscript', 'subscript', 'strike']);
  const on = formatFlyout({ ...idle, superscript: true, strike: true, quote: true }).flat();
  const checked = Object.fromEntries(on.filter((e) => e.checked !== undefined).map((e) => [e.id, e.checked]));
  assert.deepEqual(checked, { quote: true, code: false, superscript: true, subscript: false, strike: true });
  assert.equal(on.find((e) => e.id === 'align')!.checked, undefined, 'a submenu is not a toggle');
});

test('flyout table submenu: insert only, row / column commands inside a table', () => {
  assert.deepEqual(tableCommandsFor(false), ['insert']);
  assert.deepEqual(tableCommandsFor(true), [...TABLE_COMMANDS]);
});

test('font size steps: next size of the list from the text size or the default; null at the ends', () => {
  assert.equal(sizeInPoints('11pt'), 11);
  assert.equal(sizeInPoints('16px'), 12);
  assert.equal(sizeInPoints('large'), null);
  assert.equal(stepFontSize('11pt', '11pt', 1), '12pt');
  assert.equal(stepFontSize('11pt', '11pt', -1), '10pt');
  assert.equal(stepFontSize(undefined, '14pt', 1), '16pt', 'no size on the text: from the default');
  assert.equal(stepFontSize('13pt', '11pt', 1), '14pt', 'a size between two steps goes to the next one');
  assert.equal(stepFontSize('13pt', '11pt', -1), '12pt');
  assert.equal(stepFontSize('20px', '11pt', 1), '16pt', 'px sizes of pasted text');
  assert.equal(stepFontSize('36pt', '11pt', 1), null);
  assert.equal(stepFontSize('8pt', '11pt', -1), null);
  assert.equal(stepFontSize(null, 'bad', 1), null);
});

test('action bar and "…" menu: pictures need HTML, the picker needs signatures, no popout in the own window', () => {
  assert.deepEqual(actionBarCommands(false, true), ['send', 'discard', 'attach', 'inlineImage', 'emoji', 'signature', 'more']);
  assert.deepEqual(actionBarCommands(true, true), ['send', 'discard', 'attach', 'emoji', 'signature', 'more']);
  assert.deepEqual(actionBarCommands(false, false), ['send', 'discard', 'attach', 'inlineImage', 'emoji', 'more']);
  assert.deepEqual(moreMenuCommands(false), ['save', 'showFrom', 'checkNames', 'importance', 'format', 'options', 'a11y', 'popout']);
  assert.deepEqual(moreMenuCommands(true), ['save', 'showFrom', 'checkNames', 'importance', 'format', 'options', 'a11y']);
  assert.equal(formatSwitchLabel(false), 'compose_to_plain');
  assert.equal(formatSwitchLabel(true), 'compose_to_html');
  assert.equal(translations.de[formatSwitchLabel(false)], 'Zu Nur-Text wechseln');
  assert.equal(translations.de[formatSwitchLabel(true)], 'Zu HTML wechseln');
});

test('sensitivity: levels, server values and the reader badge', () => {
  assert.deepEqual(SENSITIVITY_LEVELS, ['normal', 'personal', 'private', 'confidential']);
  assert.equal(toSensitivity('private'), 'private');
  assert.equal(toSensitivity('Private'), 'normal');
  assert.equal(toSensitivity(undefined), 'normal');
  assert.equal(sensitivityBadge('confidential'), 'confidential');
  assert.equal(sensitivityBadge('personal'), 'personal');
  assert.equal(sensitivityBadge('normal'), null);
  assert.equal(sensitivityBadge(null), null);
  for (const level of SENSITIVITY_LEVELS) assert.ok(`compose_sensitivity_${level}` in translations.de, level);
  for (const level of ['personal', 'private', 'confidential']) assert.ok(`reader_sensitivity_${level}` in translations.de, level);
});
