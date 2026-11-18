/** Server object handle table lifecycle (MS-OXCROPS 3.2.5.1, 3.2.5.3, 3.2.5.4). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerObjectTable, HANDLE_UNUSED, MAX_OPEN_OBJECTS } from './handles.js';
import { Ec, RopError } from './codes.js';
import type { LogonState, ServerObject } from '../objects/state.js';

const logon = { logonId: 0 } as LogonState;
const folder = (n: number): ServerObject => ({ kind: 'folder', logon, counter: BigInt(n) });

function code(fn: () => unknown): number {
  try { fn(); } catch (err) { return (err as RopError).code; }
  return 0;
}

test('handles are assigned, resolved and released; never 0xFFFFFFFF', () => {
  const t = new ServerObjectTable();
  const a = t.add(folder(1), 0);
  const b = t.add(folder(2), 0);
  assert.notEqual(a, b);
  assert.notEqual(a, HANDLE_UNUSED);
  assert.deepEqual(t.get(a), folder(1));
  assert.equal(t.release(a)?.kind, 'folder');
  assert.equal(t.size, 1);
});

test('a released handle is ecInvalidObject, a never-issued one ecNullObject', () => {
  const t = new ServerObjectTable();
  const a = t.add(folder(1), 0);
  t.release(a);
  assert.equal(code(() => t.get(a)), Ec.InvalidObject);
  assert.equal(code(() => t.get(9999)), Ec.NullObject);
});

test('releasing a logon releases every object of that logon only', () => {
  const t = new ServerObjectTable();
  t.add(folder(1), 0);
  t.add(folder(2), 0);
  const other = t.add(folder(3), 1);
  assert.equal(t.releaseLogon(0).length, 2);
  assert.equal(t.size, 1);
  assert.deepEqual(t.get(other), folder(3));
});

test('the number of open objects per session is capped', () => {
  const t = new ServerObjectTable();
  for (let i = 0; i < MAX_OPEN_OBJECTS; i++) t.add(folder(i), 0);
  assert.equal(code(() => t.add(folder(0), 0)), Ec.OutOfMemory);
});
