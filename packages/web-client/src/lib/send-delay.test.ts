import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSendQueue, normalizeSendDelay, DEFAULT_SEND_DELAY_SEC } from './send-delay.ts';

beforeEach(() => { mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 }); });
afterEach(() => { mock.timers.reset(); });

const flushMicrotasks = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((r) => queueMicrotask(r)); };

/** A start() the test resolves by hand (draft save + server hold request). */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('held on the server for the delay, ticks down, then reported as sent once', async () => {
  const q = createSendQueue();
  const ticks: number[] = [];
  let starts = 0;
  let sent: string | null = null;
  const p = q.schedule({
    delayMs: 10_000,
    start: async () => { starts++; return 'draft-1'; },
    undo: async () => true,
    onTick: (s) => ticks.push(s),
    onSent: (r) => { sent = r; },
  });
  assert.equal(starts, 1, 'the draft is handed to the server right away');
  await flushMicrotasks();
  assert.equal(p.state, 'held');
  assert.equal(q.pendingCount(), 1);
  mock.timers.tick(9_999);
  assert.equal(sent, null);
  mock.timers.tick(1);
  assert.equal(sent, 'draft-1');
  assert.equal(p.state, 'sent');
  assert.equal(q.pendingCount(), 0);
  assert.deepEqual(ticks, [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  assert.equal(p.cancel(), false, 'too late after the delay');
});

test('undo while held withdraws the server send and reopens', async () => {
  const q = createSendQueue();
  const undone: string[] = [];
  let undoCalls = 0;
  const p = q.schedule({
    delayMs: 5_000,
    start: async () => 'd1',
    undo: async (id) => { undoCalls++; return id === 'd1'; },
    onUndone: (id) => undone.push(id),
    onSent: () => assert.fail('must not be reported as sent'),
  });
  await flushMicrotasks();
  mock.timers.tick(4_000);
  assert.equal(p.cancel(), true);
  assert.equal(p.state, 'undoing');
  await flushMicrotasks();
  assert.equal(p.state, 'undone');
  assert.deepEqual(undone, ['d1']);
  assert.equal(undoCalls, 1);
  assert.equal(q.pendingCount(), 0);
  mock.timers.tick(10_000);
  assert.equal(p.cancel(), false);
});

test('undo requested while the draft is still being saved runs once the server accepted it', async () => {
  const q = createSendQueue();
  const d = deferred<string>();
  let undone = 0;
  const p = q.schedule({ delayMs: 10_000, start: () => d.promise, undo: async () => true, onUndone: () => { undone++; } });
  assert.equal(p.state, 'starting');
  assert.equal(p.cancel(), true);
  d.resolve('d2');
  await flushMicrotasks();
  assert.equal(p.state, 'undone');
  assert.equal(undone, 1);
});

test('server already sending: undo reports too late', async () => {
  const q = createSendQueue();
  let tooLate = 0;
  const p = q.schedule({ delayMs: 5_000, start: async () => 'd3', undo: async () => false, onTooLate: () => { tooLate++; } });
  await flushMicrotasks();
  p.cancel();
  await flushMicrotasks();
  assert.equal(p.state, 'sent');
  assert.equal(tooLate, 1);
  const p2 = q.schedule({ delayMs: 5_000, start: async () => 'd4', undo: async () => { throw new Error('409'); }, onTooLate: () => { tooLate++; } });
  await flushMicrotasks();
  p2.cancel();
  await flushMicrotasks();
  assert.equal(tooLate, 2);
});

test('slow save: the countdown ends first, the send completes when the server accepted it', async () => {
  const q = createSendQueue();
  const d = deferred<string>();
  let sent = 0;
  const p = q.schedule({ delayMs: 2_000, start: () => d.promise, undo: async () => true, onSent: () => { sent++; } });
  mock.timers.tick(2_000);
  assert.equal(p.cancel(), false, 'delay over');
  assert.equal(sent, 0);
  d.resolve('d5');
  await flushMicrotasks();
  assert.equal(sent, 1);
  assert.equal(p.state, 'sent');
});

test('delay 0 sends as soon as the server accepted; a failed start is reported', async () => {
  const q = createSendQueue();
  let sent = 0;
  const p0 = q.schedule({ delayMs: 0, start: async () => 'x', undo: async () => true, onSent: () => { sent++; } });
  assert.equal(p0.cancel(), false);
  await flushMicrotasks();
  assert.equal(sent, 1);
  let err: unknown = null;
  const p = q.schedule({ delayMs: 1_000, start: async () => { throw new Error('boom'); }, undo: async () => true, onError: (e) => { err = e; } });
  await flushMicrotasks();
  assert.equal(p.state, 'failed');
  assert.match(String(err), /boom/);
  assert.equal(q.pendingCount(), 0);
});

test('pendingCount / subscribers follow starting + held sends', async () => {
  const q = createSendQueue();
  const counts: number[] = [];
  const unsub = q.subscribe((n) => counts.push(n));
  q.schedule({ delayMs: 20_000, start: async () => 'a', undo: async () => true });
  q.schedule({ delayMs: 30_000, start: async () => 'b', undo: async () => true });
  await flushMicrotasks();
  assert.equal(q.pendingCount(), 2);
  mock.timers.tick(20_000);
  assert.equal(q.pendingCount(), 1);
  mock.timers.tick(10_000);
  assert.equal(q.pendingCount(), 0);
  assert.deepEqual(counts, [1, 2, 1, 0]);
  unsub();
});

test('normalizeSendDelay accepts only the offered options', () => {
  assert.equal(DEFAULT_SEND_DELAY_SEC, 10);
  for (const v of [0, 5, 10, 20, 30]) assert.equal(normalizeSendDelay(v), v);
  assert.equal(normalizeSendDelay(7), 10);
  assert.equal(normalizeSendDelay('x'), 10);
  assert.equal(normalizeSendDelay(undefined), 10);
});
