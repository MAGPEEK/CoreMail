/**
 * 9.5: REST contacts with structured fields + contact groups ("Kontaktlisten").
 * Express app on an ephemeral loopback port, Prisma faked via globalThis.__prisma.
 * Run: node --import tsx --test src/routes/contacts-structured.test.ts  (in packages/api-gateway)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { setTestEnv } from '../test-support/fake-prisma.js';
import { noProtocolPolicies } from '@coremail/storage/auth/testing';

setTestEnv();

type Row = Record<string, unknown>;
let seq = 0;
const tick = (() => { let t = Date.parse('2026-01-01T00:00:00Z'); return () => new Date(++t); })();

function cond(v: unknown, c: unknown): boolean {
  if (c && typeof c === 'object' && !(c instanceof Date) && !Array.isArray(c)) {
    const o = c as Row;
    if ('in' in o) return (o['in'] as unknown[]).includes(v);
    if ('contains' in o) {
      const needle = String(o['contains']);
      return typeof v === 'string' && (o['mode'] === 'insensitive' ? v.toLowerCase().includes(needle.toLowerCase()) : v.includes(needle));
    }
    return false;
  }
  return v === c;
}
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, c]) => (k === 'OR' ? (c as Row[]).some((w) => matches(row, w)) : cond(row[k], c)));
}
function table(prefix: string, defaults: Row) {
  const rows: Row[] = [];
  return {
    rows,
    findFirst: async (a: { where: Row }) => rows.find((r) => matches(r, a.where)) ?? null,
    findMany: async (a: { where: Row; take?: number }) => rows.filter((r) => matches(r, a.where)).slice(0, a.take ?? Infinity),
    create: async (a: { data: Row }) => {
      const row = { id: `${prefix}${++seq}`, ...defaults, ...a.data, updatedAt: tick() };
      rows.push(row);
      return row;
    },
    update: async (a: { where: Row; data: Row }) => Object.assign(rows.find((r) => matches(r, a.where))!, a.data, { updatedAt: tick() }),
    delete: async (a: { where: Row }) => rows.splice(rows.findIndex((r) => matches(r, a.where)), 1)[0],
  };
}
const contact = table('c', { uid: '', searchText: '' });
const contactGroup = table('g', { members: [] });

(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  ...noProtocolPolicies(),
  contact,
  contactGroup,
  user: { findUnique: async () => ({ domainId: null }), findMany: async () => [], count: async () => 0 },
};

const express = (await import('express')).default;
const { signAccessToken } = await import('@coremail/core');
const { contactsRouter } = await import('./contacts.js');
const { contactCardFromVcard, contactGroupFromVcard } = await import('@coremail/storage');

const token = (sub: string) => signAccessToken({ sub, email: `${sub}@example.com`, role: 'USER', domainId: 'd1', sessionId: `s-${sub}`, mfaVerified: false });

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

async function call(method: string, path: string, body?: unknown, user = 'alice'): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${token(user)}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const FULL = {
  name: { prefix: 'Dr.', given: 'Erika', middle: '', family: 'Muster', suffix: '' },
  nickname: 'Riki', fileAs: 'Muster, Erika', company: 'Beispiel GmbH', jobTitle: 'Leitung',
  emails: [{ type: 'work', value: 'erika@firma.example' }, { type: 'home', value: 'erika@privat.example' }],
  phones: [{ type: 'mobile', value: '+49 170 1111111' }, { type: 'work', value: '+49 30 2222222' }, { type: 'fax', value: '+49 30 2222299' }],
  addresses: [{ type: 'work', street: 'Hauptstr. 1', city: 'Berlin', postalCode: '10115', country: 'Deutschland' }],
  urls: [{ type: 'work', value: 'https://firma.example' }],
  ims: [{ type: 'other', value: 'xmpp:erika@chat.example' }],
  birthday: '--05-17', anniversary: '2010-06-12', categories: ['Kunden', 'VIP', 'kunden'],
};

test('POST with structured fields: vCard, flat columns, structured columns and the response agree', async () => {
  const r = await call('POST', '/', FULL);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.displayName, 'Dr. Erika Muster', 'display name from the name parts');
  assert.deepEqual(r.json.categories, ['Kunden', 'VIP'], 'categories de-duplicated');
  assert.equal(r.json.searchText, undefined, 'internal column not exposed');
  const row = contact.rows.find((c) => c['id'] === r.json.id)!;
  assert.deepEqual([row['email'], row['email2'], row['phone'], row['mobile']],
    ['erika@firma.example', 'erika@privat.example', '+49 30 2222222', '+49 170 1111111']);
  assert.deepEqual(row['phones'], FULL.phones);
  assert.equal(row['birthday'], '--05-17');
  assert.ok(String(row['uid']).length > 0, 'uid column filled');
  const card = contactCardFromVcard(String(row['vcardData']));
  assert.deepEqual(card.ims, FULL.ims);
  assert.equal(card.addresses[0]!.city, 'Berlin');
  const got = await call('GET', `/${r.json.id}`);
  assert.deepEqual(got.json.emails, FULL.emails);
  assert.deepEqual(got.json.name, FULL.name);
});

test('strict validation: bad e-mail / phone / URL scheme / IM / date / type / mixed legacy + list → 400 with the field', async () => {
  const bad: Array<[Record<string, unknown>, string]> = [
    [{ displayName: 'X', emails: [{ type: 'work', value: 'nope' }] }, 'emails.0.value'],
    [{ displayName: 'X', phones: [{ type: 'work', value: 'call me' }] }, 'phones.0.value'],
    [{ displayName: 'X', urls: [{ type: 'work', value: 'javascript:alert(1)' }] }, 'urls.0.value'],
    [{ displayName: 'X', ims: [{ type: 'work', value: 'data:text/html,x' }] }, 'ims.0.value'],
    [{ displayName: 'X', birthday: '2023-02-29' }, 'birthday'],
    [{ displayName: 'X', emails: [{ type: 'private', value: 'a@b.example' }] }, 'emails.0.type'],
    [{ displayName: 'X', email: 'a@b.example', emails: [] }, 'emails'],
    [{ displayName: 'X', nickname: 'a\u0007b' }, 'nickname'],
    [{ displayName: 'X', categories: Array.from({ length: 51 }, (_, i) => `c${i}`) }, 'categories'],
    [{ displayName: '' }, 'displayName'],
  ];
  for (const [body, field] of bad) {
    const r = await call('POST', '/', body);
    assert.equal(r.status, 400, `${JSON.stringify(body)} → ${r.status}`);
    assert.equal(r.json.field, field, JSON.stringify(r.json));
  }
});

test('PUT replaces a list, keeps the rest; unchanged body writes nothing; legacy slots still work', async () => {
  const created = await call('POST', '/', FULL);
  const id = created.json.id as string;
  const before = contact.rows.find((c) => c['id'] === id)!;
  const stamp = before['updatedAt'];
  const same = await call('PUT', `/${id}`, { nickname: 'Riki', emails: FULL.emails });
  assert.equal(same.status, 200);
  assert.equal(contact.rows.find((c) => c['id'] === id)!['updatedAt'], stamp, 'no write for an unchanged card');

  const r = await call('PUT', `/${id}`, { phones: [{ type: 'home', value: '+49 40 5' }] });
  assert.deepEqual(r.json.phones, [{ type: 'home', value: '+49 40 5' }]);
  assert.deepEqual(r.json.emails, FULL.emails, 'other lists untouched');
  assert.equal(r.json.mobile, '');

  const legacy = await call('PUT', `/${id}`, { email: 'neu@firma.example', mobile: '+49 171 9' });
  assert.deepEqual(legacy.json.emails, [{ type: 'work', value: 'neu@firma.example' }, FULL.emails[1]], 'slot 1 keeps its type');
  assert.equal(legacy.json.mobile, '+49 171 9');
});

test('search covers nickname, any e-mail, phone digits, city and categories', async () => {
  await call('POST', '/', { displayName: 'Zora Suchbar', nickname: 'Zorro', emails: [{ type: 'home', value: 'z2@versteckt.example' }],
    phones: [{ type: 'work', value: '+49 (89) 123-456' }], addresses: [{ type: 'home', city: 'Regensburg' }], categories: ['Golfclub'] });
  for (const q of ['zorro', 'versteckt', '89123456', 'regensburg', 'GOLF']) {
    const r = await call('GET', `/?q=${encodeURIComponent(q)}`);
    assert.ok(r.json.some((c: { displayName: string }) => c.displayName === 'Zora Suchbar'), `not found by ${q}`);
  }
});

test('contact groups: create with contacts + addresses, view, rename, expand, autocomplete, delete detaches', async () => {
  const anna = (await call('POST', '/', { displayName: 'Anna A', emails: [{ type: 'work', value: 'anna@x.example' }] })).json;
  const noMail = (await call('POST', '/', { displayName: 'Ohne Mail', company: 'Firma' })).json;
  const g = await call('POST', '/groups', {
    name: 'Projekt Nord',
    members: [{ contactId: anna.id }, { contactId: noMail.id }, { email: 'extern@partner.example', name: 'Partner' }, { email: 'EXTERN@partner.example' }],
  });
  assert.equal(g.status, 201, JSON.stringify(g.json));
  assert.deepEqual(g.json.members.map((m: { kind: string }) => m.kind), ['contact', 'contact', 'address'], 'duplicate address dropped');
  const row = contactGroup.rows.find((r) => r['id'] === g.json.id)!;
  const vcard = contactGroupFromVcard(String(row['vcardData']))!;
  assert.equal(vcard.name, 'Projekt Nord');
  assert.equal(vcard.members.length, 3, 'vCard members follow the list');

  const exp = await call('GET', `/groups/${g.json.id}/expand`);
  assert.deepEqual(exp.json.recipients, [{ name: 'Anna A', address: 'anna@x.example' }, { name: 'Partner', address: 'extern@partner.example' }]);
  assert.deepEqual(exp.json.skipped, [{ reason: 'noEmail', name: 'Ohne Mail' }]);

  const outer = await call('POST', '/groups', { name: 'Alle', members: [{ groupId: g.json.id }, { email: 'chef@x.example' }] });
  assert.equal((await call('GET', `/groups/${outer.json.id}/expand`)).json.recipients.length, 3, 'nested group expanded');
  assert.equal((await call('PUT', `/groups/${outer.json.id}`, { members: [{ groupId: outer.json.id }] })).status, 400, 'no self membership');

  const renamed = await call('PUT', `/groups/${g.json.id}`, { name: 'Projekt Süd' });
  assert.equal(renamed.json.name, 'Projekt Süd');
  assert.equal(renamed.json.members.length, 3, 'members kept on rename');

  const list = await call('GET', '/groups');
  assert.deepEqual(list.json.map((x: { name: string; memberCount: number }) => [x.name, x.memberCount]), [['Projekt Süd', 3], ['Alle', 2]]);

  const auto = await call('GET', '/?q=projekt&groups=1');
  assert.ok(auto.json.some((e: { id: string; kind?: string }) => e.id === `group-${g.json.id}` && e.kind === 'group'));
  const plain = await call('GET', '/?q=projekt');
  assert.ok(!plain.json.some((e: { kind?: string }) => e.kind === 'group'), 'only on request');

  assert.equal((await call('DELETE', `/${anna.id}`)).status, 200);
  const after = await call('GET', `/groups/${g.json.id}`);
  assert.deepEqual(after.json.members.map((m: { kind: string }) => m.kind), ['contact', 'address'], 'deleted contact left the group');

  assert.equal((await call('DELETE', `/groups/${g.json.id}`)).status, 200);
  assert.deepEqual((await call('GET', `/groups/${outer.json.id}`)).json.members.map((m: { kind: string }) => m.kind), ['address'],
    'deleted group left the outer group');
});

test('groups are per user: another user can neither read, expand, change nor reference them', async () => {
  const g = await call('POST', '/groups', { name: 'Privat', members: [{ email: 'a@b.example' }] });
  for (const [m, p] of [['GET', `/groups/${g.json.id}`], ['GET', `/groups/${g.json.id}/expand`], ['PUT', `/groups/${g.json.id}`], ['DELETE', `/groups/${g.json.id}`]] as const) {
    assert.equal((await call(m, p, m === 'PUT' ? { name: 'x' } : undefined, 'mallory')).status, 404, `${m} ${p}`);
  }
  const c = (await call('POST', '/', { displayName: 'Geheim' })).json;
  assert.equal((await call('POST', '/groups', { name: 'X', members: [{ contactId: c.id }] }, 'mallory')).status, 400);
  assert.equal((await call('POST', '/groups', { name: 'X', members: [{ groupId: g.json.id }] }, 'mallory')).status, 400);
  assert.equal((await call('POST', '/groups', { name: ' ' })).status, 400, 'empty name');
  assert.equal((await call('POST', '/', { displayName: 'G', vcardData: 'BEGIN:VCARD\r\nVERSION:4.0\r\nKIND:group\r\nFN:G\r\nEND:VCARD\r\n' })).status, 400,
    'a group vCard is no contact');
});

// ─── Review 9.5: existing data ───────────────────────────────────────────────

/** A contact a CardDAV client stored: values the strict REST checks would refuse for new input. */
function storeCardDavContact(id: string): void {
  const tels = Array.from({ length: 22 }, (_, i) => `TEL;TYPE=WORK:+49 30 ${1000 + i}`);
  const vcardData = [
    'BEGIN:VCARD', 'VERSION:3.0', 'UID:CDAV-1', 'FN:Karl Alt', 'N:Alt;Karl;;;', 'ORG:Altfirma',
    'EMAIL;TYPE=INTERNET:karl@intranet', ...tels, 'URL:www.altfirma.example', `NOTE:${'x'.repeat(12_000)}`,
    `CATEGORIES:${'K'.repeat(80)}`, 'X-CUSTOM:bleibt', 'END:VCARD', '',
  ].join('\r\n');
  contact.rows.push({ id, userId: 'alice', vcardData, uid: '', searchText: '', displayName: 'Karl Alt', email: 'karl@intranet', updatedAt: tick() });
}

test('a CardDAV contact with values the checks refuse stays editable: the webmail form round trip changes one field only', async () => {
  storeCardDavContact('cdav-1');
  const view = (await call('GET', '/cdav-1')).json;
  assert.equal(view.phones.length, 22);
  // The webmail sends the whole form back (contactPayload) with one changed field
  const form = {
    displayName: view.displayName, name: view.name, nickname: view.nickname, fileAs: view.fileAs, company: view.company,
    department: view.department, jobTitle: 'Neu', emails: view.emails, phones: view.phones, addresses: view.addresses,
    urls: view.urls, ims: view.ims, birthday: view.birthday, anniversary: view.anniversary, categories: view.categories, notes: view.notes,
  };
  const r = await call('PUT', '/cdav-1', form);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.jobTitle, 'Neu');
  const vcard = String(contact.rows.find((c) => c['id'] === 'cdav-1')!['vcardData']).replace(/\r\n[ \t]/g, '');
  for (const kept of ['URL:www.altfirma.example', 'EMAIL;TYPE=INTERNET:karl@intranet', 'X-CUSTOM:bleibt', 'TEL;TYPE=WORK:+49 30 1021']) {
    assert.ok(vcard.includes(kept), `${kept} kept`);
  }

  // Replacing one of the 22 phones: the stored count passes, growing past it does not
  const swapped = await call('PUT', '/cdav-1', { phones: [...view.phones.slice(1), { type: 'home', value: '+49 40 1' }] });
  assert.equal(swapped.status, 200, JSON.stringify(swapped.json));
  assert.equal(swapped.json.phones.length, 22);
  const more = await call('PUT', '/cdav-1', { phones: [...swapped.json.phones, { type: 'home', value: '+49 40 2' }] });
  assert.deepEqual([more.status, more.json.field], [400, 'phones']);
  const badNew = await call('PUT', '/cdav-1', { urls: [...view.urls, { type: 'work', value: 'javascript:alert(1)' }] });
  assert.deepEqual([badNew.status, badNew.json.field], [400, 'urls.1.value'], 'a new value is still checked');
  const changedOld = await call('PUT', '/cdav-1', { urls: [{ type: 'work', value: 'www.anders.example' }] });
  assert.equal(changedOld.status, 400, 'a changed value is new input');
});

test('a row without a readable vCard keeps its flat columns on read and on the next write', async () => {
  contact.rows.push({
    id: 'flat-1', userId: 'alice', vcardData: '', uid: '', searchText: '', displayName: 'Flach Mann', email: 'flach@x.example',
    email2: '', phone: '+49 30 1', mobile: '+49 170 2', company: 'Flachbau', department: '', jobTitle: '', notes: 'alt', updatedAt: tick(),
  });
  const view = (await call('GET', '/flat-1')).json;
  assert.deepEqual(view.emails, [{ type: 'other', value: 'flach@x.example' }]);
  assert.deepEqual(view.phones, [{ type: 'other', value: '+49 30 1' }, { type: 'mobile', value: '+49 170 2' }]);
  const r = await call('PUT', '/flat-1', { jobTitle: 'Chef' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const row = contact.rows.find((c) => c['id'] === 'flat-1')!;
  assert.deepEqual([row['email'], row['phone'], row['mobile'], row['company'], row['notes'], row['jobTitle']],
    ['flach@x.example', '+49 30 1', '+49 170 2', 'Flachbau', 'alt', 'Chef']);
  assert.equal(contactCardFromVcard(String(row['vcardData'])).emails.length, 1, 'the new vCard carries the e-mail');
});

test('a uid member pointing at another user\'s contact never expands to it', async () => {
  const secret = (await call('POST', '/', { displayName: 'Geheim B', emails: [{ type: 'work', value: 'geheim@x.example' }] })).json;
  const uid = String(contact.rows.find((c) => c['id'] === secret.id)!['uid']);
  const g = await call('POST', '/groups', { name: 'Fremd', members: [{ uid }] }, 'mallory');
  assert.equal(g.status, 201);
  assert.deepEqual(g.json.members, [{ kind: 'missing', uid }]);
  const exp = await call('GET', `/groups/${g.json.id}/expand`, undefined, 'mallory');
  assert.deepEqual(exp.json.recipients, []);
});
