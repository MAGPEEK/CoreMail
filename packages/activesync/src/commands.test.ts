/**
 * OPTIONS / MS-ASProtocolCommands advertises exactly the commands that have a
 * real handler in the dispatcher (server.ts) — never an empty-200 stub.
 * Run: node --import tsx --test src/commands.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EAS_COMMANDS } from './commands.js';

const server = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
const dispatcher = server.slice(server.indexOf("switch (command) {"), server.indexOf('default:', server.indexOf("switch (command) {")));
const cases = [...dispatcher.matchAll(/case '(\w+)':/g)].map((m) => m[1]!);
const stubBlock = /((?:case '\w+':\s*)+)\/\/ Return empty success/.exec(dispatcher)?.[1] ?? '';
const stubs = [...stubBlock.matchAll(/case '(\w+)':/g)].map((m) => m[1]!);

test('every advertised command is dispatched and none is an empty-200 stub', () => {
  for (const c of EAS_COMMANDS) {
    assert.ok(cases.includes(c), `${c} advertised but not dispatched`);
    assert.ok(!stubs.includes(c), `${c} advertised but answered by the empty stub`);
  }
});

test('every implemented command is advertised', () => {
  const implemented = cases.filter((c) => !stubs.includes(c));
  assert.deepEqual([...implemented].sort(), [...EAS_COMMANDS].sort());
});

test('the new 14.1 commands are advertised', () => {
  for (const c of ['Settings', 'Search', 'MoveItems', 'MeetingResponse', 'ResolveRecipients', 'GetItemEstimate', 'ItemOperations']) assert.ok(EAS_COMMANDS.includes(c), c);
});

test('the dispatcher has no empty-200 stub left', () => {
  assert.deepEqual(stubs, []);
  assert.ok(!/Return empty success/.test(dispatcher), 'empty-success stub must not come back');
});
