import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSendQueue, normalizeSendDelay, DEFAULT_SEND_DELAY_SEC } from './send-delay.ts';

beforeEach(() => { mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 }); });
afterEach(() => { mock.timers.reset(); });

const flushMicrotasks = () => new Promise<void>((r) => queueMicrotask(r));

test('send is held for the delay, ticks down, then sent exactly once', async () => {
  const q = createSendQueue();
  const ticks: number[] = [];
  let sends = 0;
  let sent: string | null = null;
  const p = q.schedule({
    delayMs: 10_000,
    send: async () => { sends++; return 'ok'; },
    onTick: (s) => ticks.push(s),
    onSent: (r) => { sent = r; },
  });
  assert.equal(p.state, 'pending');
  assert.equal(q.pendingCount(), 1);
  mock.timers.tick(9_999);
  assert.equal(sends, 0, 'nothing sent during the delay');
  mock.timers.tick(1);
  assert.equal(sends, 1);
  await flushMicrotasks();
  assert.equal(sent, 'ok');
  assert.equal(p.state, 'sent');
  assert.equal(q.pendingCount(), 0);
  assert.deepEqual(ticks, [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  mock.timers.tick(60_000);
  assert.equal(sends, 1);
});

test('cancel within the delay sends nothing; cancel after sending is refused', async () => {
  const q = createSendQueue();
  let sends = 0;
  let cancelled = 0;
  const p = q.schedule({ delayMs: 5_000, send: async () => { sends++; }, onCancelled: () => { cancelled++; } });
  mock.timers.tick(4_000);
  assert.equal(p.cancel(), true);
  assert.equal(p.state, 'cancelled');
  assert.equal(cancelled, 1);
  assert.equal(q.pendingCount(), 0);
  mock.timers.tick(10_000);
  assert.equal(sends, 0);
  assert.equal(p.cancel(), false);

  const p2 = q.schedule({ delayMs: 5_000, send: async () => { sends++; } });
  mock.timers.tick(5_000);
  assert.equal(p2.cancel(), false, 'too late');
  assert.equal(sends, 1);
});

test('delay 0 sends immediately; failures are reported', async () => {
  const q = createSendQueue();
  let sends = 0;
  q.schedule({ delayMs: 0, send: async () => { sends++; } });
  assert.equal(sends, 1);
  let err: unknown = null;
  const p = q.schedule({ delayMs: 1_000, send: async () => { throw new Error('boom'); }, onError: (e) => { err = e; } });
  mock.timers.tick(1_000);
  await flushMicrotasks();
  await flushMicrotasks();
  assert.equal(p.state, 'failed');
  assert.match(String(err), /boom/);
});

test('flushAll sends all pending mails at once (page unload) and notifies subscribers', () => {
  const q = createSendQueue();
  const counts: number[] = [];
  const unsub = q.subscribe((n) => counts.push(n));
  let sends = 0;
  q.schedule({ delayMs: 20_000, send: async () => { sends++; } });
  q.schedule({ delayMs: 30_000, send: async () => { sends++; } });
  assert.equal(q.pendingCount(), 2);
  assert.equal(q.flushAll(), 2);
  assert.equal(sends, 2);
  assert.equal(q.pendingCount(), 0);
  mock.timers.tick(60_000);
  assert.equal(sends, 2, 'timers were cleared');
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
