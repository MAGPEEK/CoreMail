import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wizardSteps, commitStep, nextStep, previousStep, stepPosition, showTokenFileHint, secretsFilePath,
  backupCommands, isValidDomain, isValidHostname, defaultHostname, isValidLocalPart, passwordScore,
  blockReason, tokenNeedsCheck, completeBody, requiredDnsOk, letsEncryptAllowed, acmeDomains,
  phaseForCertStatus, parseResume, DEFAULT_SECRETS_FILE, type WizardForm,
} from './setupWizard.ts';

const form = (over: Partial<WizardForm> = {}): WizardForm => ({
  tokenRequired: true, token: 'tok-123', verifiedToken: 'tok-123',
  domain: 'example.com', hostname: 'mail.example.com', organizationName: 'Example GmbH', adminName: 'Erika',
  localPart: 'admin', password: 'correct-horse-9', confirm: 'correct-horse-9', secretsConfirmed: false,
  ...over,
});

test('steps: the secrets step shows only when the secrets were generated', () => {
  assert.deepEqual(wizardSteps({ secretsGenerated: true }), ['welcome', 'domain', 'admin', 'secrets', 'dns', 'certificate', 'done']);
  assert.deepEqual(wizardSteps({ secretsGenerated: false }), ['welcome', 'domain', 'admin', 'dns', 'certificate', 'done']);
});

test('commit happens when leaving the last pre-commit step', () => {
  assert.equal(commitStep(wizardSteps({ secretsGenerated: true })), 'secrets');
  assert.equal(commitStep(wizardSteps({ secretsGenerated: false })), 'admin');
});

test('navigation: next / back, closed pre-commit steps after the commit, position', () => {
  const s = wizardSteps({ secretsGenerated: true });
  assert.equal(nextStep(s, 'welcome'), 'domain');
  assert.equal(nextStep(s, 'secrets'), 'dns');
  assert.equal(nextStep(s, 'done'), null);
  assert.equal(previousStep(s, 'welcome', false), null);
  assert.equal(previousStep(s, 'admin', false), 'domain');
  assert.equal(previousStep(s, 'dns', true), null, 'no way back into the spent setup forms');
  assert.equal(previousStep(s, 'certificate', true), 'dns');
  assert.deepEqual(stepPosition(s, 'welcome'), { index: 1, total: 7 });
  assert.deepEqual(stepPosition(wizardSteps({ secretsGenerated: false }), 'done'), { index: 6, total: 6 });
});

test('token file hint only with a reported secrets file; tolerant of older servers', () => {
  assert.equal(showTokenFileHint({ secretsFile: './secrets/coremail.env' }), true);
  assert.equal(showTokenFileHint({ secretsFile: null }), false);
  assert.equal(showTokenFileHint({}), false);
  assert.equal(showTokenFileHint(null), false);
  assert.equal(secretsFilePath({ secretsFile: '/opt/coremail/secrets/coremail.env' }), '/opt/coremail/secrets/coremail.env');
  assert.equal(secretsFilePath({}), DEFAULT_SECRETS_FILE);
});

test('backup commands name the file and its directory, quote odd paths, carry no secret', () => {
  assert.deepEqual(backupCommands('./secrets/coremail.env', '/sicherer/ort/'), {
    copy: 'cp ./secrets/coremail.env /sicherer/ort/',
    archive: 'tar czf coremail-secrets-$(date +%F).tar.gz ./secrets',
  });
  assert.equal(backupCommands("/my dir/it's.env", '/b/').copy, `cp '/my dir/it'\\''s.env' /b/`);
  assert.equal(backupCommands('coremail.env', '/b/').archive, 'tar czf coremail-secrets-$(date +%F).tar.gz .');
});

test('input checks', () => {
  assert.equal(isValidDomain('example.com'), true);
  assert.equal(isValidDomain(' Example.COM '), true);
  assert.equal(isValidDomain('https://example.com/'), true, 'a pasted URL is normalised');
  assert.equal(isValidDomain('localhost'), false);
  assert.equal(isValidDomain('exa_mple.com'), false);
  assert.equal(isValidHostname('mail.example.com'), true);
  assert.equal(isValidHostname('-mail.example.com'), false);
  assert.equal(defaultHostname('Example.com'), 'mail.example.com');
  assert.equal(defaultHostname(''), '');
  assert.equal(isValidLocalPart('admin'), true);
  assert.equal(isValidLocalPart('first.last'), true);
  assert.equal(isValidLocalPart('a..b'), false);
  assert.equal(isValidLocalPart('admin@example.com'), false);
  assert.equal(isValidLocalPart(''), false);
});

test('password meter', () => {
  assert.equal(passwordScore(''), 0);
  assert.equal(passwordScore('short'), 1);
  assert.equal(passwordScore('aaaaaaaaaaaaaaaa'), 1, 'one repeated character');
  assert.equal(passwordScore('password12345678'), 1, 'obvious word');
  assert.equal(passwordScore('abcdwxyz'), 1);
  assert.equal(passwordScore('abcdwxyz1234'), 2);
  assert.equal(passwordScore('Abcd-wxyz-1234'), 3);
  assert.equal(passwordScore('Abcd-wxyz-1234-Qrs'), 4);
});

test('"Weiter" gating per step', () => {
  assert.equal(blockReason('welcome', form({ token: '  ' })), 'token');
  assert.equal(blockReason('welcome', form({ tokenRequired: false, token: '' })), null);
  assert.equal(blockReason('domain', form({ domain: 'nope' })), 'domain');
  assert.equal(blockReason('domain', form({ hostname: 'x' })), 'hostname');
  assert.equal(blockReason('domain', form({ organizationName: 'x'.repeat(201) })), 'organization');
  assert.equal(blockReason('domain', form()), null);
  assert.equal(blockReason('admin', form({ localPart: 'a b' })), 'localPart');
  assert.equal(blockReason('admin', form({ password: 'short', confirm: 'short' })), 'passwordLength');
  assert.equal(blockReason('admin', form({ confirm: 'other-password' })), 'passwordMismatch');
  assert.equal(blockReason('admin', form()), null);
  assert.equal(blockReason('secrets', form()), 'secrets', 'only after the checkbox');
  assert.equal(blockReason('secrets', form({ secretsConfirmed: true })), null);
  assert.equal(blockReason('dns', form()), null);
});

test('token is checked again only when it changed', () => {
  assert.equal(tokenNeedsCheck(form()), false);
  assert.equal(tokenNeedsCheck(form({ token: 'tok-124' })), true);
  assert.equal(tokenNeedsCheck(form({ verifiedToken: null })), true);
  assert.equal(tokenNeedsCheck(form({ tokenRequired: false, verifiedToken: null })), false);
});

test('complete body: normalised names, address in the domain, optional fields only when set', () => {
  assert.deepEqual(completeBody(form({ domain: ' Example.com ', hostname: 'MAIL.example.com.', localPart: 'Admin' })), {
    domain: 'example.com', hostname: 'mail.example.com', email: 'admin@example.com', password: 'correct-horse-9',
    organizationName: 'Example GmbH', displayName: 'Erika', setupToken: 'tok-123',
  });
  const b = completeBody(form({ organizationName: ' ', adminName: '', tokenRequired: false }));
  assert.equal('organizationName' in b, false);
  assert.equal('displayName' in b, false);
  assert.equal('setupToken' in b, false);
});

test('DNS gating: required records and the Let\'s Encrypt offer', () => {
  const rec = (ok: boolean) => ({ type: 'X', name: '@', expected: '', ok, found: null });
  const all = { a: rec(true), mx: rec(true), spf: rec(true), dkim: rec(true), dmarc: rec(false), ptr: rec(false) };
  assert.equal(requiredDnsOk(all), true, 'recommended records do not block');
  assert.equal(requiredDnsOk({ ...all, dkim: rec(false) }), false);
  assert.equal(requiredDnsOk(null), false);
  assert.equal(letsEncryptAllowed({ ...all, spf: rec(false), dkim: rec(false) }), true, 'A + MX are enough');
  assert.equal(letsEncryptAllowed({ ...all, a: rec(false) }), false);
  assert.equal(letsEncryptAllowed({ ...all, mx: rec(false) }), false);
  assert.equal(letsEncryptAllowed(undefined), false);
});

test('ACME order names: host name first, suggestions only when they resolve here', () => {
  assert.deepEqual(acmeDomains('Mail.example.com', [
    { name: 'autodiscover.example.com', resolvesHere: true },
    { name: 'autoconfig.example.com', resolvesHere: false },
    { name: 'mail.example.com', resolvesHere: true },
  ]), ['mail.example.com', 'autodiscover.example.com']);
});

test('certificate status → issuance phase', () => {
  assert.equal(phaseForCertStatus('PENDING'), 'waiting');
  assert.equal(phaseForCertStatus('RENEWING'), 'waiting');
  assert.equal(phaseForCertStatus('ACTIVE'), 'done');
  assert.equal(phaseForCertStatus('ERROR'), 'failed');
});

test('resume marker: post-commit steps only, malformed input ignored', () => {
  assert.deepEqual(parseResume(JSON.stringify({ step: 'certificate', domain: 'example.com', hostname: 'mail.example.com', email: 'a@example.com', certificateChoice: 'proxy' })),
    { step: 'certificate', domain: 'example.com', hostname: 'mail.example.com', email: 'a@example.com', certificateChoice: 'proxy' });
  assert.equal(parseResume(JSON.stringify({ step: 'admin' })), null, 'pre-commit steps never resume');
  assert.equal(parseResume('{'), null);
  assert.equal(parseResume(null), null);
  assert.equal(parseResume(JSON.stringify({ step: 'dns', certificateChoice: 'x' }))?.certificateChoice, undefined);
});
