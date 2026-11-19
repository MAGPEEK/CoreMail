import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALIGNMENTS, FORMAT_BAR, SEND_MENU, TEXT_DIRECTIONS, fieldRowHeights, formatBarAvailable, formatBarToggleLabel, formatBarVisible,
  formatFlyout, formatSwitchLabel, headerCommands, moreMenuCommands, sizeInPoints, statusLayoutClass, stepFontSize, tableCommandsFor, type FlyoutState,
} from './composeToolbar.ts';
import { TABLE_COMMANDS } from './composeFormat.ts';
import { SENSITIVITY_LEVELS, sensitivityBadge, toSensitivity } from './sensitivity.ts';
import { translations } from '../i18n/translations.ts';

const idle: FlyoutState = {
  inTable: false, inLink: false, align: 'left', direction: 'ltr',
  superscript: false, subscript: false, strike: false, quote: false, code: false,
};
const ids = (s: FlyoutState) => formatFlyout(s).map((section) => section.map((e) => e.id));

test('formatting toolbar: the buttons at the bottom of the card, hidden in plain text or by the preference', () => {
  assert.deepEqual(FORMAT_BAR, ['grow', 'shrink', 'bold', 'italic', 'underline', 'highlight', 'color', 'bullets', 'numbering', 'indent', 'link', 'emoji']);
  assert.equal(formatBarAvailable(false), true);
  assert.equal(formatBarAvailable(true), false);
  assert.equal(formatBarVisible(false, true), true);
  assert.equal(formatBarVisible(false, false), false, 'switched off with "Formatleiste ausblenden"');
  assert.equal(formatBarVisible(true, true), false, 'plain text has nothing to format');
  assert.equal(formatBarToggleLabel(true), 'compose_format_bar_hide');
  assert.equal(formatBarToggleLabel(false), 'compose_format_bar_show');
  assert.equal(translations.de.compose_format_bar_hide, 'Formatleiste ausblenden');
  assert.equal(translations.de.compose_format_bar_show, 'Formatleiste einblenden');
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

test('header row: quiet icon buttons, the Senden menu and the "…" menu (nothing of the old bars is lost)', () => {
  assert.deepEqual(headerCommands(false, true), ['attach', 'inlineImage', 'signature', 'formatBar']);
  assert.deepEqual(headerCommands(true, true), ['attach', 'signature'], 'plain text: no pictures, no toolbar toggle');
  assert.deepEqual(headerCommands(false, false), ['attach', 'inlineImage', 'formatBar'], 'the picker needs named signatures');
  assert.deepEqual([...SEND_MENU], ['send', 'schedule', 'importance', 'options']);
  assert.deepEqual(moreMenuCommands(false), ['save', 'showFrom', 'checkNames', 'datetime', 'insertTemplate', 'saveTemplate', 'format', 'formatBar', 'a11y']);
  assert.deepEqual(moreMenuCommands(true), ['save', 'showFrom', 'checkNames', 'datetime', 'insertTemplate', 'saveTemplate', 'format', 'a11y', 'emoji']);
  assert.equal(translations.de.compose_schedule, 'Senden planen …');
  assert.deepEqual(fieldRowHeights('normal'), { row: 36, subject: 40 });
  assert.deepEqual(fieldRowHeights('comfortable'), { row: 36, subject: 40 });
  assert.deepEqual(fieldRowHeights('compact'), { row: 32, subject: 36 });
  assert.equal(formatSwitchLabel(false), 'compose_to_plain');
  assert.equal(formatSwitchLabel(true), 'compose_to_html');
  assert.equal(translations.de[formatSwitchLabel(false)], 'Zu Nur-Text wechseln');
  assert.equal(translations.de[formatSwitchLabel(true)], 'Zu HTML wechseln');
});

test('draft status never changes the toolbar width on narrow inline panes (no layout jump)', () => {
  assert.match(statusLayoutClass(false, false), /max-\[1179px\]:sr-only/, 'narrow: text for screen readers only');
  assert.match(statusLayoutClass(false, false), /min-\[1180px\]:min-w-\[10rem\]/, 'wide: fixed width');
  assert.doesNotMatch(statusLayoutClass(false, true), /sr-only/, 'a failure is always visible');
  assert.match(statusLayoutClass(true, false), /^min-w-\[10rem\]/, 'own window: always reserved');
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
