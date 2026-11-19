/**
 * 9.5: one-time backfill of the structured contact columns — derived columns,
 * updatedAt / changeKey / vCard / flat columns untouched, batches + cursor
 * (resumable), lock, one-time done marker, concurrent writes respected.
 * Run: node --import tsx --test src/contacts/contact-backfill.test.ts  (in packages/storage)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';

type Row = Record<string, unknown>;
const rows: Row[] = [];
let updateCalls = 0;
let beforeUpdate: ((id: string) => void) | null = null;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, c]) => {
    if (c && typeof c === 'object' && !(c instanceof Date) && 'gt' in (c as Row)) return String(row[k]) > String((c as Row)['gt']);
    if (c instanceof Date) return row[k] instanceof Date && (row[k] as Date).getTime() === c.getTime();
    return row[k] === c;
  });
}
(globalThis as unknown as { __prisma: unknown }).__prisma = {
  $on: () => undefined,
  contact: {
    findMany: async (a: { where: Row; take: number; select: Row }) => rows
      .filter((r) => matches(r, a.where))
      .sort((x, y) => String(x['id']).localeCompare(String(y['id'])))
      .slice(0, a.take)
      .map((r) => Object.fromEntries(Object.keys(a.select).map((k) => [k, r[k]]))),
    updateMany: async (a: { where: Row; data: Row }) => {
      updateCalls++;
      beforeUpdate?.(a.where['id'] as string);
      const hit = rows.filter((r) => matches(r, a.where));
      for (const r of hit) Object.assign(r, a.data);
      return { count: hit.length };
    },
  },
};

const { contactBackfillData, runLockedContactBackfill, backfillContactBatch, CONTACT_BACKFILL_DONE_KEY, CONTACT_BACKFILL_CURSOR_KEY, CONTACT_BACKFILL_LOCK_KEY } = await import('./index.js');

const T0 = new Date('2025-03-01T08:00:00Z');
const VCARD = [
  'BEGIN:VCARD', 'VERSION:3.0', 'UID:urn:uuid:old-1', 'N:Muster;Erika;;Dr.;', 'FN:Dr. Erika Muster', 'NICKNAME:Eri',
  'X-FILE-AS:Muster, Erika', 'EMAIL;TYPE=INTERNET,WORK:erika@firma.example', 'TEL;TYPE=CELL:+49 170 1234567',
  'CATEGORIES:Kunden,VIP', 'BDAY:1980-05-17', 'END:VCARD', '',
].join('\r\n');

function legacyRow(id: string, vcardData: string, flat: Row = {}): Row & { vcardData: string } {
  return {
    id, userId: 'u1', vcardData, displayName: 'Legacy Name', email: '', email2: '', phone: '', mobile: '', company: '',
    department: '', jobTitle: '', notes: '', changeKey: 'ck-1', updatedAt: new Date(T0), uid: '', givenName: '', familyName: '',
    middleName: '', namePrefix: '', nameSuffix: '', nickname: '', fileAs: '', birthday: '', anniversary: '', categories: [],
    emails: [], phones: [], addresses: [], urls: [], ims: [], searchText: '', ...flat,
  };
}

function fakeRedis() {
  const kv = new Map<string, string>();
  return {
    kv,
    get: async (k: string) => kv.get(k) ?? null,
    set: async (k: string, v: string, ...args: Array<string | number>) => {
      if (args.includes('NX') && kv.has(k)) return null;
      kv.set(k, v);
      return 'OK' as const;
    },
    eval: async (script: string, _n: number, key: string, token: string) => {
      if (kv.get(key) !== token) return 0;
      if (script.includes("'del'")) kv.delete(key);
      return 1;
    },
  };
}

test('contactBackfillData derives the 9.5 columns from the vCard (pure)', () => {
  const d = contactBackfillData(legacyRow('x', VCARD))!;
  assert.equal(d.uid, 'old-1');
  assert.equal(d.givenName, 'Erika');
  assert.equal(d.familyName, 'Muster');
  assert.equal(d.namePrefix, 'Dr.');
  assert.equal(d.nickname, 'Eri');
  assert.equal(d.fileAs, 'Muster, Erika');
  assert.equal(d.birthday, '1980-05-17');
  assert.deepEqual(d.categories, ['Kunden', 'VIP']);
  assert.deepEqual(d.emails, [{ type: 'work', value: 'erika@firma.example' }]);
  assert.match(d.searchText, /erika@firma\.example/);
  assert.ok(!('displayName' in d) && !('email' in d), 'flat columns are not written');
});

test('a row without vCard is derived from its flat columns; an empty row needs nothing', () => {
  const d = contactBackfillData(legacyRow('y', 'garbage', { displayName: 'Hans Flach', email: 'hans@x.example' }))!;
  assert.equal(d.givenName, 'Hans');
  assert.deepEqual(d.emails, [{ type: 'other', value: 'hans@x.example' }]);
  assert.equal(contactBackfillData(legacyRow('z', 'garbage', { displayName: '' })), null);
});

test('locked run fills every legacy row in batches, keeps updatedAt/changeKey/vCard, marks done; second run does nothing', async () => {
  rows.length = 0;
  for (let i = 1; i <= 5; i++) rows.push(legacyRow(`c${i}`, VCARD.replace('old-1', `old-${i}`)));
  rows.push(legacyRow('c6', 'garbage', { displayName: '' })); // nothing to fill
  const filledRow = legacyRow('c0', VCARD, { searchText: 'already', givenName: 'Kept' });
  rows.push(filledRow);
  const redis = fakeRedis();
  const r = await runLockedContactBackfill(redis, { batchSize: 2, pauseMs: 0 });
  assert.equal(r.status, 'ran');
  assert.ok(r.status === 'ran' && r.filled === 5 && r.finished && r.batches === 4, JSON.stringify(r));
  for (let i = 1; i <= 5; i++) {
    const row = rows.find((x) => x['id'] === `c${i}`)!;
    assert.equal(row['uid'], `old-${i}`);
    assert.equal(row['givenName'], 'Erika');
    assert.equal((row['updatedAt'] as Date).getTime(), T0.getTime(), 'updatedAt (ETag) unchanged');
    assert.equal(row['changeKey'], 'ck-1');
    assert.equal(row['displayName'], 'Legacy Name', 'flat column untouched');
    assert.ok((row['vcardData'] as string).includes(`old-${i}`));
  }
  assert.equal(filledRow['givenName'], 'Kept', 'rows written by 9.5 are not selected');
  assert.ok(redis.kv.get(CONTACT_BACKFILL_DONE_KEY));
  assert.equal(redis.kv.has(CONTACT_BACKFILL_LOCK_KEY), false, 'lock released');
  const calls = updateCalls;
  assert.deepEqual(await runLockedContactBackfill(redis), { status: 'done' });
  assert.equal(updateCalls, calls);
});

test('resumable: a run stopped after one batch continues after the stored cursor', async () => {
  rows.length = 0;
  for (let i = 1; i <= 4; i++) rows.push(legacyRow(`r${i}`, VCARD));
  const redis = fakeRedis();
  const first = await runLockedContactBackfill(redis, { batchSize: 2, maxBatches: 1, pauseMs: 0 });
  assert.ok(first.status === 'ran' && first.filled === 2 && !first.finished);
  assert.equal(redis.kv.get(CONTACT_BACKFILL_CURSOR_KEY), 'r2');
  // a row before the cursor that is still empty would not be re-read: the cursor is what makes it resumable
  const second = await runLockedContactBackfill(redis, { batchSize: 2, pauseMs: 0 });
  assert.ok(second.status === 'ran' && second.filled === 2 && second.finished, JSON.stringify(second));
  assert.ok(rows.every((r) => r['searchText']));
});

test('another instance holds the lock → nothing is done', async () => {
  const redis = fakeRedis();
  redis.kv.set(CONTACT_BACKFILL_LOCK_KEY, 'other');
  assert.deepEqual(await runLockedContactBackfill(redis), { status: 'locked' });
});

test('a row written concurrently (newer updatedAt) is left to its writer', async () => {
  rows.length = 0;
  rows.push(legacyRow('w1', VCARD));
  beforeUpdate = (id) => { const r = rows.find((x) => x['id'] === id)!; r['updatedAt'] = new Date(T0.getTime() + 1000); };
  try {
    const b = await backfillContactBatch('', 10);
    assert.equal(b.filled, 0);
    assert.equal(rows[0]!['searchText'], '');
  } finally {
    beforeUpdate = null;
  }
});
