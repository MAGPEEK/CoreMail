/** 9.4 webmail policies: what the UI shows for which switch (pure logic). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FEATURES, WEBMAIL_FEATURES, isAppEnabled, featureForPath, isSettingsSectionVisible, attachmentAccess,
  inlinePreviewAllowed, oversizedAttachment, parseImageDecision, showExternalImages, fileExtension,
  type ContentPolicy, type WebmailFeatures,
} from './webmailFeatures.ts';
import { RAIL_ITEMS } from './appRail.ts';
import { realtimePlan } from './realtimeEvents.ts';

const off = (...f: string[]): WebmailFeatures => ({ ...DEFAULT_FEATURES.features, ...Object.fromEntries(f.map((x) => [x, false])) });

test('defaults keep today\'s webmail: every module on, nothing blocked', () => {
  assert.ok(WEBMAIL_FEATURES.every((f) => DEFAULT_FEATURES.features[f]));
  assert.ok(RAIL_ITEMS.every((i) => isAppEnabled(i.id, DEFAULT_FEATURES.features)));
  assert.deepEqual(DEFAULT_FEATURES.content, { blockedExtensions: [], downloadOnlyExtensions: [], maxUploadBytes: null, externalImages: 'ask' });
});

test('rail: switched-off apps disappear, mail always stays', () => {
  const features = off('calendar', 'notes');
  assert.deepEqual(RAIL_ITEMS.filter((i) => isAppEnabled(i.id, features)).map((i) => i.id), ['mail', 'contacts', 'tasks']);
  assert.equal(isAppEnabled('mail', off(...WEBMAIL_FEATURES)), true);
});

test('routes: the module of a page path', () => {
  assert.equal(featureForPath('/calendar/event/1'), 'calendar');
  assert.equal(featureForPath('/contacts'), 'contacts');
  assert.equal(featureForPath('/tasks'), 'tasks');
  assert.equal(featureForPath('/notes'), 'notes');
  assert.equal(featureForPath('/shared-mailbox/abc'), 'sharedMailboxes');
  assert.equal(featureForPath('/mail/inbox'), null);
  assert.equal(featureForPath('/settings'), null);
});

test('settings sections follow their module', () => {
  const features = off('rules', 'signatures', 'categories', 'recoverItems', 'changePassword', 'themes', 'externalClients', 'appPasswords', 'calendar');
  for (const s of ['rules', 'signature', 'categories', 'recover', 'password', 'theme', 'externalClients', 'appPasswords', 'calendar']) {
    assert.equal(isSettingsSectionVisible(s, features), false, s);
    assert.equal(isSettingsSectionVisible(s, DEFAULT_FEATURES.features), true, s);
  }
  for (const s of ['profile', 'oof', 'storage', 'view', 'reading', 'compose', 'language', 'security']) assert.equal(isSettingsSectionVisible(s, features), true, s);
});

test('attachments: blocked, save only, open (by name, case and trailing dots ignored)', () => {
  const policy: ContentPolicy = { blockedExtensions: ['exe'], downloadOnlyExtensions: ['pdf', 'png'], maxUploadBytes: null, externalImages: 'ask' };
  assert.equal(fileExtension('Setup.EXE. '), 'exe');
  assert.equal(attachmentAccess('Setup.EXE', policy), 'blocked');
  assert.equal(attachmentAccess('report.pdf', policy), 'save');
  assert.equal(attachmentAccess('photo.jpg', policy), 'open');
  assert.equal(attachmentAccess('README', policy), 'open');
  assert.equal(inlinePreviewAllowed({ filename: 'logo.png' }, policy), false);
  assert.equal(inlinePreviewAllowed({ filename: 'logo.gif' }, policy), true);
  assert.equal(inlinePreviewAllowed({ filename: null }, policy), true);
});

test('upload limit', () => {
  assert.equal(oversizedAttachment([{ size: 5 }], null), null);
  assert.deepEqual(oversizedAttachment([{ size: 5 }, { size: 9 }], 8), { size: 9 });
});

test('external images: block never loads, load always, ask after the click', () => {
  assert.equal(parseImageDecision('load'), 'load');
  assert.equal(parseImageDecision('block'), 'block');
  assert.equal(parseImageDecision(undefined), 'ask');
  assert.equal(parseImageDecision('weird'), 'ask');
  assert.equal(showExternalImages('block', true), false);
  assert.equal(showExternalImages('load', false), true);
  assert.equal(showExternalImages('ask', false), false);
  assert.equal(showExternalImages('ask', true), true);
});

test('live update: the policies settings event refreshes the features and the preferences', () => {
  const plan = realtimePlan('settings', { type: 'settings', section: 'policies' });
  assert.deepEqual(plan?.invalidate, [['webmail-features'], ['trusted-senders'], ['message']]);
  assert.equal(plan?.refreshPreferences, true);
});
