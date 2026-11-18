import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';

/**
 * 9.4: inbox rule action "set importance" — the outcome of applyMailRules (the
 * SMTP delivery stores it as Message.importance via storage deliveredImportance)
 * and "run now" on existing messages, which writes the column through the
 * message store (new modSeq). Prisma is faked through the globalThis.__prisma seam.
 */
type W = Record<string, unknown>;
const rule = (actions: unknown[], conditions: unknown[] = [{ field: 'from', operator: 'contains', value: 'boss' }]) => ({
  id: 'r1', userId: 'owner', name: 'r', enabled: true, priority: 0,
  conditions, exceptions: [], actions, stopProcessing: false, matchAll: true,
});
let rules: ReturnType<typeof rule>[] = [];
let stored: W[] = [];
const updates: Array<{ where: W; data: W }> = [];

const prismaFake: W = {
  $on: () => undefined,
  mailRule: {
    findMany: async () => rules,
    findFirst: async ({ where }: { where: W }) => (where['userId'] === 'owner' ? rules[0] ?? null : null),
  },
  folder: { findFirst: async () => null },
  message: {
    findMany: async ({ where }: { where: W }) => {
      if ((where['id'] as W | undefined)?.['in']) {
        const ids = (where['id'] as { in: string[] }).in;
        return stored.filter((m) => ids.includes(m['id'] as string)).map((m) => ({ id: m['id'], folderId: 'f-in', folder: { mailboxId: 'mb1' } }));
      }
      return stored;
    },
    aggregate: async () => ({ _max: { modSeq: 0n, uid: 0 } }),
    updateMany: async (args: { where: W; data: W }) => { updates.push(args); return { count: 1 }; },
  },
  mailbox: {
    updateMany: async () => ({ count: 0 }),
    update: async () => ({ uidNext: 10, highestModSeq: 7n }),
  },
  messageCategory: { upsert: async () => ({}) },
};
prismaFake['$transaction'] = async (fn: (tx: unknown) => Promise<unknown>) => fn(prismaFake);
(globalThis as Record<string, unknown>)['__prisma'] = prismaFake;

const { applyMailRules, runRuleOnExisting } = await import('./mail-rules.js');
const { deliveredImportance } = await import('./importance.js');

const parsed = (fromAddr: string, importance: 'high' | 'low' | null = null) => ({
  subject: 's', fromAddr, fromName: '', toAddrs: ['owner@corp.test'], ccAddrs: [], bccAddrs: [],
  replyTo: null, messageId: '<m@x>', inReplyTo: null, references: [],
  dispositionNotificationTo: null, importance, date: new Date(), bodyText: 'b', bodyHtml: null,
  attachments: [], size: 100,
});

const dbMessage = (id: string, fromAddr: string, importance: string | null) => ({
  id, folderId: 'f-in', flags: [], subject: 's', fromAddr, fromName: '', toAddrs: ['owner@corp.test'],
  ccAddrs: [], bccAddrs: [], replyTo: null, messageId: `<${id}@x>`, inReplyTo: null,
  date: new Date(), bodyText: 'b', bodyHtml: null, rawSize: 100, importance,
});

beforeEach(() => { rules = []; stored = []; updates.length = 0; });

test('delivery: a matching rule sets the importance the message is stored with', async () => {
  rules = [rule([{ type: 'setImportance', value: 'high' }])];
  const hit = await applyMailRules(parsed('boss@corp.test') as never, 'owner', 'owner@corp.test', 'f-in');
  assert.equal(hit.importance, 'high');
  assert.equal(deliveredImportance(null, hit.importance), 'high', 'stored value of a plain mail');

  const miss = await applyMailRules(parsed('other@corp.test', 'low') as never, 'owner', 'owner@corp.test', 'f-in');
  assert.equal(miss.importance, null, 'no matching rule');
  assert.equal(deliveredImportance('low', miss.importance), 'low', 'the header value stays');

  rules = [rule([{ type: 'setImportance', value: 'normal' }])];
  const lowered = await applyMailRules(parsed('boss@corp.test', 'high') as never, 'owner', 'owner@corp.test', 'f-in');
  assert.equal(deliveredImportance('high', lowered.importance), null, 'set to normal: stored as null');
});

test('run now: "set importance" writes the column through the message store, unchanged rows are not touched', async () => {
  rules = [rule([{ type: 'setImportance', value: 'low' }])];
  stored = [dbMessage('m1', 'boss@corp.test', null), dbMessage('m2', 'boss@corp.test', 'low'), dbMessage('m3', 'x@corp.test', null)];
  const res = await runRuleOnExisting('r1', 'owner', 'owner@corp.test');
  assert.equal(res.matched, 2);
  assert.equal(res.errors, 0);
  assert.equal(updates.length, 1, 'only the message whose importance changes');
  assert.deepEqual(updates[0]!.where['id'], { in: ['m1'] });
  assert.equal(updates[0]!.data['importance'], 'low');
  assert.equal(updates[0]!.data['modSeq'], 7n, 'a new modSeq from the message store');
});

test('run now: "normal" clears a stored importance', async () => {
  rules = [rule([{ type: 'setImportance', value: 'normal' }])];
  stored = [dbMessage('m1', 'boss@corp.test', 'high')];
  await runRuleOnExisting('r1', 'owner', 'owner@corp.test');
  assert.equal(updates.length, 1);
  assert.equal(updates[0]!.data['importance'], null);
});
