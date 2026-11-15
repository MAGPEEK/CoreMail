import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APPLE_PROFILE_TICKET_PATH, appleProfileFileName, appleProfilePath, appleProfileTicketUrl, isAppleMobileDevice } from './appleProfile.ts';

test('apple profile download: path without any token, file name per domain + kind', () => {
  assert.equal(appleProfilePath('imap'), '/user/apple-profile');
  assert.equal(appleProfilePath('eas'), '/user/apple-profile?type=eas');
  assert.doesNotMatch(appleProfilePath('imap') + appleProfilePath('eas'), /token/);
  assert.equal(appleProfileFileName('alice@example.com', 'imap'), 'example.com.mobileconfig');
  assert.equal(appleProfileFileName('alice@example.com', 'eas'), 'example.com-activesync.mobileconfig');
  assert.equal(appleProfileFileName('weird@ex"am/ple.com', 'imap'), 'ex_am_ple.com.mobileconfig');
  assert.equal(appleProfileFileName('', 'imap'), 'coremail.mobileconfig');
});

test('9.1 iOS: navigation URL carries the single-use ticket, never an access token', () => {
  assert.equal(APPLE_PROFILE_TICKET_PATH, '/user/apple-profile/ticket');
  assert.equal(appleProfileTicketUrl('imap', 'abc_DEF-123'), '/api/v1/user/apple-profile?ticket=abc_DEF-123');
  assert.equal(appleProfileTicketUrl('eas', 'abc'), '/api/v1/user/apple-profile?type=eas&ticket=abc');
  assert.equal(appleProfileTicketUrl('imap', 'a&b=c'), '/api/v1/user/apple-profile?ticket=a%26b%3Dc', 'encoded');
  assert.doesNotMatch(appleProfileTicketUrl('eas', 'x'), /token=/);
});

test('9.1 iOS detection: iPhone / iPad / iPadOS desktop UA with touch; Mac and others keep the blob download', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const ipadOld = 'Mozilla/5.0 (iPad; CPU OS 12_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1';
  const ipadOs = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
  const windows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
  assert.equal(isAppleMobileDevice(iphone, 5), true);
  assert.equal(isAppleMobileDevice(ipadOld), true);
  assert.equal(isAppleMobileDevice(ipadOs, 5), true, 'iPadOS 13+ desktop UA with touch');
  assert.equal(isAppleMobileDevice(ipadOs, 0), false, 'real Mac');
  assert.equal(isAppleMobileDevice(android, 5), false);
  assert.equal(isAppleMobileDevice(windows, 10), false, 'touch Windows laptop');
});
