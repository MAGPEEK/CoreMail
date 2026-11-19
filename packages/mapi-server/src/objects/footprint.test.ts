/** Session memory accounting (objects/footprint.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionFootprint, valueBytes } from './footprint.js';
import type { LogonState, MessageState, ServerObject, StreamState } from './state.js';

const logon = {} as LogonState;

function message(): MessageState {
  return {
    folderCounter: 1n, counter: 1n, summary: null, props: new Map([[0x0037001f, 'abcd']]), recipients: [],
    attachments: [{ num: 0, props: new Map(), record: null, data: Buffer.alloc(1000), saved: true }],
    nextAttachNum: 1, readOnly: false, contentLoaded: true, submitted: false, associated: false, imported: null,
  };
}

test('valueBytes: strings as UTF-16, buffers by length, lists summed, scalars 8', () => {
  assert.equal(valueBytes('abc'), 6);
  assert.equal(valueBytes(Buffer.alloc(10)), 10);
  assert.equal(valueBytes(['a', 'bb']), 6);
  assert.equal(valueBytes(42), 8);
});

test('sessionFootprint: a message reached through several objects and a shared buffer count once', () => {
  const m = message();
  const att = m.attachments[0]!;
  const stream: StreamState = {
    target: { kind: 'attachment', message: m, attachment: att }, tag: 0x37010102, data: att.data!, size: 1000,
    position: 0, writable: false, dirty: false,
  };
  const one: ServerObject[] = [{ kind: 'message', logon, message: m }];
  const many: ServerObject[] = [
    ...one, { kind: 'attachment', logon, message: m, attachment: att }, { kind: 'stream', logon, stream },
  ];
  assert.equal(sessionFootprint(one), 8 + 8 + 1000);
  assert.equal(sessionFootprint(many), sessionFootprint(one));
  const own: StreamState = { ...stream, data: Buffer.alloc(500) };
  assert.equal(sessionFootprint([...many, { kind: 'stream', logon, stream: own }]), sessionFootprint(one) + 500);
  assert.equal(sessionFootprint([{ kind: 'folder', logon, counter: 1n }]), 0);
});
