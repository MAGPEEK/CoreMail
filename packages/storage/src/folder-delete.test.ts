/**
 * "Is this folder inside Trash?" — one rule for parentId links (webmail) and
 * name hierarchy (IMAP CREATE `Trash.Old` sets no parentId). Deleting a folder
 * inside Trash expunges its live mail first (recoverable) instead of moving it
 * back to live Trash.
 * Run: node --import tsx --test src/folder-delete.test.ts  (in packages/storage)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBelowByName, isInsideTrash } from './folder-delete.js';

type Folder = { id: string; mailboxId: string; name: string; parentId: string | null };
const folders: Folder[] = [
  { id: 'trash', mailboxId: 'mb', name: 'Trash', parentId: null },
  { id: 'old', mailboxId: 'mb', name: 'Trash.Old', parentId: null },
  { id: 'old-child', mailboxId: 'mb', name: 'Sub', parentId: 'old' },
  { id: 'linked', mailboxId: 'mb', name: 'Linked', parentId: 'trash' },
  { id: 'linked-deep', mailboxId: 'mb', name: 'Deep', parentId: 'linked' },
  { id: 'work', mailboxId: 'mb', name: 'Work', parentId: null },
  { id: 'work-child', mailboxId: 'mb', name: 'Work.Trash.Old', parentId: 'work' },
  { id: 'lookalike', mailboxId: 'mb', name: 'TrashCan', parentId: null },
  { id: 'loop-a', mailboxId: 'mb', name: 'A', parentId: 'loop-b' },
  { id: 'loop-b', mailboxId: 'mb', name: 'B', parentId: 'loop-a' },
];
const tx = {
  folder: {
    findFirst: async (a: { where: { id: string; mailboxId: string } }) =>
      folders.find((f) => f.id === a.where.id && f.mailboxId === a.where.mailboxId) ?? null,
  },
} as unknown as Parameters<typeof isInsideTrash>[0];
const trash = { id: 'trash', name: 'Trash' };
const inside = (id: string) => isInsideTrash(tx, 'mb', folders.find((f) => f.id === id)!, trash);

test('isBelowByName: only real inferiors of the name', () => {
  assert.equal(isBelowByName('Trash.Old', 'Trash'), true);
  assert.equal(isBelowByName('Trash.Old.2025', 'Trash'), true);
  assert.equal(isBelowByName('Trash', 'Trash'), false, 'Trash itself is not below Trash');
  assert.equal(isBelowByName('TrashCan', 'Trash'), false);
  assert.equal(isBelowByName('Work.Trash.Old', 'Trash'), false);
});

test('isInsideTrash: name-based and parent-based nesting are treated alike', async () => {
  assert.equal(await inside('old'), true, 'Trash.Old without parentId');
  assert.equal(await inside('old-child'), true, 'parentId → Trash.Old');
  assert.equal(await inside('linked'), true, 'parentId → Trash');
  assert.equal(await inside('linked-deep'), true, 'parentId chain → Trash');
  assert.equal(await inside('work'), false);
  assert.equal(await inside('work-child'), false);
  assert.equal(await inside('lookalike'), false);
  assert.equal(await inside('loop-a'), false, 'a parentId cycle terminates');
});
