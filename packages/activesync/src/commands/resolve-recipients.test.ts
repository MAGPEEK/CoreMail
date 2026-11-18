/**
 * ResolveRecipients: GAL (own domain) + own contacts, Status 1/2/4,
 * minimal Availability / Certificates answers.
 * Run: node --import tsx --test src/commands/resolve-recipients.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDb, clientWbxml, wbxmlTags, type WNode } from '../test-support/fake-db.js';

const db = installFakeDb({
  user: [
    { id: 'u1', email: 'alice@example.com', displayName: 'Alice Anders', domainId: 'd1', active: true },
    { id: 'u2', email: 'bob@example.com', displayName: 'Bob Brown', domainId: 'd1', active: true },
    { id: 'u3', email: 'bob@other.test', displayName: 'Bob Other', domainId: 'd2', active: true },
    { id: 'u5', email: 'bea@example.com', displayName: 'Bea Brown', domainId: 'd1', active: true },
  ],
  sharedMailbox: [{ id: 's1', email: 'sales@example.com', displayName: 'Sales', domainId: 'd1', active: true }],
  contact: [
    { id: 'c1', userId: 'u1', displayName: 'Carla Customer', email: 'carla@cust.test', email2: '', company: 'Cust', jobTitle: '', phone: '', mobile: '' },
    { id: 'c2', userId: 'u2', displayName: 'Secret Contact', email: 'secret@cust.test', email2: '', company: '', jobTitle: '', phone: '', mobile: '' },
    { id: 'c3', userId: 'u1', displayName: 'Bob (dup)', email: 'bob@example.com', email2: '', company: '', jobTitle: '', phone: '', mobile: '' },
  ],
});

const { handleResolveRecipients } = await import('./resolve-recipients.js');
const { decodeWbxml } = await import('../wbxml.js');
type E = import('../wbxml.js').WbxmlElement;

const R = (t: number, k?: WNode[] | string): WNode => [10, t, k];
const kid = (e: E | undefined, name: string): E | undefined => e?.children?.find((c): c is E => typeof c !== 'string' && c.name === name);
const all = (e: E | undefined, name: string): E[] => (e?.children ?? []).filter((c): c is E => typeof c !== 'string' && c.name === name);

async function run(tos: string[], options: WNode[] = []) {
  const req = R(0x05, [...tos.map((t) => R(0x10, t)), ...(options.length ? [R(0x0f, options)] : [])]);
  const buf = await handleResolveRecipients(decodeWbxml(clientWbxml(req)), 'u1');
  assert.ok(wbxmlTags(buf).every(([p]) => p === 10), JSON.stringify(wbxmlTags(buf)));
  const res = decodeWbxml(buf);
  return { status: kid(res, 'Status')?.text, responses: all(res, 'Response') };
}
const recips = (r: E) => all(r, 'Recipient').map((x) => [kid(x, 'Type')?.text, kid(x, 'DisplayName')?.text, kid(x, 'EmailAddress')?.text]);

test('exact address in the GAL → Status 1, Type 1 (GAL wins over a duplicate contact)', async () => {
  const { status, responses } = await run(['bob@example.com']);
  assert.equal(status, '1');
  assert.equal(kid(responses[0], 'To')?.text, 'bob@example.com');
  assert.equal(kid(responses[0], 'Status')?.text, '1');
  assert.equal(kid(responses[0], 'RecipientCount')?.text, '1');
  assert.deepEqual(recips(responses[0]!), [['1', 'Bob Brown', 'bob@example.com']]);
});

test('own contact → Type 2; another user\'s contact and other domains are never found', async () => {
  const { responses } = await run(['carla', 'secret@cust.test', 'bob@other.test']);
  assert.deepEqual(recips(responses[0]!), [['2', 'Carla Customer', 'carla@cust.test']]);
  assert.equal(kid(responses[1], 'Status')?.text, '4');
  assert.equal(kid(responses[1], 'RecipientCount')?.text, '0');
  assert.equal(kid(responses[2], 'Status')?.text, '4');
});

test('9.4 webmail policy: without the contacts module only the address list resolves', async () => {
  const storage = await import('@coremail/storage');
  db.tables['webmailPolicy'] = [{ id: 'p1', domainId: null, userId: 'u1', contacts: 'OFF' }];
  storage.invalidateWebmailPolicyCache();
  try {
    const { responses } = await run(['carla', 'bob@example.com']);
    assert.equal(kid(responses[0], 'Status')?.text, '4', 'own contact not resolved');
    assert.deepEqual(recips(responses[1]!), [['1', 'Bob Brown', 'bob@example.com']], 'the GAL still resolves');
  } finally {
    db.tables['webmailPolicy'] = [];
    storage.invalidateWebmailPolicyCache();
  }
});

test('ambiguous name → Status 2 with the candidates (MaxAmbiguousRecipients honoured)', async () => {
  const many = await run(['brown']);
  assert.equal(kid(many.responses[0], 'Status')?.text, '2');
  assert.deepEqual(recips(many.responses[0]!).map((r) => r[2]), ['bea@example.com', 'bob@example.com']);
  const capped = await run(['brown'], [R(0x14, '1')]);
  assert.equal(kid(capped.responses[0], 'RecipientCount')?.text, '1');
});

test('Availability / Certificates options are answered minimally', async () => {
  const { responses } = await run(['sales@example.com'], [R(0x11, '2'), R(0x16, [R(0x17, '2026-11-20T00:00:00Z'), R(0x18, '2026-11-21T00:00:00Z')])]);
  const rcp = all(responses[0], 'Recipient')[0];
  assert.equal(kid(rcp, 'EmailAddress')?.text, 'sales@example.com');
  assert.equal(kid(kid(rcp, 'Availability'), 'Status')?.text, '163');
  assert.equal(kid(kid(rcp, 'Certificates'), 'Status')?.text, '7');
  assert.equal(kid(kid(rcp, 'Certificates'), 'CertificateCount')?.text, '0');
});

test('no To → protocol error (Status 5)', async () => {
  const buf = await handleResolveRecipients(decodeWbxml(clientWbxml(R(0x05, [R(0x0f, [R(0x11, '1')])]))), 'u1');
  assert.equal(kid(decodeWbxml(buf), 'Status')?.text, '5');
});
