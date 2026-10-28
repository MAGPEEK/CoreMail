import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest, processRequest, registerMethod } from './dispatcher.js';
import { RequestError } from './errors.js';
import { CAP_CORE } from './capabilities.js';
import type { AccountContext, JmapUser } from './types.js';

const user: JmapUser = { userId: 'u1', email: 'a@b.de', displayName: 'A', domainId: 'd', role: 'USER' };
const accounts = new Map<string, AccountContext>([['u1', {
  accountId: 'u1', mailboxId: 'm1', ownerUserId: 'u1', sharedMailboxId: null, name: 'A', email: 'a@b.de',
  readOnly: false, isPersonal: true, maySend: true,
}]]);

registerMethod('Test/echo', CAP_CORE, async (args) => args);
registerMethod('Test/list', CAP_CORE, async () => ({ list: [{ id: 'x', tags: ['a', 'b'] }, { id: 'y', tags: ['c'] }] }));

test('parseRequest rejects missing fields and unknown capabilities', () => {
  assert.throws(() => parseRequest({}), (e: unknown) => e instanceof RequestError && e.type === 'notRequest');
  assert.throws(() => parseRequest({ using: ['urn:x'], methodCalls: [] }), (e: unknown) => e instanceof RequestError && e.type === 'unknownCapability');
  const r = parseRequest({ using: [CAP_CORE], methodCalls: [['Core/echo', { a: 1 }, 'c0']] });
  assert.equal(r.methodCalls.length, 1);
});

test('unknownMethod for unregistered methods', async () => {
  const res = await processRequest(parseRequest({ using: [CAP_CORE], methodCalls: [['Nope/get', {}, 'c0']] }), user, accounts, 's');
  assert.deepEqual(res.methodResponses[0], ['error', { type: 'unknownMethod' }, 'c0']);
  assert.equal(res.sessionState, 's');
});

test('result references with JSON pointer and * are resolved', async () => {
  const res = await processRequest(parseRequest({
    using: [CAP_CORE],
    methodCalls: [
      ['Test/list', {}, 'c0'],
      ['Test/echo', { '#ids': { resultOf: 'c0', name: 'Test/list', path: '/list/*/id' } }, 'c1'],
      ['Test/echo', { '#tags': { resultOf: 'c0', name: 'Test/list', path: '/list/*/tags' } }, 'c2'],
      ['Test/echo', { '#bad': { resultOf: 'c0', name: 'Wrong/name', path: '/list' } }, 'c3'],
      ['Test/echo', { ids: [], '#ids': { resultOf: 'c0', name: 'Test/list', path: '/list' } }, 'c4'],
    ],
  }), user, accounts, 's');
  assert.deepEqual(res.methodResponses[1], ['Test/echo', { ids: ['x', 'y'] }, 'c1']);
  assert.deepEqual(res.methodResponses[2], ['Test/echo', { tags: ['a', 'b', 'c'] }, 'c2']);
  assert.equal(res.methodResponses[3]![0], 'error');
  assert.equal((res.methodResponses[3]![1] as { type: string }).type, 'invalidResultReference');
  assert.equal((res.methodResponses[4]![1] as { type: string }).type, 'invalidArguments');
});

test('createdIds are carried over and returned', async () => {
  const res = await processRequest(parseRequest({ using: [CAP_CORE], methodCalls: [['Test/echo', {}, 'c0']], createdIds: { a: 'real-a' } }), user, accounts, 's');
  assert.deepEqual(res.createdIds, { a: 'real-a' });
});
