import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';

/**
 * runRuleOnExisting() must only ever touch the rule owner's own messages,
 * even when the caller passes folder ids. The Prisma client is replaced via
 * the globalThis.__prisma seam of ./prisma/index.ts and records the query.
 */
const calls: { messageWhere: unknown[]; ruleWhere: unknown[] } = { messageWhere: [], ruleWhere: [] };

(globalThis as Record<string, unknown>)['__prisma'] = {
  $on: () => undefined,
  mailRule: {
    findFirst: async (args: { where: { id: string; userId: string } }) => {
      calls.ruleWhere.push(args.where);
      if (args.where.userId !== 'owner') return null;
      return {
        id: args.where.id, userId: 'owner', name: 'r', enabled: true, priority: 0,
        conditions: [], exceptions: [], actions: [], stopProcessing: false, matchAll: true,
      };
    },
  },
  message: {
    findMany: async (args: { where: unknown }) => {
      calls.messageWhere.push(args.where);
      return [];
    },
    update: async () => ({}),
  },
};

const { runRuleOnExisting } = await import('./mail-rules.js');

function lastMessageWhere(): Record<string, unknown> {
  return calls.messageWhere.at(-1) as Record<string, unknown>;
}

test('without folderIds the query is scoped to the owner and skips deleted messages', async () => {
  await runRuleOnExisting('rule-1', 'owner', 'owner@example.com');
  assert.deepEqual(lastMessageWhere(), { folder: { mailbox: { userId: 'owner' } }, deletedAt: null });
});

test('folderIds only narrow the selection and keep the owner scope', async () => {
  await runRuleOnExisting('rule-1', 'owner', 'owner@example.com', { folderIds: ['foreign-folder'] });
  assert.deepEqual(lastMessageWhere(), {
    folder: { mailbox: { userId: 'owner' } },
    deletedAt: null,
    folderId: { in: ['foreign-folder'] },
  });
});

test('an empty folderIds list behaves like no filter', async () => {
  await runRuleOnExisting('rule-1', 'owner', 'owner@example.com', { folderIds: [] });
  assert.deepEqual(lastMessageWhere(), { folder: { mailbox: { userId: 'owner' } }, deletedAt: null });
});

test('a rule of another user is not found and no messages are queried', async () => {
  const before = calls.messageWhere.length;
  await assert.rejects(runRuleOnExisting('rule-1', 'intruder', 'x@example.com'), /Rule not found/);
  assert.equal(calls.messageWhere.length, before);
});
