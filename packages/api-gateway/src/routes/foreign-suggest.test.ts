/**
 * 10.2: GET …/search/suggest of shared / delegated mailboxes — exactly the folders
 * the caller may read (the same rule as …/search, folder-access.ts), never more;
 * no access → 403 like every other route of the mailbox.
 * Fixture: test-support/foreign-mailbox-fixture.ts (erin's mailbox mb-erin; frank =
 * READ_ONLY delegate, hank = folder permissions only, bob = SEND_AS only;
 * alice: FULL_ACCESS on sm1, READ_ONLY on sm2; carol: sm3 inactive).
 * Run: node --import tsx --test --test-force-exit src/routes/foreign-suggest.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addFolder, addMessage, addFolderPerm, rawQueries, tok, call, D, S, type Row } from '../test-support/foreign-mailbox-fixture.js';

const { ROLE_RIGHTS } = await import('@coremail/storage');
// suggestion rate limit: in-memory counters instead of Redis (read per request)
const counters = new Map<string, number>();
(globalThis as Record<string, unknown>)['__rateLimitRedis'] = {
  incr: async (k: string) => { const n = (counters.get(k) ?? 0) + 1; counters.set(k, n); return n; },
  expire: async () => 1,
};

const ERIN = D('mb-erin');
const ids = (r: { json: Row }) => ((r.json['messages'] as Row[]) ?? []).map((m) => m['id']).sort();

/** erin: INBOX (m-erin), Trash, Sent (m-sent), Projekte (m-p1) with Sub (m-s1), Privat (m-x). */
function erinTree(): void {
  addFolder('f-erin-sent', 'mb-erin', 'Sent');
  addFolder('f-erin-proj', 'mb-erin', 'Projekte');
  addFolder('f-erin-sub', 'mb-erin', 'Sub', 'f-erin-proj');
  addFolder('f-erin-priv', 'mb-erin', 'Privat');
  addMessage('m-sent', 'f-erin-sent', { subject: 'Angebot', fromAddr: 'erin@ex.com', fromName: 'Erin' });
  addMessage('m-p1', 'f-erin-proj');
  addMessage('m-s1', 'f-erin-sub', { fromName: 'Anna', fromAddr: 'anna@kunde.de' });
  addMessage('m-x', 'f-erin-priv', { fromName: 'Geheim', fromAddr: 'secret@ex.com' });
}

test('READ_ONLY delegate: every folder of the mailbox, recipients from its Sent folder', async () => {
  erinTree();
  const r = await call('GET', `${ERIN}/search/suggest?q=an`, tok('frank'));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(ids(r), ['m-erin', 'm-p1', 'm-s1', 'm-sent', 'm-x']);
  const sent = (r.json['messages'] as Row[]).find((m) => m['id'] === 'm-sent')!;
  assert.deepEqual(Object.keys(sent).sort(), ['date', 'folderId', 'folderName', 'fromAddr', 'fromName', 'id', 'subject']);
  assert.equal(sent['folderName'], 'Sent');
  assert.equal(rawQueries.length, 1);
  assert.equal(rawQueries[0]![1], 'f-erin-sent');
});

test('folder permissions only: just the granted folders — no other folder, no Sent recipients', async () => {
  erinTree();
  addFolderPerm('f-erin-sub', 'user:hank', ROLE_RIGHTS.reviewer);
  const r = await call('GET', `${ERIN}/search/suggest?q=an`, tok('hank'));
  assert.equal(r.status, 200);
  assert.deepEqual(ids(r), ['m-s1']);
  assert.deepEqual((r.json['people'] as Row[]).map((p) => p['address']), ['anna@kunde.de']);
  assert.equal(rawQueries.length, 0, 'the Sent folder is not readable → no recipient query');
  assert.doesNotMatch(JSON.stringify(r.json), /secret@ex\.com|Geheim|m-x|m-erin/);

  // visible-only (no read right) adds nothing
  addFolderPerm('f-erin-priv', 'user:hank', 0x400);
  assert.deepEqual(ids(await call('GET', `${ERIN}/search/suggest?q=an`, tok('hank'))), ['m-s1']);

  // a read grant on Sent adds it and its recipients
  addFolderPerm('f-erin-sent', 'user:hank', ROLE_RIGHTS.reviewer);
  const withSent = await call('GET', `${ERIN}/search/suggest?q=an`, tok('hank'));
  assert.deepEqual(ids(withSent), ['m-s1', 'm-sent']);
  assert.equal(rawQueries.at(-1)![1], 'f-erin-sent');
});

test('no read access → 403 NO_ACCESS (SEND_AS only, unknown or inactive mailbox, no token → 401)', async () => {
  erinTree();
  for (const [path, user] of [
    [ERIN, 'bob'],          // SEND_AS only
    [ERIN, 'alice'],        // no grant at all
    [D('mb-nope'), 'frank'],
    [S('sm3'), 'carol'],    // inactive shared mailbox
    [S('sm1'), 'bob'],      // SEND_AS only
  ] as const) {
    const r = await call('GET', `${path}/search/suggest?q=an`, tok(user));
    assert.deepEqual([r.status, r.json['code']], [403, 'NO_ACCESS'], `${user} ${path}`);
  }
  // the access check comes first — a too short query is no oracle
  assert.equal((await call('GET', `${ERIN}/search/suggest?q=a`, tok('bob'))).status, 403);
  assert.equal((await call('GET', `${ERIN}/search/suggest?q=an`)).status, 401);
  assert.equal(rawQueries.length, 0);
});

test('shared mailbox: FULL_ACCESS and READ_ONLY see their mailbox only; a short query answers empty', async () => {
  const full = await call('GET', `${S('sm1')}/search/suggest?q=an`, tok('alice'));
  assert.equal(full.status, 200);
  assert.deepEqual(ids(full), ['m-sm1']);
  const ro = await call('GET', `${S('sm2')}/search/suggest?q=an`, tok('alice'));
  assert.deepEqual(ids(ro), ['m-sm2']);
  assert.deepEqual((await call('GET', `${S('sm1')}/search/suggest?q=a`, tok('alice'))).json, { people: [], messages: [] });
});
