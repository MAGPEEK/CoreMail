import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';

/**
 * message-store: UID/modSeq allocation and the move/copy/flag/expunge helpers,
 * against an in-memory Prisma stand-in installed through the globalThis.__prisma
 * seam of ./prisma/index.ts. `$transaction(fn)` runs the callback with the same
 * fake. Every fake call yields to the event loop first, so concurrent transactions
 * interleave between statements — but a single `mailbox.update` (UPDATE … RETURNING)
 * is atomic, as in PostgreSQL.
 */

type Row = Record<string, unknown>;
interface Db { mailboxes: Row[]; folders: Row[]; messages: Row[]; attachments: Row[] }
const db: Db = { mailboxes: [], folders: [], messages: [], attachments: [] };
let seq = 0;
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

function cmp(a: unknown, b: unknown): number {
  if (typeof a === 'bigint' || typeof b === 'bigint') { const x = BigInt(a as never); const y = BigInt(b as never); return x < y ? -1 : x > y ? 1 : 0; }
  return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
}
function matchField(v: unknown, c: unknown): boolean {
  if (c && typeof c === 'object' && !Array.isArray(c) && !(c instanceof Date)) {
    const o = c as Row;
    if ('in' in o && !(o['in'] as unknown[]).includes(v)) return false;
    if ('lt' in o && !(cmp(v, o['lt']) < 0)) return false;
    if ('lte' in o && !(cmp(v, o['lte']) <= 0)) return false;
    if ('gt' in o && !(cmp(v, o['gt']) > 0)) return false;
    if ('gte' in o && !(cmp(v, o['gte']) >= 0)) return false;
    return true;
  }
  return v === c;
}
function match(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, c]) => {
    if (k === 'NOT') return !match(row, c as Row);
    if (k === 'folder') {
      const f = db.folders.find((x) => x['id'] === row['folderId']);
      return !!f && match(f, c as Row);
    }
    return matchField(row[k], c);
  });
}
function applyData(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && 'increment' in (v as Row)) {
      const inc = (v as Row)['increment'];
      row[k] = typeof row[k] === 'bigint' ? (row[k] as bigint) + BigInt(inc as number) : (row[k] as number) + Number(inc);
    } else row[k] = v;
  }
}
const withAttachments = (m: Row): Row => ({ ...m, attachments: db.attachments.filter((a) => a['messageId'] === m['id']).map((a) => ({ ...a })) });

const fake = {
  $on: () => undefined,
  $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(fake),
  mailbox: {
    update: async ({ where, data, select }: { where: Row; data: Row; select?: Row }) => {
      await tick();
      const r = db.mailboxes.find((m) => match(m, where));
      if (!r) throw new Error('mailbox not found');
      applyData(r, data); // atomic: no await between increment and RETURNING
      const out = { ...r };
      return select ? Object.fromEntries(Object.keys(select).map((k) => [k, out[k]])) : out;
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      await tick();
      const rows = db.mailboxes.filter((m) => match(m, where));
      for (const r of rows) applyData(r, data);
      return { count: rows.length };
    },
    findUnique: async ({ where }: { where: Row }) => { await tick(); const r = db.mailboxes.find((m) => match(m, where)); return r ? { ...r } : null; },
  },
  folder: {
    findUnique: async ({ where }: { where: Row }) => { await tick(); const r = db.folders.find((f) => match(f, where)); return r ? { ...r } : null; },
  },
  message: {
    aggregate: async ({ where }: { where: Row }) => {
      await tick();
      const rows = db.messages.filter((m) => match(m, where));
      const max = (f: string) => (rows.length ? rows.map((r) => r[f]).reduce((a, b) => (cmp(b, a) > 0 ? b : a)) : null);
      return { _max: { modSeq: max('modSeq'), uid: max('uid') } };
    },
    findMany: async ({ where, include, select }: { where: Row; include?: Row; select?: Row }) => {
      await tick();
      const rows = db.messages.filter((m) => match(m, where)).sort((a, b) => cmp(a['uid'], b['uid']));
      return rows.map((r) => {
        if (select) {
          const out: Row = {};
          for (const k of Object.keys(select)) {
            out[k] = k === 'folder' ? { mailboxId: db.folders.find((f) => f['id'] === r['folderId'])!['mailboxId'] } : r[k];
          }
          return out;
        }
        return include?.['attachments'] ? withAttachments(r) : { ...r };
      });
    },
    create: async ({ data }: { data: Row }) => {
      await tick();
      const { attachments, ...rest } = data;
      const row: Row = { id: `m${++seq}`, flags: [], deletedAt: null, createdAt: new Date(), ...rest };
      if (db.messages.some((m) => m['folderId'] === row['folderId'] && m['uid'] === row['uid'])) {
        throw new Error(`unique violation (folderId, uid) = (${String(row['folderId'])}, ${String(row['uid'])})`);
      }
      db.messages.push(row);
      for (const a of ((attachments as Row | undefined)?.['create'] as Row[] | undefined) ?? []) {
        db.attachments.push({ id: `a${++seq}`, messageId: row['id'], ...a });
      }
      return { ...row };
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      await tick();
      const r = db.messages.find((m) => match(m, where));
      if (!r) throw new Error('message not found');
      const next = { ...r, ...data };
      if (db.messages.some((m) => m !== r && m['folderId'] === next['folderId'] && m['uid'] === next['uid'])) {
        throw new Error('unique violation on update');
      }
      applyData(r, data);
      return { ...r };
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      await tick();
      const rows = db.messages.filter((m) => match(m, where));
      for (const r of rows) applyData(r, data);
      return { count: rows.length };
    },
  },
};
(globalThis as Record<string, unknown>)['__prisma'] = fake;

const { prisma } = await import('./prisma/index.js');
const store = await import('./message-store.js');

function msg(id: string, folderId: string, uid: number, modSeq: bigint, extra: Row = {}): Row {
  return { id, folderId, uid, modSeq, flags: [], subject: id, deletedAt: null, createdAt: new Date(), storagePath: null, ...extra };
}
const mailbox = (): Row => db.mailboxes[0]!;
const byId = (id: string): Row => db.messages.find((m) => m['id'] === id)!;

beforeEach(() => {
  store.resetMessageStoreCache();
  seq = 0;
  db.mailboxes = [{ id: 'mb1', uidNext: 4, highestModSeq: 3n, uidValidity: 1 }];
  db.folders = [
    { id: 'inbox', mailboxId: 'mb1', name: 'INBOX' },
    { id: 'archive', mailboxId: 'mb1', name: 'Archive' },
  ];
  db.messages = [msg('a', 'inbox', 1, 1n), msg('b', 'inbox', 2, 2n), msg('c', 'inbox', 3, 3n)];
  db.attachments = [{ id: 'att1', messageId: 'b', filename: 'x.pdf', mimeType: 'application/pdf', size: 10, sha256: 'h', storagePath: 'attachments/b/x.pdf', inline: false, contentId: null }];
});

test('allocate returns disjoint UID blocks and strictly increasing modSeqs under interleaved concurrent calls', async () => {
  const counts = Array.from({ length: 40 }, (_, i) => (i % 4) + 1); // 1..4 UIDs each
  const results = await Promise.all(counts.map((n) => prisma.$transaction((tx) => store.allocate(tx, 'mb1', n))));

  const modSeqs = results.map((r) => r.modSeq);
  assert.equal(new Set(modSeqs.map(String)).size, results.length, 'duplicate modSeq handed out');
  const uids = results.flatMap((r, i) => Array.from({ length: counts[i]! }, (_, k) => r.firstUid + k));
  assert.equal(new Set(uids).size, uids.length, 'duplicate UID handed out');
  assert.deepEqual([...uids].sort((x, y) => x - y), Array.from({ length: uids.length }, (_, k) => 4 + k));
  assert.equal(mailbox()['uidNext'], 4 + uids.length);
  assert.equal(mailbox()['highestModSeq'], 3n + BigInt(results.length));
  const sorted = [...modSeqs].sort((x, y) => (x < y ? -1 : 1));
  assert.deepEqual(sorted, Array.from({ length: results.length }, (_, k) => 4n + BigInt(k)));
});

test('allocate(…, 0) / nextModSeq bumps only the modSeq', async () => {
  const m = await prisma.$transaction((tx) => store.nextModSeq(tx, 'mb1'));
  assert.equal(m, 4n);
  assert.equal(mailbox()['uidNext'], 4);
});

test('first allocation lifts legacy counters above Date.now() modSeqs and stray UIDs', async () => {
  const legacy = 1_761_580_000_000n;
  db.messages.push(msg('old', 'archive', 40, legacy)); // written by pre-message-store code
  const a = await prisma.$transaction((tx) => store.allocate(tx, 'mb1', 1));
  assert.equal(a.modSeq, legacy + 1n);
  assert.equal(a.firstUid, 41);
  const b = await prisma.$transaction((tx) => store.allocate(tx, 'mb1', 1));
  assert.equal(b.modSeq, legacy + 2n);
  assert.equal(b.firstUid, 42);
});

test('createMessages assigns consecutive UIDs and one modSeq; the next create does not collide', async () => {
  const created = await prisma.$transaction((tx) => store.createMessages(tx, 'mb1', 'inbox', [
    { subject: 'x', date: new Date(), flags: [] }, { subject: 'y', date: new Date(), flags: [] },
  ] as never));
  assert.deepEqual(created.map((m) => m.uid), [4, 5]);
  assert.deepEqual(created.map((m) => m.modSeq), [4n, 4n]);
  assert.equal(created[0]!.changeKey, '4');
  const next = await prisma.$transaction((tx) => store.createMessage(tx, 'mb1', 'inbox', { subject: 'z', date: new Date() } as never));
  assert.equal(next.uid, 6);
  assert.equal(next.modSeq, 5n);
});

test('moveMessages assigns a new UID in the target and a new modSeq, keeping the row id', async () => {
  const { mapping, modSeq } = await prisma.$transaction((tx) => store.moveMessages(tx, ['c', 'a'], 'archive'));
  assert.equal(modSeq, 4n);
  assert.deepEqual(mapping, [{ id: 'a', oldUid: 1, newUid: 4 }, { id: 'c', oldUid: 3, newUid: 5 }]);
  assert.equal(byId('a')['folderId'], 'archive');
  assert.equal(byId('a')['uid'], 4);
  assert.equal(byId('a')['modSeq'], 4n);
  assert.equal(byId('c')['uid'], 5);
  assert.equal(mailbox()['uidNext'], 6);
  assert.equal(mailbox()['highestModSeq'], 4n);
  // a message already in the target folder is not touched
  const again = await prisma.$transaction((tx) => store.moveMessages(tx, ['a'], 'archive'));
  assert.deepEqual(again.mapping, []);
  assert.equal(byId('a')['uid'], 4);
});

test('createdModSeq marks when a row entered its mailbox (create, copy, cross-mailbox move only)', async () => {
  db.mailboxes.push({ id: 'mb2', uidNext: 1, highestModSeq: 0n, uidValidity: 1 });
  db.folders.push({ id: 'other', mailboxId: 'mb2', name: 'INBOX' });
  byId('a')['createdModSeq'] = 1n;
  const created = await prisma.$transaction((tx) => store.createMessage(tx, 'mb1', 'inbox', { subject: 'n', date: new Date() } as never));
  assert.equal(created.createdModSeq, created.modSeq);
  const { mapping, modSeq } = await prisma.$transaction((tx) => store.copyMessages(tx, ['a'], 'archive'));
  assert.equal(byId(mapping[0]!.newId)['createdModSeq'], modSeq);
  // same-mailbox move: not a creation — the marker stays
  await prisma.$transaction((tx) => store.moveMessages(tx, ['a'], 'archive'));
  assert.equal(byId('a')['createdModSeq'], 1n);
  // into another mailbox: a creation from the target's point of view
  const moved = await prisma.$transaction((tx) => store.moveMessages(tx, ['b'], 'other'));
  assert.equal(byId('b')['createdModSeq'], moved.modSeq);
});

test('copyMessages never reuses source UIDs and duplicates attachment rows', async () => {
  // Stale snapshot of the mailbox, as the old IMAP COPY used it: uidNext=4.
  await prisma.$transaction((tx) => store.allocate(tx, 'mb1', 2)); // concurrent writer takes 4,5
  const { mapping, modSeq } = await prisma.$transaction((tx) => store.copyMessages(tx, ['b', 'a'], 'archive'));
  assert.deepEqual(mapping.map((m) => [m.oldUid, m.newUid]), [[1, 6], [2, 7]]);
  for (const m of mapping) {
    assert.notEqual(m.newId, m.id);
    const copy = byId(m.newId);
    assert.equal(copy['folderId'], 'archive');
    assert.equal(copy['modSeq'], modSeq);
    assert.equal(copy['subject'], byId(m.id)['subject']);
  }
  const bCopy = mapping.find((m) => m.id === 'b')!.newId;
  const atts = db.attachments.filter((a) => a['messageId'] === bCopy);
  assert.equal(atts.length, 1);
  assert.equal(atts[0]!['storagePath'], 'attachments/b/x.pdf');
  // sources unchanged
  assert.equal(byId('a')['folderId'], 'inbox');
  assert.equal(byId('a')['uid'], 1);
});

test('setFlags bumps message modSeq and mailbox HIGHESTMODSEQ (CONDSTORE invariant)', async () => {
  const out = await prisma.$transaction((tx) => store.setFlags(tx, [{ id: 'a', flags: ['\\Seen'] }, { id: 'b', flags: [] }]));
  assert.deepEqual(out.map((o) => o.modSeq), [4n, 4n]);
  assert.deepEqual(byId('a')['flags'], ['\\Seen']);
  assert.equal(byId('a')['modSeq'], 4n);
  const highest = mailbox()['highestModSeq'] as bigint;
  for (const m of db.messages) assert.ok((m['modSeq'] as bigint) <= highest, 'message MODSEQ above HIGHESTMODSEQ');
  const again = await prisma.$transaction((tx) => store.setFlags(tx, [{ id: 'a', flags: [] }], { mailboxId: 'mb1' }));
  assert.equal(again[0]!.modSeq, 5n);
});

test('modifyFlags computes from the flags read after the modSeq lock; null leaves a row alone', async () => {
  byId('a')['flags'] = ['\\Answered']; // e.g. committed by another client after the caller's own read
  const out = await prisma.$transaction((tx) => store.modifyFlags(
    tx, ['a', 'b'], (flags, _modSeq, id) => (id === 'b' ? null : [...flags, '\\Flagged']), { mailboxId: 'mb1' },
  ));
  assert.deepEqual(out, [{ id: 'a', flags: ['\\Answered', '\\Flagged'], modSeq: 4n }]);
  assert.deepEqual(byId('a')['flags'], ['\\Answered', '\\Flagged']);
  assert.equal(byId('b')['modSeq'], 2n, 'unchanged row keeps its modSeq');
  assert.equal(mailbox()['highestModSeq'], 4n);
});

test('touchMessages and expunge give changed rows a fresh modSeq', async () => {
  await prisma.$transaction((tx) => store.touchMessages(tx, ['c'], { pinnedAt: new Date(0) }));
  assert.equal(byId('c')['modSeq'], 4n);
  await prisma.$transaction((tx) => store.expunge(tx, ['b'], { mailboxId: 'mb1' }));
  assert.ok(byId('b')['deletedAt'] instanceof Date);
  assert.equal(byId('b')['modSeq'], 5n);
  assert.equal(mailbox()['highestModSeq'], 5n);
});

test('expunge with a where scope leaves rows alone that moved away or are already deleted', async () => {
  // POP3 QUIT (RFC 1939 §6): a message DELE'd in INBOX and moved to Archive by
  // another client before QUIT must survive; an already-deleted row keeps its deletedAt.
  await prisma.$transaction((tx) => store.moveMessages(tx, ['a'], 'archive', { targetMailboxId: 'mb1' }));
  const earlier = new Date(0);
  byId('c')['deletedAt'] = earlier;
  await prisma.$transaction((tx) => store.expunge(tx, ['a', 'b', 'c'], {
    mailboxId: 'mb1',
    where: { folderId: 'inbox', deletedAt: null },
  }));
  assert.equal(byId('a')['deletedAt'], null, 'moved message was expunged in its new folder');
  assert.ok(byId('b')['deletedAt'] instanceof Date);
  assert.equal(byId('c')['deletedAt'], earlier);
});
