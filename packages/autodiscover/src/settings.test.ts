/**
 * 9.1: host-name variables before the setup wizard — an EMPTY SMTP_HOSTNAME /
 * POP3_HOSTNAME / IMAP_HOSTNAME / MAIL_HOSTNAME (what Compose passes for an unset
 * `${VAR:-}`) counts as unset instead of becoming the host name.
 * Run: node --import tsx --test src/settings.test.ts
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';

// No ServerSettings row yet (fresh install) → environment defaults
(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  serverSettings: { findUnique: async () => null },
};

const settings = await import('./settings.js');

const VARS = ['MAIL_HOSTNAME', 'IMAP_HOSTNAME', 'SMTP_HOSTNAME', 'POP3_HOSTNAME'] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const v of VARS) { saved[v] = process.env[v]; delete process.env[v]; }
  settings.resetSettingsCacheForTests();
});
afterEach(() => {
  for (const v of VARS) { if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v]; }
});

test('envHost: trimmed value, empty / whitespace / unset → undefined', () => {
  assert.equal(settings.envHost('X', { X: ' mail.example.com ' }), 'mail.example.com');
  assert.equal(settings.envHost('X', { X: '' }), undefined);
  assert.equal(settings.envHost('X', { X: '   ' }), undefined);
  assert.equal(settings.envHost('X', {}), undefined);
});

test('empty SMTP_HOSTNAME / POP3_HOSTNAME fall back to MAIL_HOSTNAME', async () => {
  process.env['MAIL_HOSTNAME'] = 'mail.example.com';
  process.env['SMTP_HOSTNAME'] = '';
  process.env['POP3_HOSTNAME'] = '  ';
  process.env['IMAP_HOSTNAME'] = '';
  const c = await settings.getServerConfig();
  assert.equal(c.smtpHost, 'mail.example.com');
  assert.equal(c.pop3Host, 'mail.example.com');
  assert.equal(c.imapHost, 'mail.example.com');
  assert.equal(c.publicHostname, 'mail.example.com');
});

test('set values still win; empty MAIL_HOSTNAME → built-in default', async () => {
  process.env['MAIL_HOSTNAME'] = '';
  process.env['SMTP_HOSTNAME'] = 'smtp.example.com';
  process.env['POP3_HOSTNAME'] = ' pop.example.com ';
  const c = settings.envDefaults();
  assert.equal(c.publicHostname, 'mail.local');
  assert.equal(c.imapHost, 'mail.local');
  assert.equal(c.smtpHost, 'smtp.example.com');
  assert.equal(c.pop3Host, 'pop.example.com');
});
