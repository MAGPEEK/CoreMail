import { test } from 'node:test';
import assert from 'node:assert/strict';

// @coremail/core validates the environment on import.
process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['NODE_ENV'] = 'test';

const { createLogger, setLogLevel, getLogLevel, normalizeLogLevel, logger } = await import('./index.js');
const { resolveServiceLogLevel, initRuntimeLogLevel, LOG_LEVELS_HASH, CHANNEL_LOG_LEVELS } = await import('./runtime.js');

test('normalizeLogLevel accepts the BCP spellings only', () => {
  assert.equal(normalizeLogLevel('DEBUG'), 'debug');
  assert.equal(normalizeLogLevel(' Warn '), 'warn');
  assert.equal(normalizeLogLevel('trace'), null);
  assert.equal(normalizeLogLevel(3), null);
});

test('resolveServiceLogLevel: exact name, alias, wildcard, none', () => {
  assert.equal(resolveServiceLogLevel({ 'smtp-server': 'DEBUG', '*': 'ERROR' }, 'smtp-server', ['smtp']), 'debug');
  assert.equal(resolveServiceLogLevel({ smtp: 'WARN' }, 'smtp-server', ['smtp']), 'warn');
  assert.equal(resolveServiceLogLevel({ ALL: 'error' }, 'imap-server'), 'error');
  assert.equal(resolveServiceLogLevel({ 'imap-server': 'DEBUG' }, 'smtp-server', ['smtp']), null);
  assert.equal(resolveServiceLogLevel({ 'smtp-server': 'bogus', '*': 'INFO' }, 'smtp-server'), 'info');
});

test('setLogLevel changes existing and nested child loggers at runtime', () => {
  const a = createLogger('svc-a');
  const nested = a.child({ sub: 1 });
  setLogLevel('error');
  assert.equal(getLogLevel(), 'error');
  assert.equal(a.level, 'error');
  assert.equal(nested.level, 'error');
  assert.equal(a.isLevelEnabled('info'), false);
  setLogLevel('debug');
  assert.equal(a.level, 'debug');
  assert.equal(nested.isLevelEnabled('debug'), true);
  // loggers created later inherit the current root level
  assert.equal(createLogger('svc-b').level, 'debug');
  setLogLevel('info');
  assert.equal(logger.level, 'info');
});

test('initRuntimeLogLevel applies the stored level and follows published updates', async () => {
  let onMessage: ((ch: string, msg: string) => void) | null = null;
  let subscribed = '';
  const fakeSub = {
    on: (_ev: string, fn: (ch: string, msg: string) => void) => { onMessage = fn; },
    subscribe: async (ch: string) => { subscribed = ch; },
    quit: async () => 'OK',
  };
  const fakeRedis = {
    hgetall: async (key: string) => (key === LOG_LEVELS_HASH ? { 'smtp-server': 'WARN' } : {}),
    duplicate: () => fakeSub,
  };
  const handle = await initRuntimeLogLevel('smtp-server', { aliases: ['smtp'], redis: fakeRedis as never });
  const log = createLogger('smtp:test');
  assert.equal(log.level, 'warn');
  assert.equal(subscribed, CHANNEL_LOG_LEVELS);

  onMessage!(CHANNEL_LOG_LEVELS, JSON.stringify({ smtp: 'DEBUG' }));
  assert.equal(log.level, 'debug');
  // update for another service is ignored
  onMessage!(CHANNEL_LOG_LEVELS, JSON.stringify({ 'imap-server': 'ERROR' }));
  assert.equal(log.level, 'debug');
  // malformed payload is ignored
  onMessage!(CHANNEL_LOG_LEVELS, '{nope');
  assert.equal(log.level, 'debug');
  await handle.stop();
  setLogLevel('info');
});
