/**
 * 9.5: CardDAV round trip of the structured contact fields and contact groups
 * (vCard 4 KIND:group + MEMBER, Apple X-ADDRESSBOOKSERVER-KIND/-MEMBER).
 * Real Express app on a loopback port, faked auth, in-memory Prisma fake.
 * Run: node --import tsx --import ../storage/src/test-support/realtime-off.ts --test src/carddav/carddav.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Request, Response, NextFunction } from 'express';
import type {} from '../auth.js'; // Request.davUser augmentation (type-only)

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';

type Row = Record<string, unknown>;
let clock = Date.parse('2026-01-01T00:00:00Z');
const tick = (): Date => new Date(++clock);

function cond(v: unknown, c: unknown): boolean {
  if (c && typeof c === 'object' && !(c instanceof Date)) {
    const o = c as Row;
    if ('in' in o) return (o['in'] as unknown[]).includes(v);
    if ('contains' in o) return typeof v === 'string' && v.includes(String(o['contains']));
    return false;
  }
  return v === c;
}
const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, c]) => (k === 'OR' ? (c as Row[]).some((w) => matches(row, w)) : cond(row[k], c)));

function table(defaults: Row) {
  const rows: Row[] = [];
  return {
    rows,
    findMany: async (a: { where?: Row } = {}) => rows.filter((r) => matches(r, a.where)),
    findFirst: async (a: { where?: Row } = {}) => rows.find((r) => matches(r, a.where)) ?? null,
    create: async (a: { data: Row }) => { const row = { ...defaults, ...a.data, updatedAt: tick() }; rows.push(row); return row; },
    update: async (a: { where: Row; data: Row }) => Object.assign(rows.find((r) => matches(r, a.where))!, a.data, { updatedAt: tick() }),
    delete: async (a: { where: Row }) => rows.splice(rows.findIndex((r) => matches(r, a.where)), 1)[0],
    aggregate: async (a: { where?: Row }) => {
      const hit = rows.filter((r) => matches(r, a.where));
      const max = hit.reduce<Date | null>((m, r) => (!m || (r['updatedAt'] as Date) > m ? r['updatedAt'] as Date : m), null);
      return { _count: { _all: hit.length }, _max: { updatedAt: max } };
    },
  };
}
const db = { contact: table({ uid: '' }), contactGroup: table({ members: [] }) };
(globalThis as Record<string, unknown>)['__prisma'] = { $on: () => undefined, ...db };

const express = (await import('express')).default;
const { carddavRouter } = await import('./index.js');
const {
  applyContactCard, contactCardFromVcard, contactColumnsFromVcard, contactGroupColumns, contactGroupData, contactRowData,
} = await import('@coremail/storage');

let server: Server;
let base = '';
before(async () => {
  const app = express();
  app.use(express.text({ type: ['text/vcard', 'application/xml', 'text/xml'], limit: '10mb' }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const u = req.get('X-Test-User');
    if (u) req.davUser = { userId: u, email: `${u}@example.com` };
    next();
  });
  app.use('/dav', carddavRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });

async function dav(method: string, path: string, opts: { user?: string; body?: string; type?: string; headers?: Record<string, string> } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'X-Test-User': opts.user ?? 'alice',
      ...(opts.body !== undefined ? { 'Content-Type': opts.type ?? 'application/xml; charset=utf-8' } : {}),
      ...(opts.headers ?? {}),
    },
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  });
  return { status: res.status, etag: res.headers.get('etag'), text: await res.text() };
}

const AB = '/dav/addressbooks/alice/default';
const vcf = (...lines: string[]): string => ['BEGIN:VCARD', ...lines, 'END:VCARD', ''].join('\r\n');

const ERIKA = vcf(
  'VERSION:3.0', 'UID:ERIKA-1', 'N:Muster;Erika;;Dr.;', 'FN:Dr. Erika Muster', 'NICKNAME:Riki',
  'item1.EMAIL;type=INTERNET;type=WORK;type=pref:erika@firma.example', 'EMAIL;type=INTERNET;type=HOME:erika@privat.example',
  'TEL;type=CELL:+49 170 1', 'TEL;type=WORK;type=VOICE:+49 30 2', 'TEL;type=HOME;type=FAX:+49 30 3',
  'ADR;type=HOME:;;Ringstr. 5;Hamburg;;20095;Deutschland', 'URL;type=WORK:https://firma.example',
  'IMPP;X-SERVICE-TYPE=Jabber;type=HOME:xmpp:erika@chat.example', 'BDAY:1980-05-17', 'X-ANNIVERSARY:2010-06-12',
  'CATEGORIES:Kunden,VIP', 'X-CUSTOM-THING;x-param=1:kept', 'PHOTO;ENCODING=b;TYPE=JPEG:QUJDRA==',
);
const BEN = vcf('VERSION:4.0', 'UID:urn:uuid:ben-2', 'FN:Ben', 'EMAIL;TYPE=work:ben@x.example', 'ANNIVERSARY:--0704');

const V4_GROUP = vcf('VERSION:4.0', 'KIND:group', 'FN:Projekt', 'UID:urn:uuid:grp-v4',
  'MEMBER:urn:uuid:ERIKA-1', 'MEMBER:urn:uuid:ben-2', 'MEMBER:mailto:extern@partner.example');
const APPLE_GROUP = vcf('VERSION:3.0', 'N:Team', 'FN:Team', 'X-ADDRESSBOOKSERVER-KIND:group', 'UID:GRP-APPLE',
  'X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:ERIKA-1');

test('PUT of a multi-value vCard 3: every structured column indexed, GET serves the card verbatim', async () => {
  const put = await dav('PUT', `${AB}/erika.vcf`, { body: ERIKA, type: 'text/vcard' });
  assert.equal(put.status, 201);
  const row = db.contact.rows.find((r) => r['id'] === 'erika')!;
  assert.equal(row['uid'], 'ERIKA-1');
  assert.deepEqual([row['givenName'], row['familyName'], row['namePrefix'], row['nickname']], ['Erika', 'Muster', 'Dr.', 'Riki']);
  assert.deepEqual(row['emails'], [{ type: 'work', value: 'erika@firma.example' }, { type: 'home', value: 'erika@privat.example' }]);
  assert.deepEqual(row['phones'], [{ type: 'mobile', value: '+49 170 1' }, { type: 'work', value: '+49 30 2' }, { type: 'fax', value: '+49 30 3' }]);
  assert.deepEqual([row['email'], row['email2'], row['phone'], row['mobile']], ['erika@firma.example', 'erika@privat.example', '+49 30 2', '+49 170 1']);
  assert.deepEqual(row['urls'], [{ type: 'work', value: 'https://firma.example' }]);
  assert.deepEqual(row['ims'], [{ type: 'home', value: 'xmpp:erika@chat.example' }]);
  assert.deepEqual([row['birthday'], row['anniversary']], ['1980-05-17', '2010-06-12']);
  assert.deepEqual(row['categories'], ['Kunden', 'VIP']);
  assert.match(String(row['searchText']), /hamburg/);
  const get = await dav('GET', `${AB}/erika.vcf`);
  assert.equal(get.text, ERIKA, 'unknown properties preserved byte for byte');

  assert.equal((await dav('PUT', `${AB}/ben.vcf`, { body: BEN, type: 'text/vcard' })).status, 201);
  const ben = db.contact.rows.find((r) => r['id'] === 'ben')!;
  assert.deepEqual([ben['uid'], ben['anniversary']], ['ben-2', '--07-04']);
});

test('groups: vCard 4 and Apple form are stored as groups, listed, reported and synced with the contacts', async () => {
  const ctag = async () => /getctag>([^<]+)</.exec((await dav('PROPFIND', AB, { headers: { Depth: '0' } })).text)?.[1];
  const before = await ctag();
  const v4 = await dav('PUT', `${AB}/grp-v4.vcf`, { body: V4_GROUP, type: 'text/vcard' });
  assert.equal(v4.status, 201);
  assert.notEqual(await ctag(), before, 'a new group changes the ctag');
  assert.equal((await dav('PUT', `${AB}/grp-apple.vcf`, { body: APPLE_GROUP, type: 'text/vcard' })).status, 201);
  assert.equal(db.contact.rows.length, 2, 'groups are no contacts');
  assert.deepEqual(db.contactGroup.rows.find((r) => r['id'] === 'grp-v4')!['members'], [
    { kind: 'card', uid: 'ERIKA-1' }, { kind: 'card', uid: 'ben-2' }, { kind: 'address', address: 'extern@partner.example', name: '' },
  ]);
  assert.deepEqual(db.contactGroup.rows.find((r) => r['id'] === 'grp-apple')!['name'], 'Team');

  const list = await dav('PROPFIND', AB, { headers: { Depth: '1' } });
  for (const id of ['erika', 'ben', 'grp-v4', 'grp-apple']) assert.match(list.text, new RegExp(`${id}\\.vcf`), id);
  const multiget = await dav('REPORT', AB, { body: `<card:addressbook-multiget xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/><card:address-data/></d:prop><d:href>${AB}/grp-v4.vcf</d:href><d:href>${AB}/nope.vcf</d:href></card:addressbook-multiget>` });
  assert.match(multiget.text, /KIND:group/);
  assert.match(multiget.text, /404 Not Found/);
  const sync = await dav('REPORT', AB, { body: '<d:sync-collection xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:sync-token/><d:prop><d:getetag/></d:prop></d:sync-collection>' });
  assert.match(sync.text, /grp-apple\.vcf/);
  assert.equal((await dav('GET', `${AB}/grp-v4.vcf`)).text, V4_GROUP);
});

test('conflicts: a resource keeps its kind, UIDs are unique across contacts and groups, foreign ids are refused', async () => {
  assert.equal((await dav('PUT', `${AB}/erika.vcf`, { body: V4_GROUP.replace('grp-v4', 'other'), type: 'text/vcard' })).status, 409);
  assert.equal((await dav('PUT', `${AB}/grp-v4.vcf`, { body: BEN.replace('ben-2', 'ben-3'), type: 'text/vcard' })).status, 409);
  const clash = await dav('PUT', `${AB}/new-group.vcf`, { body: APPLE_GROUP.replace('UID:GRP-APPLE', 'UID:ERIKA-1'), type: 'text/vcard' });
  assert.equal(clash.status, 409);
  assert.match(clash.text, /no-uid-conflict/);
  assert.match(clash.text, /erika\.vcf/);
  assert.equal((await dav('PUT', '/dav/addressbooks/mallory/default/grp-v4.vcf', { user: 'mallory', body: V4_GROUP, type: 'text/vcard' })).status, 403);
});

test('deleting a contact removes it from every group (vCard and members) and changes the group ETag', async () => {
  const etag = (await dav('GET', `${AB}/grp-v4.vcf`)).etag;
  assert.equal((await dav('DELETE', `${AB}/ben.vcf`)).status, 204);
  const g = await dav('GET', `${AB}/grp-v4.vcf`);
  assert.notEqual(g.etag, etag);
  assert.doesNotMatch(g.text, /ben-2/);
  assert.match(g.text, /MEMBER:urn:uuid:ERIKA-1/);
  assert.match(g.text, /MEMBER:mailto:extern@partner\.example/);
  assert.equal((await dav('DELETE', `${AB}/grp-apple.vcf`)).status, 204);
  assert.equal((await dav('GET', `${AB}/grp-apple.vcf`)).status, 404);
});

test('a group PUT keeps the names the webmail gave its address members; a webmail group is served in the Apple form', async () => {
  const row = db.contactGroup.rows.find((r) => r['id'] === 'grp-v4')!;
  row['members'] = [{ kind: 'card', uid: 'ERIKA-1' }, { kind: 'address', address: 'extern@partner.example', name: 'Partner' }];
  const body = (await dav('GET', `${AB}/grp-v4.vcf`)).text.replace('FN:Projekt', 'FN:Projekt 2');
  assert.equal((await dav('PUT', `${AB}/grp-v4.vcf`, { body, type: 'text/vcard' })).status, 204);
  assert.deepEqual(row['members'], [{ kind: 'card', uid: 'ERIKA-1' }, { kind: 'address', address: 'extern@partner.example', name: 'Partner' }]);
  assert.equal(row['name'], 'Projekt 2');

  db.contactGroup.rows.push({ id: 'web-grp', userId: 'alice', updatedAt: tick(), ...contactGroupData(contactGroupColumns('', 'Aus dem Webmail', [{ kind: 'card', uid: 'ERIKA-1' }])) });
  const web = await dav('GET', `${AB}/web-grp.vcf`);
  assert.match(web.text, /X-ADDRESSBOOKSERVER-KIND:group/);
  assert.match(web.text, /X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:ERIKA-1/);
  assert.match(web.text, /FN:Aus dem Webmail/);
});

test('a card the webmail changed reads back through CardDAV with the change and every unknown property', async () => {
  const row = db.contact.rows.find((r) => r['id'] === 'erika')!;
  const card = contactCardFromVcard(String(row['vcardData']));
  const vcardData = applyContactCard(String(row['vcardData']), { ...card, phones: [...card.phones, { type: 'pager', value: '555' }], categories: ['VIP'] });
  Object.assign(row, { vcardData, ...contactRowData(contactColumnsFromVcard(vcardData)), updatedAt: tick() });
  const got = (await dav('GET', `${AB}/erika.vcf`)).text;
  assert.match(got, /^TEL;TYPE=PAGER:555\r$/m);
  assert.match(got, /^X-CUSTOM-THING;x-param=1:kept\r$/m);
  assert.match(got, /^PHOTO;ENCODING=b;TYPE=JPEG:QUJDRA==\r$/m);
  assert.match(got, /^item1\.EMAIL;type=INTERNET;type=WORK;type=pref:erika@firma\.example\r$/m);
  assert.match(got, /^CATEGORIES:VIP\r$/m);
  assert.deepEqual(contactCardFromVcard(got).phones.at(-1), { type: 'pager', value: '555' });
  assert.deepEqual(contactCardFromVcard(got).addresses[0], { type: 'home', poBox: '', extended: '', street: 'Ringstr. 5', city: 'Hamburg', region: '', postalCode: '20095', country: 'Deutschland' });
});
