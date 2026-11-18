import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTabRole, type TabMessage } from './tabRole.ts';

test('the role follows the election and tells its listeners once per change', () => {
  const role = createTabRole();
  const changes: boolean[] = [];
  role.onLeaderChange((l) => changes.push(l));
  assert.equal(role.isLeader(), false, 'no election → no leader');
  role.leaderChanged(true); // may come before attach (no BroadcastChannel: leader at once)
  const sent: TabMessage[] = [];
  role.attach({ broadcast: (m) => sent.push(m) });
  role.leaderChanged(true);
  assert.equal(role.isLeader(), true);
  role.broadcast({ t: 'reminder' });
  role.attach(null);
  assert.equal(role.isLeader(), false, 'a detached election leaves no leader behind');
  role.broadcast({ t: 'lost' });
  assert.deepEqual(changes, [true, false]);
  assert.deepEqual(sent, [{ t: 'reminder' }]);
});

test('messages from other tabs reach every listener; a failing one does not stop the others', () => {
  const role = createTabRole();
  const got: string[] = [];
  const original = console.error;
  console.error = () => undefined;
  try {
    role.onMessage(() => { throw new Error('boom'); });
    const off = role.onMessage((m) => got.push(m.t));
    role.received({ t: 'a' });
    off();
    role.received({ t: 'b' });
  } finally {
    console.error = original;
  }
  assert.deepEqual(got, ['a']);
});
