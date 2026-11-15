import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openReconnectingEventSource, reconnectDelay, eventStreamUrl, type EventSourceLike } from './reconnectingEventSource.ts';

class FakeES implements EventSourceLike {
  static all: FakeES[] = [];
  listeners = new Map<string, (ev: { data?: unknown }) => void>();
  onerror: ((ev: unknown) => void) | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  closed = false;
  url: string;
  constructor(url: string) { this.url = url; FakeES.all.push(this); }
  addEventListener(type: string, l: (ev: { data?: unknown }) => void) { this.listeners.set(type, l); }
  close() { this.closed = true; }
}

function harness(tokens: (string | null)[]) {
  FakeES.all = [];
  const timers: { fn: () => void; ms: number }[] = [];
  let i = 0;
  const events: string[] = [];
  const stop = openReconnectingEventSource({
    url: () => {
      const t = tokens[Math.min(i++, tokens.length - 1)];
      return t ? `/api/v1/events?token=${t}` : null;
    },
    handlers: { 'security:attack': (ev) => events.push(String(ev.data)) },
    createEventSource: (url) => new FakeES(url),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => undefined,
  });
  return { timers, events, stop };
}

test('reconnects with the CURRENT token after an error', () => {
  const h = harness(['tok1', 'tok2', 'tok3']);
  assert.equal(FakeES.all.length, 1);
  assert.equal(FakeES.all[0]!.url, '/api/v1/events?token=tok1');

  FakeES.all[0]!.onerror!({});
  assert.ok(FakeES.all[0]!.closed, 'old connection closed (no browser auto-retry with the stale URL)');
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0]!.ms, 1000);
  h.timers[0]!.fn();
  assert.equal(FakeES.all[1]!.url, '/api/v1/events?token=tok2');

  FakeES.all[1]!.listeners.get('security:attack')!({ data: 'x' });
  assert.deepEqual(h.events, ['x']);

  // backoff grows, reset after a successful open
  FakeES.all[1]!.onerror!({});
  assert.equal(h.timers[1]!.ms, 2000);
  h.timers[1]!.fn();
  FakeES.all[2]!.onopen!({});
  FakeES.all[2]!.onerror!({});
  assert.equal(h.timers[2]!.ms, 1000);
  h.stop();
});

test('without a token it retries later instead of connecting', () => {
  const h = harness([null, 'tok']);
  assert.equal(FakeES.all.length, 0);
  assert.equal(h.timers.length, 1);
  h.timers[0]!.fn();
  assert.equal(FakeES.all[0]!.url, '/api/v1/events?token=tok');
  h.stop();
});

test('stop closes the stream and prevents reconnects', () => {
  const h = harness(['tok']);
  const es = FakeES.all[0]!;
  h.stop();
  assert.ok(es.closed);
  es.onerror!({});
  assert.equal(h.timers.length, 0);
});

test('v8.1: a fresh single-use ticket is requested for every (re)connect', async () => {
  FakeES.all = [];
  const timers: { fn: () => void; ms: number }[] = [];
  let n = 0;
  const outcomes: Array<string | Error> = ['t1', new Error('ticket 401 after refresh'), 't2'];
  const stop = openReconnectingEventSource({
    url: async () => {
      const o = outcomes[n++]!;
      if (o instanceof Error) throw o;
      return eventStreamUrl(o);
    },
    handlers: {},
    createEventSource: (url) => new FakeES(url),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => undefined,
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(FakeES.all[0]!.url, '/api/v1/events?ticket=t1');
  FakeES.all[0]!.onerror!({});
  timers[0]!.fn();                       // ticket request fails → backoff, no EventSource
  await new Promise((r) => setImmediate(r));
  assert.equal(FakeES.all.length, 1);
  assert.equal(timers.length, 2);
  assert.equal(timers[1]!.ms, 2000);
  timers[1]!.fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(FakeES.all[1]!.url, '/api/v1/events?ticket=t2', 'never reuses the redeemed ticket');
  stop();
});

test('stop while a ticket request is pending opens no stream', async () => {
  FakeES.all = [];
  let resolve!: (v: string) => void;
  const stop = openReconnectingEventSource({
    url: () => new Promise<string>((r) => { resolve = r; }),
    handlers: {},
    createEventSource: (url) => new FakeES(url),
    setTimer: () => 0,
    clearTimer: () => undefined,
  });
  stop();
  resolve('/api/v1/events?ticket=late');
  await new Promise((r) => setImmediate(r));
  assert.equal(FakeES.all.length, 0);
});

test('reconnectDelay caps at the maximum', () => {
  assert.equal(reconnectDelay(0), 1000);
  assert.equal(reconnectDelay(3), 8000);
  assert.equal(reconnectDelay(10), 30_000);
  assert.equal(reconnectDelay(1000), 30_000);
});
