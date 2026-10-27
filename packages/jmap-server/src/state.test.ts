import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEmailState, encodeEmailState, decodeMailboxState, encodeMailboxState, hashState } from './state-codec.js';

test('Email-State round-trip', () => {
  const p = { maxModSeq: 1761580000000n, highestModSeq: 42n, maxCreatedMs: 1761580000123, count: 17 };
  assert.deepEqual(decodeEmailState(encodeEmailState(p)), p);
  assert.equal(decodeEmailState('garbage'), null);
  assert.equal(decodeEmailState(42), null);
});

test('Mailbox-State round-trip', () => {
  const p = { count: 8, maxCreatedMs: 1761580000000, hash: hashState(['a']) };
  assert.deepEqual(decodeMailboxState(encodeMailboxState(p)), p);
  assert.equal(decodeMailboxState('1.2.zzz'), null);
});
