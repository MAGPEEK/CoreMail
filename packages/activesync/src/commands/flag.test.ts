/**
 * 9.4: email:Flag ([MS-ASEMAIL] 2.2.2.34 / 3.2.5.4.2) — building the element from the
 * follow-up flag, parsing client flags, and the Sync round trip both directions
 * (Add carries the flag, a client Change sets it through the message store, an
 * invalid flag is answered with Status 6 in airsync:Responses).
 * Run: node --import tsx --test src/commands/flag.test.ts  (in packages/activesync)
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { messageRow, find, clientWbxml, testEnv, type ClientNode } from './test-fixtures.js';

testEnv();
let device: { id: string; syncKeys: Record<string, string> };
let row: Record<string, unknown> = messageRow();
let writes: Array<Record<string, unknown>> = [];
const txFake = {
  mailbox: { update: async () => ({ uidNext: 2, highestModSeq: 6n }), updateMany: async () => ({ count: 0 }) },
  message: {
    aggregate: async () => ({ _max: { modSeq: 5n, uid: 1 } }),
    findMany: async () => [{ ...row, folderId: 'inbox' }],
    update: async ({ data }: { data: Record<string, unknown> }) => { writes.push(data); return {}; },
  },
};
(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(txFake),
  $executeRaw: async (_sql: TemplateStringsArray, json: string) => { device.syncKeys = { ...device.syncKeys, ...JSON.parse(json) }; return 1; },
  folder: { findFirst: async () => ({ id: 'inbox', mailboxId: 'mb1' }) },
  activeSyncDevice: { findUnique: async () => ({ ...device, syncKeys: { ...device.syncKeys } }), update: async () => ({}) },
  mailbox: { findUnique: async () => ({ highestModSeq: 5n }), updateMany: async () => ({ count: 0 }) },
  activeSyncItem: { findMany: async () => [], deleteMany: async () => ({ count: 0 }), createMany: async () => ({ count: 0 }) },
  message: {
    aggregate: async () => ({ _max: { modSeq: 5n, uid: 1 } }),
    findMany: async () => [row],
    findFirst: async () => row,
  },
  attachment: { findMany: async () => [] },
};

const { handleSync } = await import('./sync.js');
const { decodeWbxml, encodeWbxml, CP } = await import('../wbxml.js');
const { buildFlag, parseClientFlag } = await import('./flag.js');

beforeEach(() => { device = { id: 'd1', syncKeys: {} }; row = messageRow(); writes = []; });

const d = (iso: string): Date => new Date(iso);
const kids = (e: { children?: unknown[] }) => (e.children ?? []).map((c) => {
  const x = c as { name: string; page?: number; text?: string };
  return `${x.page === CP.Tasks ? 'tasks:' : ''}${x.name}=${x.text ?? ''}`;
});

test('buildFlag: empty when not flagged; active with dates and reminder; complete with completion time', () => {
  const none = buildFlag({ status: 'none', startAt: null, dueAt: null, reminderAt: null, completedAt: null });
  assert.deepEqual(none.children, []);
  const active = buildFlag({ status: 'flagged', startAt: d('2026-03-02T00:00:00Z'), dueAt: d('2026-03-06T00:00:00Z'), reminderAt: d('2026-03-06T08:00:00Z'), completedAt: null });
  assert.deepEqual(kids(active), [
    'FlagStatus=2', 'FlagType=Flag for follow up',
    'tasks:StartDate=2026-03-02T00:00:00.000Z', 'tasks:UtcStartDate=2026-03-02T00:00:00.000Z',
    'tasks:DueDate=2026-03-06T00:00:00.000Z', 'tasks:UtcDueDate=2026-03-06T00:00:00.000Z',
    'tasks:ReminderSet=1', 'tasks:ReminderTime=2026-03-06T08:00:00.000Z',
  ]);
  const done = buildFlag({ status: 'complete', startAt: null, dueAt: null, reminderAt: null, completedAt: d('2026-03-05T12:00:00Z') });
  assert.deepEqual(kids(done), ['FlagStatus=1', 'FlagType=Flag for follow up', 'tasks:DateCompleted=2026-03-05T12:00:00.000Z', 'CompleteTime=2026-03-05T12:00:00.000Z']);
  // byte level: Flag on page 2 (0x3a), its Status 0x3b on page 2, the dates on page 9
  const bytes = encodeWbxml(active);
  assert.equal(bytes[4], 0x00); // SWITCH_PAGE
  assert.equal(bytes[5], 2);
  assert.equal(bytes[6], 0x3a | 0x40);
  assert.ok(bytes.includes(9), 'switches to the Tasks page');
});

const F = (children: ClientNode[]): ClientNode => [2, 0x3a, children];
const parse = (node: ClientNode) => parseClientFlag(decodeWbxml(clientWbxml(node)));

test('parseClientFlag: clear / complete / active, and the Status 6 cases', () => {
  assert.deepEqual(parse(F([])), { ok: true, state: { status: 'none' } });
  assert.deepEqual(parse(F([[2, 0x3b, '0']])), { ok: true, state: { status: 'none' } });
  assert.deepEqual(parse(F([[2, 0x3b, '1'], [2, 0x3e, '2026-03-05T12:00:00.000Z'], [9, 0x0b, '2026-03-05T12:00:00.000Z']])),
    { ok: true, state: { status: 'complete', completedAt: d('2026-03-05T12:00:00Z') } });
  const dates: ClientNode[] = [[9, 0x1e, '2026-03-02T01:00:00.000Z'], [9, 0x1f, '2026-03-02T00:00:00.000Z'], [9, 0x0c, '2026-03-06T01:00:00.000Z'], [9, 0x0d, '2026-03-06T00:00:00.000Z']];
  assert.deepEqual(parse(F([[2, 0x3b, '2'], [2, 0x3d, 'Flag for follow up'], ...dates, [9, 0x1b, '1'], [9, 0x1c, '2026-03-06T07:00:00.000Z']])),
    { ok: true, state: { status: 'flagged', startAt: d('2026-03-02T00:00:00Z'), dueAt: d('2026-03-06T00:00:00Z'), reminderAt: d('2026-03-06T07:00:00Z') } },
    'Utc* values win');
  assert.deepEqual(parse(F([[2, 0x3b, '2'], [2, 0x3d, 'Flag for follow up']])),
    { ok: true, state: { status: 'flagged', startAt: null, dueAt: null, reminderAt: null } }, 'no dates at all is valid');
  const invalid: Array<[string, ClientNode]> = [
    ['status 3', F([[2, 0x3b, '3']])],
    ['active without FlagType', F([[2, 0x3b, '2'], ...dates])],
    ['only a due date', F([[2, 0x3b, '2'], [2, 0x3d, 'x'], [9, 0x0d, '2026-03-06T00:00:00.000Z']])],
    ['start and due without the local dates', F([[2, 0x3b, '2'], [2, 0x3d, 'x'], [9, 0x1f, '2026-03-02T00:00:00.000Z'], [9, 0x0d, '2026-03-06T00:00:00.000Z']])],
    ['due before start', F([[2, 0x3b, '2'], [2, 0x3d, 'x'], [9, 0x1e, '2026-03-07T00:00:00.000Z'], [9, 0x1f, '2026-03-07T00:00:00.000Z'], [9, 0x0c, '2026-03-06T00:00:00.000Z'], [9, 0x0d, '2026-03-06T00:00:00.000Z']])],
    ['complete without DateCompleted', F([[2, 0x3b, '1'], [2, 0x3e, '2026-03-05T12:00:00.000Z']])],
  ];
  for (const [name, node] of invalid) assert.deepEqual(parse(node), { ok: false }, name);
});

function syncReq(extra: ClientNode[] = []) {
  return decodeWbxml(clientWbxml([0, 0x05, [[0, 0x1c, [[0, 0x0f, [[0, 0x0b, '1'], [0, 0x12, 'inbox'], [0, 0x13], ...extra]]]]]]));
}
const change = (flag: ClientNode): ClientNode => [0, 0x16, [[0, 0x08, [[0, 0x0d, 'msg1'], [0, 0x1d, [flag]]]]]];

test('Sync Add carries the follow-up flag of the message (legacy \\Flagged rows included)', async () => {
  row = messageRow({ flags: ['\\Seen', '\\Flagged'], flagStatus: 'flagged', flagStartAt: d('2026-03-02T00:00:00Z'), flagDueAt: d('2026-03-06T00:00:00Z') });
  const tree = decodeWbxml(await handleSync(syncReq(), 'u1', 'dev1'));
  const flag = find(tree, 'Flag', CP.Email)!;
  assert.equal(find(flag, 'FlagStatus', CP.Email)?.text, '2');
  assert.equal(find(flag, 'UtcDueDate', CP.Tasks)?.text, '2026-03-06T00:00:00.000Z');
  row = messageRow({ flags: ['\\Flagged'] });
  const legacy = decodeWbxml(await handleSync(syncReq(), 'u1', 'dev1'));
  assert.equal(find(find(legacy, 'Flag', CP.Email)!, 'FlagStatus', CP.Email)?.text, '2');
  row = messageRow();
  const plain = decodeWbxml(await handleSync(syncReq(), 'u1', 'dev1'));
  assert.deepEqual(find(plain, 'Flag', CP.Email)?.children ?? [], []);
});

test('Sync client Change: flag with dates → message store (\\Flagged + columns); invalid flag → Responses Status 6', async () => {
  await handleSync(syncReq([change(F([[2, 0x3b, '2'], [2, 0x3d, 'Flag for follow up'], [9, 0x1f, '2026-03-02T00:00:00.000Z'], [9, 0x0d, '2026-03-06T00:00:00.000Z']]))]), 'u1', 'dev1');
  assert.equal(writes.length, 0, 'Utc dates without the local ones are refused');

  const ok = await handleSync(syncReq([change(F([[2, 0x3b, '2'], [2, 0x3d, 'Flag for follow up'],
    [9, 0x1f, '2026-03-02T00:00:00.000Z'], [9, 0x0d, '2026-03-06T00:00:00.000Z'], [9, 0x1e, '2026-03-02T00:00:00.000Z'], [9, 0x0c, '2026-03-06T00:00:00.000Z']]))]), 'u1', 'dev1');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0]!['flags'], ['\\Seen', '\\Flagged']);
  assert.equal(writes[0]!['flagStatus'], 'flagged');
  assert.equal((writes[0]!['flagDueAt'] as Date).toISOString(), '2026-03-06T00:00:00.000Z');
  assert.equal(find(decodeWbxml(ok), 'Responses'), undefined);

  const bad = decodeWbxml(await handleSync(syncReq([change(F([[2, 0x3b, '7']]))]), 'u1', 'dev1'));
  const responses = find(bad, 'Responses')!;
  assert.equal(find(responses, 'ServerId')?.text, 'msg1');
  assert.equal(find(responses, 'Status')?.text, '6');
});
