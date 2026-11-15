/**
 * JMAP thread assignment (RFC 8621 §3) with the stored References chain (v9.1):
 * a message whose direct parent is not in the mailbox joins the thread of its
 * nearest known ancestor. Prisma is a small in-memory fake (globalThis.__prisma).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

type Row = Record<string, unknown>;
const rows: Row[] = [];

function matches(r: Row, where: Row): boolean {
  if ((r['mailboxId'] as string) !== (where['folder'] as Row)['mailboxId']) return false;
  const not = (where['id'] as Row | undefined)?.['not'];
  if (not !== undefined && r['id'] === not) return false;
  const mid = where['messageId'];
  if (typeof mid === 'string') return r['messageId'] === mid;
  if (mid && typeof mid === 'object') return ((mid as Row)['in'] as string[]).includes(r['messageId'] as string);
  return true;
}
const byCreated = (a: Row, b: Row): number => (a['createdAt'] as number) - (b['createdAt'] as number);
let queries = 0;
const db = {
  message: {
    findFirst: async ({ where }: { where: Row }) => { queries++; return rows.filter((r) => matches(r, where)).sort(byCreated)[0] ?? null; },
    findMany: async ({ where }: { where: Row }) => { queries++; return rows.filter((r) => matches(r, where)).sort(byCreated); },
  },
};
(globalThis as Record<string, unknown>)['__prisma'] = { $on: () => undefined, ...db };

const { resolveThreadId } = await import('./thread.js');

const add = (id: string, messageId: string, threadId: string | null, extra: Row = {}): void => {
  rows.push({ id, messageId, threadId, inReplyTo: null, references: null, mailboxId: 'mb1', createdAt: rows.length, ...extra });
};

beforeEach(() => { rows.length = 0; queries = 0; });

test('direct parent known → its thread (In-Reply-To first, unchanged)', async () => {
  add('a', '<a@x>', 'T1');
  const t = await resolveThreadId({ id: '', messageId: '<b@x>', inReplyTo: '<a@x>', references: ['<a@x>'] }, 'mb1', db as never);
  assert.equal(t, 'T1');
});

test('direct parent missing → nearest known ancestor of the References chain', async () => {
  add('root', '<root@x>', 'T-root');
  add('mid', '<mid@x>', 'T-mid');
  const t = await resolveThreadId(
    { id: '', messageId: '<new@x>', inReplyTo: '<gone@x>', references: ['<root@x>', '<mid@x>', '<gone@x>'] },
    'mb1', db as never,
  );
  assert.equal(t, 'T-mid');
});

test('References as the stored column string; ancestor without thread is resolved recursively', async () => {
  add('root', '<root@x>', 'T-root');
  add('mid', '<mid@x>', null, { inReplyTo: '<root@x>' });
  const assigned = new Map<string, string>();
  const t = await resolveThreadId({ id: '', messageId: '<new@x>', inReplyTo: null, references: '<root@x> <mid@x> <gone@x>' }, 'mb1', db as never, assigned);
  assert.equal(t, 'T-root');
  assert.equal(assigned.get('mid'), 'T-root');
});

test('other mailboxes and the message itself are ignored; nothing known → root', async () => {
  add('other', '<root@x>', 'T-other', { mailboxId: 'mb2' });
  add('self', '<self@x>', 'T-self');
  const t = await resolveThreadId({ id: 'self', messageId: '<self@x>', inReplyTo: null, references: ['<root@x>', '<self@x>'] }, 'mb1', db as never);
  assert.equal(t, null);
});

test('one query for the whole chain', async () => {
  add('root', '<root@x>', 'T-root');
  const refs = Array.from({ length: 100 }, (_, i) => `<r${i}@x>`);
  refs[0] = '<root@x>';
  await resolveThreadId({ id: '', messageId: '<new@x>', inReplyTo: '<r99@x>', references: refs }, 'mb1', db as never);
  // In-Reply-To lookup + one References lookup (+ none for the child check: root found).
  assert.equal(queries, 2);
});
