import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveDraftWith, draftConflictFromBody, isDraftLocked, DraftSupersededError, DraftLockedError } from './draft-conflict.ts';

type P = { keepAttachmentIds: string[]; text: string };
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

function server(answers: Array<(id: string, p: P) => unknown>) {
  const calls: Array<{ op: 'post' | 'put'; id?: string; p: P }> = [];
  let i = 0;
  const next = (id: string, p: P) => {
    const r = answers[i++]!(id, p);
    if (r instanceof Error) throw r;
    return r as { id: string };
  };
  return {
    calls,
    ops: {
      post: async (p: P) => { calls.push({ op: 'post', p }); return next('', p); },
      put: async (id: string, p: P) => { calls.push({ op: 'put', id, p }); return next(id, p); },
    },
  };
}

test('409 DRAFT_SUPERSEDED: retried once on the current version with mapped attachments — never a new draft', async () => {
  const s = server([
    () => new DraftSupersededError('replaced', 'v3', { a1: 'a9' }),
    (id) => ({ id: `${id}-next` }),
  ]);
  const r = await saveDraftWith('v1', { keepAttachmentIds: ['a1', 'gone'], text: 'x' }, s.ops);
  assert.deepEqual(r, { id: 'v3-next' });
  assert.deepEqual(s.calls.map((c) => [c.op, c.id]), [['put', 'v1'], ['put', 'v3']]);
  assert.deepEqual(s.calls[1]!.p.keepAttachmentIds, ['a9']);
});

test('409 DRAFT_SENDING / DRAFT_SENT: no POST, the error reaches autosave (fatal)', async () => {
  for (const code of ['DRAFT_SENDING', 'DRAFT_SENT'] as const) {
    const s = server([() => new DraftLockedError('locked', code)]);
    await assert.rejects(saveDraftWith('v1', { keepAttachmentIds: [], text: 'x' }, s.ops), (err) => isDraftLocked(err));
    assert.deepEqual(s.calls.map((c) => c.op), ['put']);
  }
});

test('only a genuine 404 recreates the draft (without kept attachments); other errors propagate', async () => {
  const gone = server([() => httpError(404), () => ({ id: 'new' })]);
  assert.deepEqual(await saveDraftWith('v1', { keepAttachmentIds: ['a1'], text: 'x' }, gone.ops), { id: 'new' });
  assert.deepEqual(gone.calls.map((c) => c.op), ['put', 'post']);
  assert.deepEqual(gone.calls[1]!.p.keepAttachmentIds, []);
  const offline = server([() => httpError(503)]);
  await assert.rejects(saveDraftWith('v1', { keepAttachmentIds: [], text: 'x' }, offline.ops));
  assert.deepEqual(offline.calls.map((c) => c.op), ['put']);
});

test('response bodies map to the conflict errors', () => {
  const s = draftConflictFromBody({ code: 'DRAFT_SUPERSEDED', currentId: 'v2', attachmentIds: { a: 'b' } }, 409, 'm');
  assert.ok(s instanceof DraftSupersededError && s.currentId === 'v2' && s.attachmentIds['a'] === 'b');
  assert.ok(isDraftLocked(draftConflictFromBody({ code: 'DRAFT_SENT' }, 409, 'm')));
  assert.equal(draftConflictFromBody({ code: 'DRAFT_GONE' }, 404, 'm'), null);
  assert.equal(draftConflictFromBody({ error: 'Entwurf wird bereits gesendet' }, 409, 'm'), null);
});
