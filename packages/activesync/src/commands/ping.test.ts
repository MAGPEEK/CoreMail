/**
 * Review 7.1.0: the Ping response used the request shape (`<Folder><Id/><Class/></Folder>`),
 * so clients could not tell which folder changed; changes before the Ping started were missed
 * (message-count baseline), flag changes/moves were never detected, the heartbeat had no lower
 * bound (NaN → tight loop), unknown folders/missing parameters were not reported (Status 3/7)
 * and an abandoned Ping kept polling for up to 59 minutes.
 * Run: node --import tsx --test src/commands/ping.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installFakeDb, clientWbxml, type WNode } from '../test-support/fake-db.js';

const db = installFakeDb({
  mailbox: [{ id: 'mb1', userId: 'u1', uidNext: 10, highestModSeq: 8n }],
  folder: [{ id: 'inbox', mailboxId: 'mb1', name: 'INBOX' }, { id: 'archive', mailboxId: 'mb1', name: 'Archive' }, { id: 'foreign', mailboxId: 'mb2', name: 'INBOX' }],
  message: [
    { id: 'm1', folderId: 'inbox', uid: 1, modSeq: 3n, flags: [], deletedAt: null },
    { id: 'm2', folderId: 'archive', uid: 2, modSeq: 4n, flags: [], deletedAt: null },
  ],
  // the device last received SyncKey 9 for both folders (= highestModSeq + 1: up to date)
  activeSyncDevice: [{ id: 'd1', userId: 'u1', deviceId: 'dev1', status: 'OK', policyKey: '42', syncKeys: { inbox: '9', archive: '9' } }],
  activeSyncItem: [],
});
db.tables['mailbox']!.push({ id: 'mb2', userId: 'u2', uidNext: 1, highestModSeq: 1n });

const { handlePing } = await import('./ping.js');
const { decodeWbxml } = await import('../wbxml.js');
type E = import('../wbxml.js').WbxmlElement;

/** Minimal Express Response stand-in. */
class FakeRes extends EventEmitter {
  statusCode = 0; body: Buffer | null = null; writableEnded = false; headers: Record<string, string> = {};
  set(k: string, v: string) { this.headers[k.toLowerCase()] = v; return this; }
  setHeader(k: string, v: string) { return this.set(k, v); }
  removeHeader(k: string) { delete this.headers[k.toLowerCase()]; }
  status(c: number) { this.statusCode = c; return this; }
  send(b: Buffer | string) { this.body = Buffer.isBuffer(b) ? b : Buffer.from(b); this.writableEnded = true; this.emit('finish'); return this; }
}
const P = (t: number, k?: WNode[] | string): WNode => [13, t, k];
const pingReq = (hb: string | null, folders: string[]) => decodeWbxml(clientWbxml(P(0x05, [
  ...(hb === null ? [] : [P(0x08, hb)]),
  ...(folders.length ? [P(0x09, folders.map((f) => P(0x0a, [P(0x0b, f), P(0x0c, 'Email')])))] : []),
])));
const kid = (e: E | undefined, name: string): E | undefined => e?.children?.find((c): c is E => typeof c !== 'string' && c.name === name);
async function ping(body: E | null, opts: { pollIntervalMs?: number } = {}) {
  const res = new FakeRes();
  await handlePing(body, 'u1', res as never, {}, { deviceId: 'dev1', pollIntervalMs: opts.pollIntervalMs ?? 5, minHeartbeatSec: 60 });
  return { res, tree: res.body ? decodeWbxml(res.body) : null };
}
function bump(id: string, modSeq: bigint, over: Record<string, unknown> = {}) {
  Object.assign(db.tables['message']!.find((m) => m['id'] === id)!, { modSeq, ...over });
  db.tables['mailbox']![0]!['highestModSeq'] = modSeq;
}

test('change before the Ping started → immediate Status 2 with <Folders><Folder>serverId</Folder></Folders>', async () => {
  db.tables['message']!.push({ id: 'm3', folderId: 'inbox', uid: 3, modSeq: 9n, flags: [], deletedAt: null });
  db.tables['mailbox']![0]!['highestModSeq'] = 9n; // arrived after the device's last Sync (key 9)
  const t0 = Date.now();
  const { res } = await ping(pingReq('480', ['inbox', 'archive']));
  assert.ok(Date.now() - t0 < 1000, 'answered at once');
  // <Ping><Status>2</Status><Folders><Folder>inbox</Folder></Folders></Ping> — page 13: Ping 0x05,
  // Status 0x07, Folders 0x09, Folder 0x0a with the folder id as text (no Id/Class children)
  assert.deepEqual([...res.body!], [
    0x03, 0x01, 0x6a, 0x00, 0x00, 0x0d, 0x45, 0x47, 0x03, 0x32, 0x00, 0x01,
    0x49, 0x4a, 0x03, ...Buffer.from('inbox'), 0x00, 0x01, 0x01, 0x01,
  ]);
  db.tables['activeSyncDevice']![0]!['syncKeys'] = { ...(db.tables['activeSyncDevice']![0]!['syncKeys'] as object), inbox: '10' };
});

test('flag change and an item moved away are detected; an empty Ping reuses the cached parameters', async () => {
  const pending = ping(null, { pollIntervalMs: 5 });
  await new Promise((r) => setTimeout(r, 30));
  bump('m2', 10n, { flags: ['\\Seen'] });
  const { tree } = await pending;
  assert.equal(kid(tree!, 'Status')?.text, '2');
  assert.deepEqual(kid(tree!, 'Folders')!.children!.map((f) => (f as E).text), ['archive']);

  db.tables['activeSyncDevice']![0]!['syncKeys'] = { ...(db.tables['activeSyncDevice']![0]!['syncKeys'] as object), archive: '11', inbox: '11' };
  db.tables['activeSyncItem']!.push({ deviceRowId: 'd1', collectionId: 'inbox', serverId: 'm1', pendingKey: '', modSeq: 3n });
  const moved = ping(null, { pollIntervalMs: 5 });
  await new Promise((r) => setTimeout(r, 30));
  bump('m1', 11n, { folderId: 'archive' }); // moved out of the inbox by another client
  const { tree: t2 } = await moved;
  assert.deepEqual(kid(t2!, 'Folders')!.children!.map((f) => (f as E).text).sort(), ['archive', 'inbox']);
});

test('Status 3 (no parameters, nothing cached), 5 (heartbeat out of range, with the limit), 7 (unknown folder)', async () => {
  const fresh = new FakeRes();
  await handlePing(null, 'u1', fresh as never, {}, { deviceId: 'nodevice' });
  assert.equal(kid(decodeWbxml(fresh.body!), 'Status')?.text, '3');
  const nan = await ping(pingReq('soon', ['inbox']));
  assert.equal(kid(nan.tree!, 'Status')?.text, '3');
  const low = await ping(pingReq('10', ['inbox']));
  assert.deepEqual([kid(low.tree!, 'Status')?.text, kid(low.tree!, 'HeartbeatInterval')?.text], ['5', '60']);
  const high = await ping(pingReq('99999', ['inbox']));
  assert.deepEqual([kid(high.tree!, 'Status')?.text, kid(high.tree!, 'HeartbeatInterval')?.text], ['5', '3540']);
  const foreign = await ping(pingReq('480', ['inbox', 'foreign']));
  assert.equal(kid(foreign.tree!, 'Status')?.text, '7');
  const gone = await ping(pingReq('480', ['deleted-folder']));
  assert.equal(kid(gone.tree!, 'Status')?.text, '7');
});

test('client disconnect stops the polling loop', async () => {
  db.tables['activeSyncItem'] = [];
  db.tables['activeSyncDevice']![0]!['syncKeys'] = { inbox: '12' }; // up to date: nothing to report
  const res = new FakeRes();
  let polls = 0;
  const findUnique = (db['mailbox'] as { findUnique: (a: unknown) => Promise<unknown> }).findUnique;
  (db['mailbox'] as { findUnique: (a: unknown) => Promise<unknown> }).findUnique = async (a) => { polls++; return findUnique(a); };
  try {
    const done = handlePing(pingReq('480', ['inbox']), 'u1', res as never, {}, { deviceId: 'dev1', pollIntervalMs: 5 });
    await new Promise((r) => setTimeout(r, 40));
    res.emit('close');
    await done;
    const after = polls;
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(polls, after, 'no more polls after close');
    assert.equal(res.body, null, 'nothing written to a closed connection');
  } finally {
    (db['mailbox'] as { findUnique: unknown }).findUnique = findUnique;
  }
});
