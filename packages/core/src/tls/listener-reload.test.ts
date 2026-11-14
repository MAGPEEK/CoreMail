/**
 * Listener cert rotation: running implicit-TLS listeners get the new cert via
 * setSecureContext (no restart); plain fallbacks are reported for a restart.
 * Run: node --import tsx --test src/tls/listener-reload.test.ts  (in packages/core)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { applyTlsToListeners, tlsMaterialEquals, type TlsMaterial } from './listener-reload.js';

const material = (n: string): TlsMaterial => ({ cert: Buffer.from(`cert-${n}`), key: Buffer.from(`key-${n}`) });

function fakeTlsServer() {
  const calls: Array<{ cert: Buffer; key: Buffer; minVersion?: string }> = [];
  return { calls, setSecureContext: (o: { cert: Buffer; key: Buffer; minVersion?: string }) => { calls.push(o); } };
}

test('reload calls setSecureContext on every running implicit-TLS listener', () => {
  const s465 = fakeTlsServer();
  const s993 = fakeTlsServer();
  const plain = fakeTlsServer(); // STARTTLS/plain port — must not be touched
  const m = material('new');
  const res = applyTlsToListeners([
    { port: 465, ssl: true, server: s465 },
    { port: 993, ssl: true, server: s993 },
    { port: 587, ssl: false, server: plain },
  ], m);

  assert.deepEqual(res.updated, [465, 993]);
  assert.deepEqual(res.restart, []);
  assert.equal(s465.calls.length, 1);
  assert.equal(s465.calls[0]!.cert, m.cert);
  assert.equal(s465.calls[0]!.key, m.key);
  assert.equal(s465.calls[0]!.minVersion, 'TLSv1.2');
  assert.equal(plain.calls.length, 0);
});

test('ssl listener running as plain net.Server is reported for restart', () => {
  const server = net.createServer();
  const res = applyTlsToListeners([{ port: 995, ssl: true, server }], material('x'));
  assert.deepEqual(res.restart, [995]);
  assert.deepEqual(res.updated, []);
});

test('a throwing setSecureContext is isolated per listener', () => {
  const bad = { setSecureContext: () => { throw new Error('key mismatch'); } };
  const good = fakeTlsServer();
  const res = applyTlsToListeners([
    { port: 465, ssl: true, server: bad },
    { port: 993, ssl: true, server: good },
  ], material('y'));
  assert.equal(res.failed.length, 1);
  assert.equal(res.failed[0]!.port, 465);
  assert.deepEqual(res.updated, [993]);
});

test('tlsMaterialEquals compares cert and key bytes', () => {
  assert.equal(tlsMaterialEquals(material('a'), material('a')), true);
  assert.equal(tlsMaterialEquals(material('a'), material('b')), false);
  assert.equal(tlsMaterialEquals(null, material('a')), false);
  assert.equal(tlsMaterialEquals(null, null), true);
});
