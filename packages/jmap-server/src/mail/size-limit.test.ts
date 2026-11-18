/**
 * 9.4: EmailSubmission/set create, Email/import and Email/set create refuse a message
 * above the configured maximum size with SetError tooLarge + maxSize (RFC 8621 §7.5).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const MB = 1024 * 1024;
(globalThis as unknown as { __prisma: unknown }).__prisma = {
  $on: () => undefined,
  smtpSettings: { findUnique: async () => ({ maxMessageSizeMb: 2 }) },
  serverSettings: { findUnique: async () => ({ maxMessageSizeMb: 10 }) },
};

const { assertMessageSize, messageTooLarge } = await import('./size-limit.js');

test('messageTooLarge: type tooLarge with maxSize in octets', () => {
  const e = messageTooLarge(2 * MB);
  assert.equal(e.type, 'tooLarge');
  assert.equal(e['maxSize'], 2 * MB);
  assert.match(String(e.description), /2097152 octets/);
});

test('assertMessageSize: the stricter configured limit (SMTP 2 MB) applies', async () => {
  await assertMessageSize(2 * MB); // exactly at the limit
  await assert.rejects(assertMessageSize(2 * MB + 1), (e: { type?: string; maxSize?: number }) =>
    e.type === 'tooLarge' && e.maxSize === 2 * MB);
});
