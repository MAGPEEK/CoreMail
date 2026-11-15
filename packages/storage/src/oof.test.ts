/** OOF period id (v8.1): a new period when OOF is switched on or its texts/schedule change. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';

const { emptyDb, createFake } = await import('./test-support/mailbox-fake.js');
const db = emptyDb();
(globalThis as unknown as { __prisma: unknown }).__prisma = createFake(db);
const { nextOofPeriodId, saveOofSettings, OOF_FIELD_DEFAULTS } = await import('./oof.js');

const ON = { ...OOF_FIELD_DEFAULTS, oofEnabled: true, oofInternal: 'away', oofExternal: 'away (ext)' };
let n = 0;
const gen = (): string => `p${++n}`;

test('period id: new on enable and on text/schedule change, kept otherwise', () => {
  assert.equal(nextOofPeriodId(null, OOF_FIELD_DEFAULTS, gen), '', 'disabled: no period');
  const p1 = nextOofPeriodId(null, ON, gen);
  assert.equal(p1, 'p1');
  const stored = { ...ON, oofPeriodId: p1 };
  assert.equal(nextOofPeriodId(stored, { ...ON }, gen), p1, 'unchanged');
  assert.equal(nextOofPeriodId(stored, { ...ON, oofExternalOnlyContacts: true }, gen), p1, 'audience switch keeps the period');
  assert.equal(nextOofPeriodId(stored, { ...ON, oofInternal: 'new text' }, gen), 'p2');
  assert.equal(nextOofPeriodId(stored, { ...ON, oofUseTimeRange: true, oofStart: new Date(1), oofEnd: new Date(2) }, gen), 'p3');
  assert.equal(nextOofPeriodId({ ...ON, oofEnabled: false, oofPeriodId: p1 }, ON, gen), 'p4', 're-enabling starts a new period');
  assert.equal(nextOofPeriodId(stored, { ...ON, oofEnabled: false }, gen), p1, 'switching off keeps the old id');
});

test('saveOofSettings upserts the fields and maintains the period id', async () => {
  const a = await saveOofSettings('u1', ON);
  assert.ok(a);
  assert.equal(db.userSettings[0]!['oofPeriodId'], a);
  assert.equal(await saveOofSettings('u1', ON), a);
  await saveOofSettings('u1', { ...ON, oofEnabled: false });
  const c = await saveOofSettings('u1', ON);
  assert.notEqual(c, a);
  assert.equal(db.userSettings.length, 1);
});
