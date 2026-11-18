/**
 * `coremail policy` helpers (9.4): option → PUT body per level, table rows.
 * Run: node --import tsx --test src/commands/policy.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPolicyPatch, flagOf, policyRows, FEATURES, type PolicyView } from './policy.js';

test('flags: camelCase modules become kebab-case options', () => {
  assert.equal(flagOf('recoverItems'), 'recover-items');
  assert.equal(flagOf('calendar'), 'calendar');
});

test('patch: modules and values, validated per level', () => {
  assert.deepEqual(buildPolicyPatch({ calendar: 'OFF', recoverItems: 'inherit', externalImages: 'Contacts' }, 'user'),
    { features: { calendar: 'off', recoverItems: 'inherit' }, content: { externalImages: 'contacts' } });
  assert.deepEqual(buildPolicyPatch({ blockedExtensions: 'EXE, .js;js', maxUploadMb: '20' }, 'global'),
    { content: { blockedExtensions: ['exe', 'js'], maxUploadMb: 20 } });
  assert.deepEqual(buildPolicyPatch({ blockedExtensions: 'inherit', maxUploadMb: 'inherit', externalImages: 'inherit' }, 'domain'),
    { content: { blockedExtensions: null, maxUploadMb: null, externalImages: null } });
  assert.deepEqual(buildPolicyPatch({ maxUploadMb: 'none', saveOnlyExtensions: 'none' }, 'global'),
    { content: { maxUploadMb: null, downloadOnlyExtensions: [] } });
});

test('patch: invalid values and empty calls are refused', () => {
  assert.throws(() => buildPolicyPatch({ calendar: 'inherit' }, 'global'), /--calendar: on, off on the global level/);
  assert.throws(() => buildPolicyPatch({ blockedExtensions: 'inherit' }, 'global'), /inherit only with --scope/);
  assert.throws(() => buildPolicyPatch({ maxUploadMb: 'none' }, 'user'), /inherit or MB on the user level/);
  assert.throws(() => buildPolicyPatch({ maxUploadMb: '0' }, 'global'), /1\.\.10240/);
  assert.throws(() => buildPolicyPatch({ externalImages: 'sometimes' }, 'domain'), /--external-images/);
  assert.throws(() => buildPolicyPatch({}, 'user'), /Nothing to set/);
});

test('rows: inherit shows what it resolves to, with the deciding level', () => {
  const all = <T>(v: T) => Object.fromEntries(FEATURES.map((f) => [f, v])) as Record<(typeof FEATURES)[number], T>;
  const content = { blockedExtensions: ['exe'], downloadOnlyExtensions: [], maxUploadMb: 10, externalImages: 'block' };
  const view: PolicyView = {
    level: 'user',
    settings: { features: { ...all('inherit' as const), notes: 'off' }, content: { blockedExtensions: null, downloadOnlyExtensions: null, maxUploadMb: null, externalImages: null } },
    inherited: { features: all(true), content },
    effective: { features: { ...all(true), notes: false }, content },
    sources: { features: { ...all('default' as const), notes: 'user' }, content: { blockedExtensions: 'global', downloadOnlyExtensions: 'default', maxUploadMb: 'global', externalImages: 'global' } },
  };
  const rows = policyRows(view);
  assert.deepEqual(rows.find((r) => r['name'] === 'notes'), { name: 'notes', setting: 'off', effective: 'off', source: 'user' });
  assert.deepEqual(rows.find((r) => r['name'] === 'calendar'), { name: 'calendar', setting: 'inherit (on)', effective: 'on', source: 'default' });
  assert.deepEqual(rows.find((r) => r['name'] === 'blocked-extensions'), { name: 'blocked-extensions', setting: 'inherit (exe)', effective: 'exe', source: 'global' });
  assert.deepEqual(rows.find((r) => r['name'] === 'max-upload-mb'), { name: 'max-upload-mb', setting: 'inherit', effective: 10, source: 'global' });
  assert.deepEqual(rows.find((r) => r['name'] === 'external-images'), { name: 'external-images', setting: 'inherit (block)', effective: 'block', source: 'global' });
});
