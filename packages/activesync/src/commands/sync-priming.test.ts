/**
 * Regression (e2e 7.0.0): a Sync with SyncKey 0 must answer with a new SyncKey
 * and NO Commands ([MS-ASCMD] 2.2.3.166.4). CoreMail sent the whole folder in the
 * priming response and then an empty delta, so spec-following devices never got
 * the existing mail.
 * Run: node --import tsx --test src/commands/sync-priming.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';

const deviceUpdates: unknown[] = [];
(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  folder: { findFirst: async () => ({ id: 'inbox', mailboxId: 'mb1' }) },
  activeSyncDevice: {
    findUnique: async () => ({ id: 'd1', syncKeys: {} }),
    update: async (a: unknown) => { deviceUpdates.push(a); return {}; },
  },
  mailbox: { findUnique: async () => ({ highestModSeq: 5n }) },
  message: { findMany: async () => [{ id: 'm1', modSeq: 1n, flags: [], subject: 's', fromAddr: 'a@b', toAddrs: [], date: new Date(), bodyText: 'x', bodyHtml: '' }] },
};

const { handleSync } = await import('./sync.js');
const { decodeWbxml, el } = await import('../wbxml.js');
const { PRIMING_SYNC_KEY } = await import('./sync-window.js');

const req = (key: string) => el('Sync', undefined, [el('Collections', undefined, [el('Collection', undefined, [
  el('SyncKey', key), el('CollectionId', 'inbox'),
])])]);

test('SyncKey 0 → Status 1, priming SyncKey, no Commands', async () => {
  const out = decodeWbxml(await handleSync(req('0'), 'u1', 'dev1'));
  const json = JSON.stringify(out);
  assert.ok(!json.includes('"Commands"'), json);
  assert.ok(json.includes(`"name":"SyncKey","children":[],"text":"${PRIMING_SYNC_KEY}"`), json);
  assert.ok(json.includes('"name":"Status","children":[],"text":"1"'), json);
  assert.equal(deviceUpdates.length, 1);
});
// The follow-up Sync with PRIMING_SYNC_KEY returning the whole folder is covered
// in sync-window.test.ts ('priming key: …').
