import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wizardSteps, commitStep, nextStep, previousStep, stepPosition, showTokenFileHint, secretsFilePath,
  isValidDomain, isValidHostname, defaultHostname, isValidLocalPart, passwordScore,
  blockReason, tokenNeedsCheck, completeBody, parseResume, insecureConnection, downloadFilename,
  defaultSecretsFilename, DEFAULT_SECRETS_FILE, INITIAL_FORM, SUGGESTED_DOMAIN, isLocalDomain, showCertificateStep,
  type WizardForm,
} from './setupWizard.ts';

const form = (over: Partial<WizardForm> = {}): WizardForm => ({
  tokenRequired: true, token: 'tok-123', verifiedToken: 'tok-123',
  domain: 'example.com', hostname: 'mail.example.com', organizationName: 'Example GmbH', adminName: 'Erika',
  localPart: 'admin', password: 'correct-horse-9', confirm: 'correct-horse-9', secretsConfirmed: false,
  acmeEmail: 'admin@example.com', acmeTermsAccepted: true,
  ...over,
});

test('steps: no DNS step; the secrets step shows only when the secrets were generated', () => {
  assert.deepEqual(wizardSteps({ secretsGenerated: true }), ['welcome', 'domain', 'admin', 'secrets', 'done']);
  assert.deepEqual(wizardSteps({ secretsGenerated: false }), ['welcome', 'domain', 'admin', 'done']);
});

test('10.6: the certificate step follows the admin step and "Secrets sichern"; only when requested', () => {
  assert.deepEqual(wizardSteps({ secretsGenerated: true, certificate: true }), ['welcome', 'domain', 'admin', 'secrets', 'certificate', 'done']);
  assert.deepEqual(wizardSteps({ secretsGenerated: false, certificate: true }), ['welcome', 'domain', 'admin', 'certificate', 'done']);
  assert.deepEqual(wizardSteps({ secretsGenerated: false, certificate: false }), ['welcome', 'domain', 'admin', 'done']);
  const s = wizardSteps({ secretsGenerated: true, certificate: true });
  assert.equal(commitStep(s), 'admin', 'the commit still happens when leaving the admin step');
  assert.equal(nextStep(s, 'secrets'), 'certificate');
  assert.equal(nextStep(s, 'certificate'), 'done');
  assert.equal(previousStep(s, 'certificate', true), 'secrets');
  assert.equal(previousStep(wizardSteps({ secretsGenerated: false, certificate: true }), 'certificate', true), null, 'no way back into the spent admin form');
});

test('10.6: certificate step visibility — public host names only (shared isLocalHostname)', () => {
  for (const h of ['mail.firma.de', 'MAIL.Example.com', 'mx.example.org.']) assert.equal(showCertificateStep(h), true, h);
  for (const h of ['mail.example.local', 'mail.firma.lan', 'mail.corp.internal', 'mail.home.arpa', 'mail.example.test',
    'box.localdomain', '192.168.1.10', '10.0.0.1', 'localhost', 'mailserver', '', null, undefined]) {
    assert.equal(showCertificateStep(h), false, String(h));
  }
  assert.equal(showCertificateStep(INITIAL_FORM.hostname), false, 'the example.local default has no certificate step');
});

test('10.6: "Zertifikat anfordern" needs a valid contact e-mail and the accepted terms', () => {
  assert.equal(blockReason('certificate', form()), null);
  for (const acmeEmail of ['', '  ', 'admin', 'admin@', '@example.com', 'a b@example.com', 'admin@example', 'a..b@example.com', `${'x'.repeat(250)}@example.com`]) {
    assert.equal(blockReason('certificate', form({ acmeEmail })), 'acmeEmail', acmeEmail);
  }
  assert.equal(blockReason('certificate', form({ acmeEmail: ' user@domain.de ' })), null, 'surrounding spaces are trimmed');
  assert.equal(blockReason('certificate', form({ acmeTermsAccepted: false })), 'acmeTerms');
  assert.equal(blockReason('certificate', form({ acmeEmail: 'x', acmeTermsAccepted: false })), 'acmeEmail', 'the e-mail is checked first');
  assert.equal(INITIAL_FORM.acmeTermsAccepted, false, 'the terms are never pre-accepted');
});

test('commit happens when leaving the admin step (the download needs the admin session)', () => {
  assert.equal(commitStep(wizardSteps({ secretsGenerated: true })), 'admin');
  assert.equal(commitStep(wizardSteps({ secretsGenerated: false })), 'admin');
});

test('navigation: next / back, closed pre-commit steps after the commit, no way back from done, position', () => {
  const s = wizardSteps({ secretsGenerated: true });
  assert.equal(nextStep(s, 'welcome'), 'domain');
  assert.equal(nextStep(s, 'admin'), 'secrets');
  assert.equal(nextStep(s, 'secrets'), 'done');
  assert.equal(nextStep(s, 'done'), null);
  assert.equal(nextStep(wizardSteps({ secretsGenerated: false }), 'admin'), 'done');
  assert.equal(previousStep(s, 'welcome', false), null);
  assert.equal(previousStep(s, 'admin', false), 'domain');
  assert.equal(previousStep(s, 'secrets', true), null, 'no way back into the spent setup forms');
  assert.equal(previousStep(s, 'done', true), null, 'the download is closed once the summary is reached');
  assert.deepEqual(stepPosition(s, 'welcome'), { index: 1, total: 5 });
  assert.deepEqual(stepPosition(wizardSteps({ secretsGenerated: false }), 'done'), { index: 4, total: 4 });
});

test('token file hint only with a reported secrets file; tolerant of older servers', () => {
  assert.equal(showTokenFileHint({ secretsFile: './secrets/coremail.env' }), true);
  assert.equal(showTokenFileHint({ secretsFile: null }), false);
  assert.equal(showTokenFileHint({}), false);
  assert.equal(showTokenFileHint(null), false);
  assert.equal(secretsFilePath({ secretsFile: '/opt/coremail/secrets/coremail.env' }), '/opt/coremail/secrets/coremail.env');
  assert.equal(secretsFilePath({}), DEFAULT_SECRETS_FILE);
});

test('unencrypted connection: the server answer wins, else the page protocol', () => {
  assert.equal(insecureConnection(false, 'https:'), true);
  assert.equal(insecureConnection(true, 'http:'), false, 'TLS ends at a trusted proxy');
  assert.equal(insecureConnection(undefined, 'http:'), true);
  assert.equal(insecureConnection(undefined, 'https:'), false);
});

test('download file name: from Content-Disposition, else coremail-secrets-<host>-<date>.env, never a path', () => {
  const now = new Date('2026-11-20T12:00:00Z');
  assert.equal(defaultSecretsFilename('Mail.Example.com', now), 'coremail-secrets-mail.example.com-2026-11-20.env');
  assert.equal(downloadFilename('attachment; filename="coremail-secrets-mail.example.com-2026-11-19.env"', 'x.y', now),
    'coremail-secrets-mail.example.com-2026-11-19.env');
  assert.equal(downloadFilename(null, 'mail.example.com', now), 'coremail-secrets-mail.example.com-2026-11-20.env');
  assert.equal(downloadFilename('attachment; filename="../../etc/passwd"', 'mail.example.com', now),
    'coremail-secrets-mail.example.com-2026-11-20.env');
  assert.equal(defaultSecretsFilename('', now), 'coremail-secrets-server-2026-11-20.env');
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
  assert.equal(blockReason('secrets', form({ secretsConfirmed: true })), null, 'the checkbox alone is enough, no download needed');
  assert.equal(blockReason('done', form()), null);
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

test('10.6: a certificate marker with withCertificate resumes at the certificate step', () => {
  assert.deepEqual(parseResume(JSON.stringify({ step: 'certificate', domain: 'firma.de', hostname: 'mail.firma.de', email: 'a@firma.de', withCertificate: true })),
    { step: 'certificate', domain: 'firma.de', hostname: 'mail.firma.de', email: 'a@firma.de', withCertificate: true });
  assert.equal(parseResume(JSON.stringify({ step: 'done', withCertificate: true }))?.withCertificate, true);
});

test('resume marker: post-commit steps only, older DNS / certificate markers resume at the summary, malformed input ignored', () => {
  assert.deepEqual(parseResume(JSON.stringify({ step: 'secrets', domain: 'example.com', hostname: 'mail.example.com', email: 'a@example.com', withSecrets: true })),
    { step: 'secrets', domain: 'example.com', hostname: 'mail.example.com', email: 'a@example.com', withSecrets: true });
  assert.equal(parseResume(JSON.stringify({ step: 'dns', domain: 'example.com' }))?.step, 'done');
  assert.equal(parseResume(JSON.stringify({ step: 'certificate', certificateChoice: 'later' }))?.step, 'done');
  assert.equal(parseResume(JSON.stringify({ step: 'admin' })), null, 'pre-commit steps never resume');
  assert.equal(parseResume('{'), null);
  assert.equal(parseResume(null), null);
});

// ── 10.5: local domain first ──────────────────────────────────────────────────

test('10.5: the wizard starts with example.local / mail.example.local, no organisation, admin@example.local', () => {
  assert.equal(SUGGESTED_DOMAIN, 'example.local');
  assert.equal(INITIAL_FORM.domain, 'example.local');
  assert.equal(INITIAL_FORM.hostname, 'mail.example.local');
  assert.equal(INITIAL_FORM.organizationName, '');
  assert.equal(INITIAL_FORM.localPart, 'admin');
  assert.equal(INITIAL_FORM.password, '');
  assert.equal(blockReason('domain', INITIAL_FORM), null, 'the defaults pass the domain step as they are');
  assert.equal(completeBody({ ...INITIAL_FORM, password: 'pw-123456', confirm: 'pw-123456' })['email'], 'admin@example.local');
  // the page derives the host name from the domain while the host name is untouched
  assert.equal(defaultHostname('firma.de'), 'mail.firma.de');
});

test('10.5: private suffixes pass the checks; a real domain still works', () => {
  for (const d of ['example.local', 'firma.lan', 'corp.internal', 'home.arpa', 'example.test', 'box.localdomain', 'firma.de']) {
    assert.equal(isValidDomain(d), true, d);
    assert.equal(isValidHostname(defaultHostname(d)), true, d);
    assert.equal(blockReason('domain', form({ domain: d, hostname: defaultHostname(d) })), null, d);
  }
});

test('10.5: local domains are recognised (admin hint, host name hint)', () => {
  for (const d of ['example.local', 'Mail.Example.LOCAL', 'firma.lan', 'corp.internal', 'home.arpa', 'example.test', 'box.localdomain', '192.168.1.10']) {
    assert.equal(isLocalDomain(d), true, d);
  }
  for (const d of ['firma.de', 'example.com', 'local.example.com', '']) assert.equal(isLocalDomain(d), false, d);
});
