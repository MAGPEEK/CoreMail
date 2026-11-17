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
// The dispatcher is the HANDLERS table: one `Command: { needsBody, run }` entry per command.
const start = server.indexOf('const HANDLERS');
assert.ok(start > 0, 'HANDLERS table not found in server.ts');
const dispatcher = server.slice(start, server.indexOf('\n};', start));
const cases = [...dispatcher.matchAll(/^ {2}(\w+): \{/gm)].map((m) => m[1]!);
const stubBlock = /((?:^ {2}\w+: \{[^\n]*\n)+)\s*\/\/ Return empty success/m.exec(dispatcher)?.[1] ?? '';
const stubs = [...stubBlock.matchAll(/^ {2}(\w+): \{/gm)].map((m) => m[1]!);

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

test('OPTIONS announces every implemented protocol version (12.1, 14.0, 14.1)', () => {
  assert.match(server, /res\.setHeader\('MS-ASProtocolVersions', EAS_VERSIONS\.join\(','\)\)/);
  assert.doesNotMatch(server, /'14\.0,14\.1'/);
});

test('12.1 compose commands take a MIME body (no WBXML decode), every other command WBXML', () => {
  for (const c of ['SendMail', 'SmartReply', 'SmartForward']) {
    assert.match(dispatcher, new RegExp(`^ {2}${c}: \\{ needsBody: true, mimeBody: legacyCompose, run: compose\\('${c}'\\) \\}`, 'm'), c);
  }
  assert.equal([...dispatcher.matchAll(/mimeBody:/g)].length, 3);
});

test('the dispatcher has no empty-200 stub left', () => {
  assert.deepEqual(stubs, []);
  assert.ok(!/Return empty success/.test(dispatcher), 'empty-success stub must not come back');
});
