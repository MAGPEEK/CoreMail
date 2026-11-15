import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandReader, type CommandReaderHooks, type LiteralDecision } from './command-reader.js';
import type { CommandSegment } from './tokenizer.js';

interface Harness {
  reader: CommandReader;
  commands: CommandSegment[][];
  events: string[];
}

function harness(overrides: Partial<CommandReaderHooks> & { decide?: LiteralDecision } = {}): Harness {
  const commands: CommandSegment[][] = [];
  const events: string[] = [];
  const reader = new CommandReader({
    maxLineLength: 64,
    maxLiteralSize: () => 100,
    literalsAllowed: () => true,
    onCommand: async (segments) => { commands.push(segments); events.push('command'); },
    onLiteral: async (_s, size, sync, tooLarge) => {
      events.push(`literal ${size} ${sync ? 'sync' : 'nonsync'}${tooLarge ? ' toolarge' : ''}`);
      return overrides.decide ?? (tooLarge ? (sync ? 'drop' : 'close') : 'continue');
    },
    sendContinuation: () => { events.push('+'); },
    onLineTooLong: () => { events.push('too long'); },
    ...overrides,
  });
  return { reader, commands, events };
}

const text = (segments: CommandSegment[]): string[] =>
  segments.map((s) => (typeof s === 'string' ? s : `<${s.toString('utf8')}>`));

test('emits one command per CRLF-terminated line, also across chunk boundaries', async () => {
  const { reader, commands } = harness();
  reader.push(Buffer.from('A1 NO'));
  reader.push(Buffer.from('OP\r\nA2 NOOP\r\n'));
  await reader.idle();
  assert.deepEqual(commands.map(text), [['A1 NOOP'], ['A2 NOOP']]);
});

test('a synchronizing literal triggers a continuation and is read byte-exact', async () => {
  const { reader, commands, events } = harness();
  reader.push(Buffer.from('A1 APPEND INBOX {5}\r\n'));
  await reader.idle();
  assert.deepEqual(events, ['literal 5 sync', '+']);
  reader.push(Buffer.from('he\r\nl'));
  reader.push(Buffer.from('\r\n'));
  await reader.idle();
  assert.deepEqual(commands.map(text), [['A1 APPEND INBOX {5}', '<he\r\nl>', '']]);
});

test('a non-synchronizing literal is read without continuation', async () => {
  const { reader, commands, events } = harness();
  reader.push(Buffer.from('A1 LOGIN {3+}\r\nbob {2+}\r\npw\r\n'));
  await reader.idle();
  assert.ok(!events.includes('+'));
  assert.deepEqual(commands.map(text), [['A1 LOGIN {3+}', '<bob>', ' {2+}', '<pw>', '']]);
});

test('"drop" discards a synchronizing command and continues with the next one', async () => {
  const { reader, commands, events } = harness({ decide: 'drop' });
  reader.push(Buffer.from('A1 APPEND Nope {5}\r\nA2 NOOP\r\n'));
  await reader.idle();
  assert.ok(!events.includes('+'));
  assert.deepEqual(commands.map(text), [['A2 NOOP']]);
});

test('an oversized non-synchronizing literal closes the reader', async () => {
  const { reader, commands, events } = harness();
  reader.push(Buffer.from('A1 APPEND INBOX {500+}\r\nxxxx'));
  await reader.idle();
  assert.deepEqual(events, ['literal 500 nonsync toolarge']);
  assert.equal(reader.isClosed, true);
  assert.deepEqual(commands, []);
});

test('an unterminated line above the limit is reported and closes the reader', async () => {
  const { reader, events } = harness();
  reader.push(Buffer.from('x'.repeat(65)));
  await reader.idle();
  assert.deepEqual(events, ['too long']);
  assert.equal(reader.isClosed, true);
});

test('pipelined commands are processed strictly one after the other', async () => {
  const order: string[] = [];
  const { reader } = harness({
    onCommand: async (segments) => {
      const line = String(segments[0]);
      order.push(`start ${line}`);
      await new Promise((resolve) => setTimeout(resolve, line.startsWith('A1') ? 20 : 0));
      order.push(`end ${line}`);
    },
  });
  reader.push(Buffer.from('A1 SELECT INBOX\r\nA2 FETCH 1 UID\r\n'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  await reader.idle();
  assert.deepEqual(order, ['start A1 SELECT INBOX', 'end A1 SELECT INBOX', 'start A2 FETCH 1 UID', 'end A2 FETCH 1 UID']);
});

test('literal markers are ignored while literals are not allowed (IDLE/SASL)', async () => {
  const { reader, commands, events } = harness({ literalsAllowed: () => false });
  reader.push(Buffer.from('abc {5}\r\n'));
  await reader.idle();
  assert.deepEqual(events, ['command']);
  assert.deepEqual(commands.map(text), [['abc {5}']]);
});

test('a CRLF split across two chunks still ends the line', async () => {
  const { reader, commands } = harness();
  reader.push(Buffer.from('A1 NOOP\r'));
  await reader.idle();
  assert.deepEqual(commands, []);
  reader.push(Buffer.from('\nA2 NOOP\r\n'));
  await reader.idle();
  assert.deepEqual(commands.map(text), [['A1 NOOP'], ['A2 NOOP']]);
});

test('a literal arriving in many small chunks is merged once, not re-concatenated per chunk', async () => {
  const { reader, commands } = harness({ maxLiteralSize: () => 1_000_000 });
  reader.push(Buffer.from('A1 APPEND INBOX {100000+}\r\n'));
  await reader.idle();
  const original = Buffer.concat;
  let concats = 0;
  Buffer.concat = ((list: readonly Uint8Array[], len?: number) => { concats++; return original(list, len); }) as typeof Buffer.concat;
  try {
    for (let i = 0; i < 1000; i++) reader.push(Buffer.alloc(100, 0x61));
    reader.push(Buffer.from('\r\n'));
    await reader.idle();
  } finally {
    Buffer.concat = original;
  }
  assert.equal(commands.length, 1);
  const literal = commands[0]![1] as Buffer;
  assert.equal(literal.length, 100_000);
  assert.ok(concats <= 3, `expected a bounded number of merges, got ${concats}`);
});

test('limits are read per decision (tighter caps before authentication)', async () => {
  let authenticated = false;
  const events: string[] = [];
  const reader = new CommandReader({
    maxLineLength: () => (authenticated ? 64 : 16),
    maxLiteralSize: () => (authenticated ? 100 : 8),
    literalsAllowed: () => true,
    onCommand: async () => { events.push('command'); authenticated = true; },
    onLiteral: async (_s, size, sync, tooLarge) => {
      events.push(`literal ${size}${tooLarge ? ' toolarge' : ''}`);
      return tooLarge ? (sync ? 'drop' : 'close') : 'continue';
    },
    sendContinuation: () => { events.push('+'); },
    onLineTooLong: () => { events.push('too long'); },
  });
  reader.push(Buffer.from('a LOGIN {9}\r\n'));
  await reader.idle();
  assert.deepEqual(events, ['literal 9 toolarge']);
  reader.push(Buffer.from('a NOOP\r\nb APPEND INBOX {50}\r\n'));
  await reader.idle();
  assert.deepEqual(events, ['literal 9 toolarge', 'command', 'literal 50', '+']);
});

test('an unterminated line above a dynamic cap closes the reader and frees the buffer', async () => {
  const events: string[] = [];
  const reader = new CommandReader({
    maxLineLength: () => 16,
    maxLiteralSize: () => 8,
    literalsAllowed: () => true,
    onCommand: async () => { events.push('command'); },
    onLiteral: async () => 'continue',
    sendContinuation: () => undefined,
    onLineTooLong: () => { events.push('too long'); },
  });
  for (let i = 0; i < 5; i++) reader.push(Buffer.from('xxxx'));
  await reader.idle();
  assert.deepEqual(events, ['too long']);
  assert.equal(reader.isClosed, true);
  assert.equal(reader.bufferedBytes, 0);
});

test('endless "{0+}" continuations of one command are cut off', async () => {
  const { reader, events } = harness();
  for (let i = 0; i < 200; i++) reader.push(Buffer.from('A1 X {0+}\r\n'));
  await reader.idle();
  assert.equal(events.at(-1), 'too long');
  assert.equal(reader.isClosed, true);
});
