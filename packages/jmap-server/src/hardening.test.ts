import { test } from 'node:test';
import assert from 'node:assert/strict';
import { corsHeadersFor, parseOriginList, normalizeOrigin } from './cors.js';
import { createsParentCycle } from './methods/mailbox-tree.js';
import { parseRequest, processRequest, registerMethod } from './dispatcher.js';
import { CAP_CORE } from './capabilities.js';
import { checkPublicHttpsUrlSyntax, assertPublicHttpsUrl } from '@coremail/core';
import type { AccountContext, JmapUser } from './types.js';

test('CORS: credentials only for allow-listed origins, never reflected for others', () => {
  const allowed = ['https://mail.example.de', ...parseOriginList('https://webmail.example.de, nonsense, null')];
  assert.deepEqual(allowed, ['https://mail.example.de', 'https://webmail.example.de']);
  const own = corsHeadersFor('https://MAIL.example.de', allowed);
  assert.equal(own['Access-Control-Allow-Origin'], 'https://mail.example.de');
  assert.equal(own['Access-Control-Allow-Credentials'], 'true');
  const evil = corsHeadersFor('https://evil.example', allowed);
  assert.equal(evil['Access-Control-Allow-Origin'], '*');
  assert.equal(evil['Access-Control-Allow-Credentials'], undefined);
  const nullOrigin = corsHeadersFor('null', allowed);
  assert.equal(nullOrigin['Access-Control-Allow-Credentials'], undefined);
  assert.equal(corsHeadersFor(undefined, allowed)['Access-Control-Allow-Origin'], '*');
  assert.equal(corsHeadersFor('https://mail.example.de:8443', allowed)['Access-Control-Allow-Credentials'], undefined);
  assert.equal(normalizeOrigin('javascript:alert(1)'), null);
});

test('Mailbox parent cycles are detected', () => {
  const tree = [
    { id: 'a', parentId: null }, { id: 'b', parentId: 'a' }, { id: 'c', parentId: 'b' }, { id: 'x', parentId: null },
  ];
  assert.equal(createsParentCycle(tree, 'a', 'c'), true);   // a under its grandchild
  assert.equal(createsParentCycle(tree, 'a', 'b'), true);
  assert.equal(createsParentCycle(tree, 'a', 'a'), true);
  assert.equal(createsParentCycle(tree, 'c', 'x'), false);
  assert.equal(createsParentCycle(tree, 'b', null), false);
  assert.equal(createsParentCycle([{ id: 'p', parentId: 'q' }, { id: 'q', parentId: 'p' }], 'z', 'p'), true); // existing loop
});

test('dispatcher does not leak internal error messages', async () => {
  registerMethod('Test/boom', CAP_CORE, async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:5432 — relation "users" does not exist'); });
  const user: JmapUser = { userId: 'u1', email: 'a@b.de', displayName: 'A', domainId: 'd', role: 'USER' };
  const accounts = new Map<string, AccountContext>();
  const res = await processRequest(parseRequest({ using: [CAP_CORE], methodCalls: [['Test/boom', {}, 'c0']] }), user, accounts, 's');
  const [name, args] = res.methodResponses[0]!;
  assert.equal(name, 'error');
  assert.equal((args as { type: string }).type, 'serverFail');
  assert.doesNotMatch(String((args as { description: string }).description), /ECONNREFUSED|relation|10\.0\.0\.5/);
  assert.match(String((args as { description: string }).description), /ref [0-9a-f-]{36}/);
});

test('PushSubscription URL SSRF rules', async () => {
  for (const u of ['http://push.example.com/x', 'https://127.0.0.1/', 'https://[::ffff:169.254.169.254]/', 'https://10.1.2.3/']) {
    assert.throws(() => checkPublicHttpsUrlSyntax(u), u);
  }
  await assert.rejects(assertPublicHttpsUrl('https://push.attacker.example/', async () => ['192.168.0.10']));
  await assert.doesNotReject(assertPublicHttpsUrl('https://push.service.example/', async () => ['93.184.216.34']));
});
