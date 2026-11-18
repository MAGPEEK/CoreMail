import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTabLeader, type ChannelLike, type AppMessage, type TabLeader } from './tabLeader.ts';

/** Fake clock: timers run when `advance` passes their due time. */
function clock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimer: (fn: () => void, ms: number) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (h: unknown) => { timers.delete(h as number); },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

/**
 * In-memory BroadcastChannel. Like the real one it delivers asynchronously:
 * with a clock, after `latencyMs`; without, synchronously.
 */
function bus(c?: ReturnType<typeof clock>, latencyMs = 1) {
  const members = new Set<ChannelLike>();
  return {
    open(): ChannelLike {
      const ch: ChannelLike = {
        onmessage: null,
        postMessage(m) {
          for (const o of members) {
            if (o === ch) continue;
            const deliver = () => o.onmessage?.({ data: structuredClone(m) });
            if (c) c.setTimer(deliver, latencyMs); else deliver();
          }
        },
        close() { members.delete(ch); },
      };
      members.add(ch);
      return ch;
    },
  };
}

function tab(id: string, b: ReturnType<typeof bus>, c: ReturnType<typeof clock>) {
  const changes: boolean[] = [];
  const got: AppMessage[] = [];
  const leader: TabLeader = startTabLeader({
    id, channel: b.open(), onLeaderChange: (l) => changes.push(l), onMessage: (m) => got.push(m),
    setTimer: c.setTimer, clearTimer: c.clearTimer,
  });
  return { leader, changes, got };
}

test('a single tab becomes leader after the election window', () => {
  const c = clock(); const b = bus(c);
  const a = tab('a', b, c);
  assert.equal(a.leader.isLeader(), false);
  c.advance(400);
  assert.equal(a.leader.isLeader(), true);
  assert.deepEqual(a.changes, [true]);
});

test('a second tab follows the running leader; app messages reach the other tabs only', () => {
  const c = clock(); const b = bus(c);
  const a = tab('b-first', b, c);
  c.advance(400);
  const n = tab('a-second', b, c); // lower id, but a leader exists already
  c.advance(10_000);
  assert.equal(a.leader.isLeader(), true);
  assert.equal(n.leader.isLeader(), false);
  a.leader.broadcast({ t: 'event', name: 'contacts', data: {} });
  c.advance(1);
  assert.deepEqual(n.got, [{ t: 'event', name: 'contacts', data: {} }]);
  assert.deepEqual(a.got, []);
});

test('simultaneous starts: exactly one leader (the lower id)', () => {
  const c = clock(); const b = bus(c);
  const x = tab('x', b, c); const y = tab('y', b, c); const z = tab('w', b, c);
  c.advance(5_000);
  const leaders = [x, y, z].filter((t) => t.leader.isLeader());
  assert.equal(leaders.length, 1);
  assert.equal(leaders[0], z);
});

test('a resigning leader is replaced at once', () => {
  const c = clock(); const b = bus(c);
  const a = tab('a', b, c);
  c.advance(400);
  const f1 = tab('f1', b, c); const f2 = tab('f2', b, c);
  c.advance(1_000);
  a.leader.stop();
  c.advance(450);
  assert.deepEqual([f1, f2].map((t) => t.leader.isLeader()), [true, false]);
  assert.deepEqual(a.changes, [true, false]);
});

test('a crashed leader (no heartbeat, no resign) is replaced after the timeout', () => {
  const c = clock(); const b = bus(c);
  const crashedChannel = b.open();
  const frozen = { on: true };
  startTabLeader({
    id: 'a', channel: crashedChannel, onLeaderChange: () => undefined,
    setTimer: (fn, ms) => c.setTimer(() => { if (frozen.on) fn(); }, ms), clearTimer: c.clearTimer,
  });
  c.advance(400);
  const f = tab('b', b, c);
  c.advance(1_000);
  assert.equal(f.leader.isLeader(), false);
  crashedChannel.close(); // the tab died: no heartbeat, no resign
  frozen.on = false;
  c.advance(6_000);
  assert.equal(f.leader.isLeader(), true);
});

test('without BroadcastChannel every tab leads alone', () => {
  const changes: boolean[] = [];
  const l = startTabLeader({ id: 'solo', channel: null, onLeaderChange: (v) => changes.push(v) });
  assert.equal(l.isLeader(), true);
  l.broadcast({ t: 'logout' }); // no-op, no throw
  l.stop();
  assert.deepEqual(changes, [true, false]);
});
