import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRetentionDays, policyBody, tagChangePlan } from './retention.ts';

test('tag plan: removals and additions are separated (DPT swap = remove old, then add new)', () => {
  assert.deepEqual(tagChangePlan(['dpt-old', 'rpt'], ['rpt', 'dpt-new']), { toRemove: ['dpt-old'], toAdd: ['dpt-new'] });
  assert.deepEqual(tagChangePlan([], []), { toRemove: [], toAdd: [] });
});

test('policy body: editing keeps the legacy fields of the stored policy', () => {
  const form = { name: ' Legacy ', description: 'd', enabled: true };
  assert.deepEqual(policyBody(form, true), { name: 'Legacy', description: 'd', enabled: true });
  assert.deepEqual(policyBody(form, false), { name: 'Legacy', description: 'd', enabled: true, retentionDays: 0, action: 'ARCHIVE', scope: 'ALL_ITEMS' });
});

test('retention days input', () => {
  assert.equal(parseRetentionDays('365'), 365);
  assert.equal(parseRetentionDays(''), null);
  assert.equal(parseRetentionDays('0'), null);
  assert.equal(parseRetentionDays('1.5'), null);
  assert.equal(parseRetentionDays('-3'), null);
});
