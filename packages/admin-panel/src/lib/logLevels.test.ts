import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveLogLevel, LOG_LEVEL_SERVICES } from './logLevels.ts';

test('effective log level: exact name, then alias, then wildcard', () => {
  assert.equal(effectiveLogLevel({}, 'smtp-server', ['smtp']), null);
  assert.equal(effectiveLogLevel({ '*': 'WARN' }, 'smtp-server', ['smtp']), 'WARN');
  assert.equal(effectiveLogLevel({ '*': 'WARN', smtp: 'DEBUG' }, 'smtp-server', ['smtp']), 'DEBUG');
  assert.equal(effectiveLogLevel({ smtp: 'DEBUG', 'SMTP-Server': 'error' }, 'smtp-server', ['smtp']), 'ERROR');
  assert.equal(effectiveLogLevel({ all: 'INFO', x: 'bogus' }, 'imap-server'), 'INFO');
});

test('every service with a runtime log level is listed once', () => {
  const keys = LOG_LEVEL_SERVICES.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.includes('api-gateway') && keys.includes('backup-service'));
});
