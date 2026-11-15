import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUndoStack, groupByFolder, planUndo, splitDelete, UNDO_TTL_MS } from './undo-stack.ts';

test('undo stack: newest live entry first, entries expire after 8 s', () => {
  let t = 0;
  const s = createUndoStack({ now: () => t });
  assert.equal(UNDO_TTL_MS, 8000);
  const a = s.push('A', () => 'a');
  t = 1000;
  const b = s.push('B', () => 'b');
  assert.equal(s.size(), 2);
  assert.equal(s.takeLatest()?.id, b.id);
  assert.equal(s.takeLatest()?.id, a.id);
  assert.equal(s.takeLatest(), undefined);

  s.push('C', () => 'c');
  t += UNDO_TTL_MS;
  assert.equal(s.takeLatest(), undefined, 'expired');
  assert.equal(s.size(), 0);
});

test('undo stack: remove (toast button) and bounded size', () => {
  let t = 0;
  const s = createUndoStack({ now: () => t, max: 3 });
  const a = s.push('A', () => undefined);
  const b = s.push('B', () => undefined);
  assert.equal(s.remove(a.id)?.label, 'A');
  assert.equal(s.remove(a.id), undefined, 'only once');
  assert.equal(s.takeLatest()?.id, b.id);
  for (let i = 0; i < 5; i++) s.push(String(i), () => undefined);
  assert.equal(s.size(), 3);
  assert.equal(s.takeLatest()?.label, '4');
  t += 10_000;
  assert.equal(s.remove('undo-1'), undefined);
});

test('groupByFolder keeps per-folder order (bulk selections across folders)', () => {
  const g = groupByFolder([
    { id: '1', folderId: 'inbox' }, { id: '2', folderId: 'work' }, { id: '3', folderId: 'inbox' },
  ]);
  assert.deepEqual([...g.entries()], [['inbox', ['1', '3']], ['work', ['2']]]);
});

test('planUndo: moves back per original folder; junk is reverted with notSpam first', () => {
  const items = [{ id: '1', folderId: 'inbox' }, { id: '2', folderId: 'work' }, { id: '3', folderId: 'inbox' }];
  assert.deepEqual(planUndo('delete', items, 'inbox'), [
    { action: 'move', ids: ['1', '3'], folderId: 'inbox' },
    { action: 'move', ids: ['2'], folderId: 'work' },
  ]);
  assert.deepEqual(planUndo('archive', [{ id: '9', folderId: 'x' }], 'inbox'), [{ action: 'move', ids: ['9'], folderId: 'x' }]);
  assert.deepEqual(planUndo('spam', items, 'inbox'), [
    { action: 'notSpam', ids: ['1', '2', '3'] },
    { action: 'move', ids: ['2'], folderId: 'work' },
  ]);
});

test('splitDelete: mails already in Trash are permanent (confirm, no undo)', () => {
  const items = [{ id: '1', folderId: 'inbox' }, { id: '2', folderId: 'trash' }];
  assert.deepEqual(splitDelete(items, 'trash'), { toTrash: [items[0]], permanent: [items[1]] });
  assert.deepEqual(splitDelete(items, null), { toTrash: [], permanent: items });
});
