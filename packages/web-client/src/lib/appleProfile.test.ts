import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appleProfileFileName, appleProfilePath } from './appleProfile.ts';

test('apple profile download: path without any token, file name per domain + kind', () => {
  assert.equal(appleProfilePath('imap'), '/user/apple-profile');
  assert.equal(appleProfilePath('eas'), '/user/apple-profile?type=eas');
  assert.doesNotMatch(appleProfilePath('imap') + appleProfilePath('eas'), /token/);
  assert.equal(appleProfileFileName('alice@example.com', 'imap'), 'example.com.mobileconfig');
  assert.equal(appleProfileFileName('alice@example.com', 'eas'), 'example.com-activesync.mobileconfig');
  assert.equal(appleProfileFileName('weird@ex"am/ple.com', 'imap'), 'ex_am_ple.com.mobileconfig');
  assert.equal(appleProfileFileName('', 'imap'), 'coremail.mobileconfig');
});
