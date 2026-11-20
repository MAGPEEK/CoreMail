import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RIBBON_TAB_LABELS, latestReleasedVersion, newMenuItems, ribbonTabs, selectableTab, tabAfterComposeChange, tabKeyTarget,
} from './ribbon.ts';
import { ribbonMailStates, type RibbonMailContext } from './mailCommands.ts';
import { translations } from '../i18n/translations.ts';

const t = (k: keyof typeof translations.de) => translations.de[k];

test('tab row: Start | Ansicht | Hilfe, plus Nachricht | Einfügen | Text formatieren | Optionen while a draft is shown', () => {
  assert.deepEqual(ribbonTabs(false).map((id) => RIBBON_TAB_LABELS[id]), ['Start', 'Ansicht', 'Hilfe']);
  assert.deepEqual(ribbonTabs(true).map((id) => RIBBON_TAB_LABELS[id]),
    ['Start', 'Ansicht', 'Hilfe', 'Nachricht', 'Einfügen', 'Text formatieren', 'Optionen']);
});

test('compose opens → Nachricht; another draft → Nachricht; last draft gone / mail selected → Start', () => {
  assert.equal(tabAfterComposeChange('start', null, 'c1'), 'message');
  assert.equal(tabAfterComposeChange('view', null, 'c1'), 'message');
  assert.equal(tabAfterComposeChange('format', 'c1', 'c2'), 'message');
  assert.equal(tabAfterComposeChange('format', 'c1', 'c1'), 'format', 'same draft: the selection stays');
  assert.equal(tabAfterComposeChange('insert', 'c1', null), 'start');
  assert.equal(tabAfterComposeChange('help', 'c1', null), 'help', 'a base tab stays');
  assert.equal(selectableTab('options', false), 'start');
  assert.equal(selectableTab('options', true), 'options');
});

test('tab keyboard: arrows wrap, Home / End jump, other keys ignored', () => {
  const tabs = ribbonTabs(true);
  assert.equal(tabKeyTarget('ArrowRight', tabs, 'start'), 'view');
  assert.equal(tabKeyTarget('ArrowLeft', tabs, 'start'), 'options');
  assert.equal(tabKeyTarget('ArrowRight', tabs, 'options'), 'start');
  assert.equal(tabKeyTarget('End', tabs, 'view'), 'options');
  assert.equal(tabKeyTarget('Home', tabs, 'help'), 'start');
  assert.equal(tabKeyTarget('Enter', tabs, 'help'), null);
});

test('"Über CoreMail" shows the newest released version', () => {
  assert.equal(latestReleasedVersion([{ version: 'Unreleased' }, { version: '10.1.0' }, { version: '10.0.0' }]), '10.1.0');
  assert.equal(latestReleasedVersion([{ version: 'Unreleased' }]), null);
  assert.equal(latestReleasedVersion(undefined), null);
});

test('"Neue E-Mail" menu: E-Mail, E-Mail aus Vorlage (only with a template source), Ereignis', () => {
  assert.deepEqual(newMenuItems(true), ['mail', 'template', 'event']);
  assert.deepEqual(newMenuItems(false), ['mail', 'event']);
  // the own-mailbox mail is a fourth, last entry — only while a shared / delegated mailbox is open
  assert.deepEqual(newMenuItems(true, true), ['mail', 'template', 'event', 'ownMail']);
  assert.deepEqual(newMenuItems(true, false), ['mail', 'template', 'event']);
});

const ctx = (over: Partial<RibbonMailContext> = {}): RibbonMailContext => ({
  selection: { count: 1, anyUnread: false, allFlagged: false, allPinned: false },
  readOnly: false, foreign: false, isJunkFolder: false, hasFolder: true, folderUnread: 3, hasOpenMessage: true, ...over,
});

test('Start-tab commands: reply needs one message, print an open one, mark-all-read unread mail and write access', () => {
  const s = ribbonMailStates(ctx(), t);
  for (const id of ['reply', 'replyAll', 'forward', 'deletePermanent', 'markAllRead', 'print'] as const) assert.equal(s[id].enabled, true, id);
  assert.equal(s.markAllRead.label, 'Alle als gelesen markieren');

  const many = ribbonMailStates(ctx({ selection: { count: 3, anyUnread: true, allFlagged: false, allPinned: false } }), t);
  assert.equal(many.reply.enabled, false);
  assert.equal(many.reply.tooltip, 'Genau eine Nachricht auswählen');
  assert.equal(many.deletePermanent.enabled, true);

  const none = ribbonMailStates(ctx({ selection: { count: 0, anyUnread: false, allFlagged: false, allPinned: false }, hasOpenMessage: false, folderUnread: 0 }), t);
  assert.equal(none.deletePermanent.enabled, false);
  assert.equal(none.print.tooltip, 'Zuerst eine Nachricht öffnen');
  assert.equal(none.markAllRead.tooltip, 'Keine ungelesenen Nachrichten in diesem Ordner');

  const ro = ribbonMailStates(ctx({ readOnly: true }), t);
  assert.equal(ro.markAllRead.enabled, false);
  assert.equal(ro.deletePermanent.enabled, false);
  assert.equal(ro.reply.enabled, true, 'replying needs no write access to the shown mailbox');
  assert.equal(ribbonMailStates(ctx({ hasFolder: false }), t).markAllRead.enabled, false);
});

test('labels: Senden planen, the new-mail menu and the ribbon texts exist in German and English', () => {
  assert.equal(translations.de.compose_schedule, 'Senden planen …');
  assert.equal(translations.de.mail_cmd_new_template, 'E-Mail aus Vorlage');
  assert.equal(translations.de.mail_cmd_new_event, 'Ereignis');
  assert.equal(translations.en.mail_cmd_new_event, 'Event');
  assert.equal(translations.es.ribbon_collapse, translations.en.ribbon_collapse, 'es/it fall back to English');
});
