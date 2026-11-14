import { test } from 'node:test';
import assert from 'node:assert/strict';

// common.ts pulls in @coremail/storage indirectly; give it an inert Prisma
// stand-in so no real client (and query engine) is created during the test.
(globalThis as Record<string, unknown>)['__prisma'] ??= { $on: () => undefined };

const { applyPatch } = await import('./common.js');
const { MethodError } = await import('../errors.js');

function isInvalidPatch(err: unknown): boolean {
  return err instanceof MethodError && err.type === 'invalidPatch';
}

test('applyPatch sets a nested value', () => {
  const out = applyPatch({ keywords: { $seen: true } }, { 'keywords/$flagged': true });
  assert.deepEqual(out, { keywords: { $seen: true, $flagged: true } });
});

test('applyPatch removes a value patched to null', () => {
  assert.deepEqual(applyPatch({ keywords: { $seen: true } }, { 'keywords/$seen': null }), { keywords: {} });
});

test('applyPatch unescapes ~1 and ~0 in path segments', () => {
  const out = applyPatch({ mailboxIds: {} }, { 'mailboxIds/a~1b~0c': true });
  assert.deepEqual(out, { mailboxIds: { 'a/b~c': true } });
});

test('applyPatch does not modify the input object', () => {
  const base = { keywords: { $seen: true } };
  applyPatch(base, { 'keywords/$seen': null });
  assert.deepEqual(base, { keywords: { $seen: true } });
});

for (const path of ['keywords/__proto__/polluted', '__proto__/polluted', 'keywords/constructor/prototype/polluted', 'prototype']) {
  test(`applyPatch rejects "${path}" and leaves Object.prototype untouched`, () => {
    assert.throws(() => applyPatch({ keywords: {} }, { [path]: true }), isInvalidPatch);
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
  });
}

test('applyPatch rejects walking through an inherited member', () => {
  // "toString" exists on every object via the prototype, but not as an own property.
  assert.throws(() => applyPatch({ keywords: {} }, { 'keywords/toString/x': true }), isInvalidPatch);
});

test('applyPatch rejects a path through a missing parent', () => {
  assert.throws(() => applyPatch({ keywords: {} }, { 'missing/x': true }), isInvalidPatch);
});
