import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDraftAutosave, mergeSavedAttachments, isDraftAttachment, type SavedDraft } from './draft-autosave.ts';

beforeEach(() => { mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 }); });
afterEach(() => { mock.timers.reset(); });

const flushMicrotasks = async () => { for (let i = 0; i < 6; i++) await new Promise<void>((r) => queueMicrotask(r)); };

function harness(opts: { fail?: () => boolean; initialId?: string } = {}) {
  let text = '';
  let n = 0;
  const calls: Array<{ id: string | null; text: string }> = [];
  const statuses: string[] = [];
  const pending: Array<() => void> = [];
  let manual = false;
  const saver = createDraftAutosave({
    idleMs: 3000,
    initialId: opts.initialId ?? null,
    snapshot: () => text,
    save: (id, state) => {
      calls.push({ id, text: state });
      const result = (): SavedDraft => ({ id: `v${++n}`, savedAt: new Date().toISOString() });
      if (opts.fail?.()) return Promise.reject(new Error('offline'));
      if (!manual) return Promise.resolve(result());
      return new Promise((res) => pending.push(() => res(result())));
    },
    onStatus: (s) => statuses.push(s),
  });
  return {
    saver, calls, statuses,
    type(t: string) { text = t; saver.touch(); },
    holdSaves() { manual = true; },
    releaseSave() { pending.shift()?.(); },
  };
}

test('saves once after 3 s idle; typing restarts the timer (debounce)', async () => {
  const h = harness();
  h.type('H');
  mock.timers.tick(2_000);
  h.type('Ha');
  mock.timers.tick(2_000);
  h.type('Hal');
  mock.timers.tick(2_999);
  assert.equal(h.calls.length, 0, 'still typing');
  mock.timers.tick(1);
  await flushMicrotasks();
  assert.deepEqual(h.calls, [{ id: null, text: 'Hal' }], 'first save creates the draft');
  assert.equal(h.saver.draftId, 'v1');
  assert.equal(h.saver.status, 'saved');
  h.type('Hallo');
  mock.timers.tick(3_000);
  await flushMicrotasks();
  assert.deepEqual(h.calls[1], { id: 'v1', text: 'Hallo' }, 'next save replaces the current version');
  assert.equal(h.saver.draftId, 'v2');
  mock.timers.tick(60_000);
  await flushMicrotasks();
  assert.equal(h.calls.length, 2, 'no save without changes');
});

test('saves never overlap; changes during a save are saved afterwards', async () => {
  const h = harness();
  h.holdSaves();
  h.type('a');
  mock.timers.tick(3_000);
  assert.equal(h.calls.length, 1);
  h.type('ab');                       // during the running save
  mock.timers.tick(3_000);
  assert.equal(h.calls.length, 1, 'waits for the running save');
  h.releaseSave();
  await flushMicrotasks();
  assert.equal(h.saver.status, 'dirty');
  mock.timers.tick(3_000);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1], { id: 'v1', text: 'ab' });
  h.releaseSave();
  await flushMicrotasks();
  assert.equal(h.saver.draftId, 'v2');
});

test('flush saves immediately (close / minimise / send) and waits for a running save', async () => {
  const h = harness();
  h.type('x');
  const id = await h.saver.flush();
  assert.equal(id, 'v1');
  assert.equal(h.calls.length, 1);
  assert.equal(await h.saver.flush(), 'v1', 'nothing new → no save');
  assert.equal(h.calls.length, 1);
  mock.timers.tick(10_000);
  await flushMicrotasks();
  assert.equal(h.calls.length, 1, 'timer was cleared by flush');

  const h2 = harness();
  h2.holdSaves();
  h2.type('a');
  mock.timers.tick(3_000);
  h2.type('ab');
  const flushed = h2.saver.flush();
  h2.releaseSave();
  await flushMicrotasks();
  h2.releaseSave();
  assert.equal(await flushed, 'v2');
  assert.deepEqual(h2.calls.map((c) => c.text), ['a', 'ab']);
});

test('a failed save keeps the change, reports the error and is retried by the next flush', async () => {
  let failing = true;
  const h = harness({ fail: () => failing });
  h.type('t');
  mock.timers.tick(3_000);
  await flushMicrotasks();
  assert.equal(h.saver.status, 'error');
  mock.timers.tick(30_000);
  await flushMicrotasks();
  assert.equal(h.calls.length, 1, 'no retry loop');
  await assert.rejects(h.saver.flush());
  failing = false;
  assert.equal(await h.saver.flush(), 'v1');
  assert.equal(h.saver.status, 'saved');
});

test('reopened draft: saves replace the given id; dispose stops autosave; forget starts a new draft', async () => {
  const h = harness({ initialId: 'existing' });
  h.type('edit');
  mock.timers.tick(3_000);
  await flushMicrotasks();
  assert.equal(h.calls[0]!.id, 'existing');
  h.type('more');
  h.saver.dispose();
  mock.timers.tick(10_000);
  await flushMicrotasks();
  assert.equal(h.calls.length, 1);
  h.saver.forget();
  assert.equal(h.saver.draftId, null);
});

test('mergeSavedAttachments maps saved files to stored attachments and keeps later additions', () => {
  const f1 = { name: 'a.pdf', size: 10 };
  const f2 = { name: 'b.txt', size: 3 };
  const f3 = { name: 'late.png', size: 7 };
  const old = { id: 'att-old', filename: 'c.doc', size: 5, mimeType: 'application/msword' };
  const stored = [
    { id: 'n1', filename: 'c.doc', size: 5, mimeType: 'application/msword' },
    { id: 'n2', filename: 'a.pdf', size: 10, mimeType: 'application/pdf' },
    { id: 'n3', filename: 'b.txt', size: 3, mimeType: 'text/plain' },
  ];
  // f2 removed and f3 added while the save ran
  const merged = mergeSavedAttachments([old, f1, f3], [old, f1, f2], stored);
  assert.deepEqual(merged, [stored[0], stored[1], f3]);
  assert.equal(isDraftAttachment(stored[0]), true);
  assert.equal(isDraftAttachment(f1), false);
});
