/**
 * `coremail mailbox flow` / `shared flow` helpers (9.4): option → PUT body, table rows.
 * Run: node --import tsx --test src/commands/mail-flow.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFlowPatch, flowRows } from './mail-flow.js';

const exits = (fn: () => unknown, re: RegExp): void => {
  const exit = process.exit;
  const write = process.stderr.write;
  let msg = '';
  process.stderr.write = ((s: string) => { msg += s; return true; }) as typeof process.stderr.write;
  process.exit = ((code?: number) => { throw new Error(`exit ${code}: ${msg}`); }) as typeof process.exit;
  try { assert.throws(fn, re); } finally { process.exit = exit; process.stderr.write = write; }
};

test('only the given options; lists comma-separated, "none" clears, limits as numbers', () => {
  assert.deepEqual(buildFlowPatch({ hideGal: true, forward: 'boss@x.test', keepCopy: 'off', acceptFrom: 'x.test, a@y.test', maxSend: '10', maxRecipients: 'none' }, 'user'), {
    hiddenFromGal: true, forwardTo: 'boss@x.test', forwardKeepCopy: false, acceptFrom: ['x.test', 'a@y.test'], maxSendSizeMb: 10, maxRecipients: null,
  });
  assert.deepEqual(buildFlowPatch({ showGal: true, forward: 'none', rejectFrom: 'none' }, 'shared'), { hiddenFromGal: false, forwardTo: null, rejectFrom: [] });
  assert.deepEqual(buildFlowPatch({}, 'user'), {}, 'no options = show');
});

test('invalid combinations and values are refused', () => {
  exits(() => buildFlowPatch({ hideGal: true, showGal: true }, 'user'), /exclude each other/);
  exits(() => buildFlowPatch({ maxSend: '5' }, 'shared'), /user mailboxes only/);
  exits(() => buildFlowPatch({ keepCopy: 'maybe' }, 'user'), /on or off/);
  exits(() => buildFlowPatch({ maxReceive: '0' }, 'user'), /positive whole number/);
});

test('rows: lists joined, empty / null as a dash', () => {
  assert.deepEqual(flowRows({ hiddenFromGal: false, acceptFrom: [], rejectFrom: ['a.test', 'b.test'], forwardTo: null }), [
    { setting: 'hiddenFromGal', value: 'false' }, { setting: 'acceptFrom', value: '—' },
    { setting: 'rejectFrom', value: 'a.test, b.test' }, { setting: 'forwardTo', value: '—' },
  ]);
});
