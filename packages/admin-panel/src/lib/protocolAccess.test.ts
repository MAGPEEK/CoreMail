import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedSettings, effectiveOf, locksOutWebmail, PROTOCOLS, settingsForLevel, type ProtocolSettings } from './protocolAccess.ts';

const inherit = (): ProtocolSettings => Object.fromEntries(PROTOCOLS.map((p) => [p, 'inherit'])) as ProtocolSettings;

test('effective value: inherit follows the broader level, on/off override it', () => {
  assert.equal(effectiveOf('inherit', true), true);
  assert.equal(effectiveOf('inherit', false), false);
  assert.equal(effectiveOf('on', false), true);
  assert.equal(effectiveOf('off', true), false);
});

test('the server level offers on / off only, domain and mailbox also inherit', () => {
  assert.deepEqual(settingsForLevel('global'), ['on', 'off']);
  assert.deepEqual(settingsForLevel('domain'), ['inherit', 'on', 'off']);
  assert.deepEqual(settingsForLevel('user'), ['inherit', 'on', 'off']);
});

test('a save sends only the switches that changed', () => {
  const saved = { ...inherit(), imap: 'off' as const };
  assert.deepEqual(changedSettings(saved, saved), {});
  assert.deepEqual(changedSettings(saved, { ...saved, imap: 'inherit', mapi: 'on' }), { imap: 'inherit', mapi: 'on' });
});

test('Webmail off on the server or a domain level is flagged (user level is not)', () => {
  const draft = { ...inherit(), webmail: 'off' as const };
  const inherited = Object.fromEntries(PROTOCOLS.map((p) => [p, true])) as Record<(typeof PROTOCOLS)[number], boolean>;
  assert.equal(locksOutWebmail({ level: 'global', inherited }, draft), true);
  assert.equal(locksOutWebmail({ level: 'domain', inherited }, draft), true);
  assert.equal(locksOutWebmail({ level: 'user', inherited }, draft), false);
  assert.equal(locksOutWebmail({ level: 'domain', inherited }, inherit()), false);
});
