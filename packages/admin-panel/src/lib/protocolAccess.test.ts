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

test('w2b: effective reason — an explicit switch decides on its own level, inherit names where it comes from', async () => {
  const { effectiveReason } = await import('./protocolAccess.ts');
  const from = (v: 'server' | 'domain') => Object.fromEntries(PROTOCOLS.map((p) => [p, v])) as Record<(typeof PROTOCOLS)[number], 'server' | 'domain'>;
  assert.equal(effectiveReason({ level: 'global' }, 'imap', 'off'), 'server');
  assert.equal(effectiveReason({ level: 'domain' }, 'imap', 'off'), 'domain');
  assert.equal(effectiveReason({ level: 'domain' }, 'imap', 'inherit'), 'server');
  assert.equal(effectiveReason({ level: 'user', inheritedFrom: from('domain') }, 'imap', 'inherit'), 'domain');
  assert.equal(effectiveReason({ level: 'user', inheritedFrom: from('server') }, 'imap', 'inherit'), 'server');
  assert.equal(effectiveReason({ level: 'user', inheritedFrom: from('server') }, 'imap', 'on'), 'user');
  assert.equal(effectiveReason({ level: 'user' }, 'imap', 'inherit'), null, 'older server: no reason shown');
});
