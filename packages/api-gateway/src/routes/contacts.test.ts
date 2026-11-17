/**
 * REST contacts: a webmail edit patches the stored vCard (CardDAV data survives),
 * every edited field is persisted, text is escaped, /gal is reachable.
 * Express app on an ephemeral loopback port, Prisma faked via globalThis.__prisma.
 * Run: node --import tsx --test src/routes/contacts.test.ts  (in packages/api-gateway)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { setTestEnv } from '../test-support/fake-prisma.js';

setTestEnv();

type Row = Record<string, unknown>;
const contacts: Row[] = [];
let seq = 0;
const matches = (row: Row, where: Row): boolean => Object.entries(where).every(([k, v]) => row[k] === v);
const COLUMNS = { email: '', email2: '', phone: '', mobile: '', company: '', department: '', jobTitle: '', notes: '' };

(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  contact: {
    findFirst: async (a: { where: Row }) => contacts.find((c) => matches(c, a.where)) ?? null,
    findMany: async (a: { where: Row }) => contacts.filter((c) => c['userId'] === a.where['userId']),
    create: async (a: { data: Row }) => {
      const row = { id: `c${++seq}`, ...COLUMNS, ...a.data, updatedAt: new Date() };
      contacts.push(row);
      return row;
    },
    update: async (a: { where: Row; data: Row }) => {
      const row = contacts.find((c) => matches(c, a.where))!;
      Object.assign(row, a.data, { updatedAt: new Date() });
      return row;
    },
    delete: async (a: { where: Row }) => contacts.splice(contacts.findIndex((c) => matches(c, a.where)), 1)[0],
  },
  user: {
    findUnique: async (a: { where: { id: string } }) => users.find((u) => u['id'] === a.where.id) ?? null,
    findMany: async (a: { where: Row; skip?: number; take?: number }) => {
      galQueries.push(a);
      const rows = users.filter((u) => userMatches(u, a.where));
      return rows.slice(a.skip ?? 0, (a.skip ?? 0) + (a.take ?? rows.length));
    },
    count: async (a: { where: Row }) => users.filter((u) => userMatches(u, a.where)).length,
  },
};

/** Two tenants on one server: alice + bob on example.com, mallory on other.example. */
const users: Row[] = [
  { id: 'alice', email: 'alice@example.com', displayName: 'Alice', domainId: 'd1', active: true, domain: { name: 'example.com' } },
  { id: 'u2', email: 'bob@example.com', displayName: 'Bob', domainId: 'd1', active: true, domain: { name: 'example.com' } },
  { id: 'u3', email: 'mallory@other.example', displayName: 'Bobby Other', domainId: 'd2', active: true, domain: { name: 'other.example' } },
];
const galQueries: Array<{ where: Row; skip?: number; take?: number }> = [];
function userMatches(u: Row, where: Row): boolean {
  if (where['domainId'] !== undefined && u['domainId'] !== where['domainId']) return false;
  if (where['active'] !== undefined && u['active'] !== where['active']) return false;
  const or = where['OR'] as Array<Record<string, { contains: string }>> | undefined;
  if (or && !or.some((c) => Object.entries(c).some(([k, v]) => String(u[k]).toLowerCase().includes(v.contains.toLowerCase())))) return false;
  return true;
}

const express = (await import('express')).default;
const { signAccessToken } = await import('@coremail/core');
const { contactsRouter } = await import('./contacts.js');
const { vcardFields, vcardUid } = await import('@coremail/core/vcard');

const token = signAccessToken({ sub: 'alice', email: 'alice@example.com', role: 'USER', domainId: 'd1', sessionId: 's1', mfaVerified: false });

let server: Server;
let base = '';
before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/contacts', contactsRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/contacts`;
});
after(() => { server.close(); });

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** What a CardDAV client (iOS/DAVx5) stored. */
const CARDDAV_CARD = [
  'BEGIN:VCARD', 'VERSION:3.0', 'UID:6F1C-ios-uid', 'FN:Jane Doe', 'N:Doe;Jane;;;',
  'EMAIL;TYPE=INTERNET:jane@example.com', 'TEL;TYPE=CELL:+49 170 1234', 'TEL;TYPE=HOME:+49 30 999',
  'ADR;TYPE=HOME:;;Main St 1;Berlin;;10115;DE', 'PHOTO;ENCODING=b;TYPE=JPEG:QUJDRA==', 'NOTE:allergic to nuts',
  'BDAY:1990-04-01', 'X-SOCIALPROFILE;TYPE=twitter:https://x.example/jane', 'END:VCARD', '',
].join('\r\n');

test('PUT patches the stored vCard: every property a CardDAV client stored survives a webmail edit', async () => {
  contacts.push({ id: 'dav1', userId: 'alice', vcardData: CARDDAV_CARD, displayName: 'Jane Doe', ...COLUMNS, email: 'jane@example.com', updatedAt: new Date() });
  // The webmail sends its whole form (unchanged fields included)
  const r = await call('PUT', '/dav1', {
    displayName: 'Jane Doe', email: 'jane.doe@example.com', email2: '', company: 'ACME', phone: '+49 30 999',
    mobile: '+49 170 1234', department: '', jobTitle: 'CTO', notes: 'allergic to nuts',
  });
  assert.equal(r.status, 200);
  const card = String(contacts.find((c) => c['id'] === 'dav1')!['vcardData']).replace(/\r\n /g, '');
  for (const kept of ['UID:6F1C-ios-uid', 'TEL;TYPE=CELL:+49 170 1234', 'TEL;TYPE=HOME:+49 30 999', 'ADR;TYPE=HOME:;;Main St 1;Berlin;;10115;DE',
    'PHOTO;ENCODING=b;TYPE=JPEG:QUJDRA==', 'NOTE:allergic to nuts', 'BDAY:1990-04-01', 'X-SOCIALPROFILE;TYPE=twitter:https://x.example/jane', 'N:Doe;Jane;;;']) {
    assert.ok(card.includes(kept), `lost ${kept}`);
  }
  assert.match(card, /^EMAIL;TYPE=INTERNET:jane.doe@example.com$/m);
  assert.match(card, /^ORG:ACME$/m);
  assert.match(card, /^TITLE:CTO$/m);
  assert.equal(vcardUid(card), '6F1C-ios-uid');
  // Columns follow the vCard (the TEL lines were not indexed before)
  assert.deepEqual([r.json.email, r.json.company, r.json.jobTitle, r.json.mobile, r.json.phone],
    ['jane.doe@example.com', 'ACME', 'CTO', '+49 170 1234', '+49 30 999']);
});

test('POST/PUT persist the extended fields and escape ",", ";" and newlines (no property injection)', async () => {
  const created = await call('POST', '/', {
    displayName: 'Anna Maria Schmidt', email: '', email2: 'anna@private.example', phone: '1', mobile: '2',
    company: 'Foo; Bar', department: 'IT', jobTitle: 'Admin', notes: 'line1\nEMAIL:evil@x.example',
  });
  assert.equal(created.status, 201);
  const card = String(created.json.vcardData);
  assert.match(card, /^N:Schmidt;Anna Maria;;;$/m);
  assert.match(card, /^ORG:Foo\\; Bar;IT$/m);
  assert.match(card, /^NOTE:line1\\nEMAIL:evil@x.example$/m);
  assert.ok(vcardUid(card));
  const f = vcardFields(card);
  assert.equal(f.email, 'anna@private.example', 'only one EMAIL property');
  assert.deepEqual([created.json.mobile, created.json.department, created.json.notes], ['2', 'IT', 'line1\nEMAIL:evil@x.example']);

  const name = await call('PUT', `/${created.json.id}`, { displayName: 'Dr, Who; Else\nFN:x' });
  assert.equal(name.status, 200);
  assert.equal(vcardFields(String(name.json.vcardData)).displayName, 'Dr, Who; Else\nFN:x');
  assert.equal((String(name.json.vcardData).match(/^FN:/gm) ?? []).length, 1);
  assert.equal((await call('PUT', `/${created.json.id}`, { email: 'not-an-address' })).status, 400);
});

test('GET /gal is reachable (no longer shadowed by GET /:id)', async () => {
  const r = await call('GET', '/gal');
  assert.equal(r.status, 200);
  assert.ok(r.json.entries.some((e: { email: string }) => e.email === 'bob@example.com'));
});

test('GAL and autocomplete never list users of another domain (multi-tenant), /gal is paginated in the DB', async () => {
  const gal = await call('GET', '/gal');
  assert.deepEqual(gal.json.entries.map((e: { email: string }) => e.email).sort(), ['alice@example.com', 'bob@example.com']);
  assert.equal(gal.json.total, 2);
  const q = await call('GET', '/gal?q=bob');
  assert.deepEqual(q.json.entries.map((e: { email: string }) => e.email), ['bob@example.com']);
  const last = galQueries.at(-1)!;
  assert.equal(last.where['domainId'], 'd1');
  assert.equal(typeof last.take, 'number', 'GAL query is bounded');

  const page = await call('GET', '/gal?limit=1&offset=1');
  assert.equal(page.json.entries.length, 1);
  assert.equal(page.json.total, 2);

  const auto = await call('GET', '/?q=bob');
  assert.equal(auto.status, 200);
  const emails = auto.json.map((e: { email: string }) => e.email);
  assert.ok(emails.includes('bob@example.com'));
  assert.ok(!emails.includes('mallory@other.example'), 'autocomplete leaked another tenant');
});
