import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smtpGreetingPreview } from './smtpBanner.ts';

test('default greeting matches the SMTP server ("<host> ESMTP CoreMail")', () => {
  assert.equal(smtpGreetingPreview('mail.example.test', false, 'ignored'), 'mail.example.test ESMTP CoreMail');
  assert.equal(smtpGreetingPreview('mail.example.test', true, '   '), 'mail.example.test ESMTP CoreMail');
});

test('a custom banner without a leading domain gets the host name in front', () => {
  assert.equal(smtpGreetingPreview('mail.example.test', true, 'Welcome'), 'mail.example.test Welcome');
  assert.equal(smtpGreetingPreview('mail.example.test', true, 'mx.example.test ready'), 'mx.example.test ready');
  assert.equal(smtpGreetingPreview('mail.example.test', true, 'line1\r\nline2'), 'mail.example.test line1 line2');
});
