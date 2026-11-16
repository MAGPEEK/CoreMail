/**
 * Listener bind address + bind-error recovery (9.2 review: a host name or an
 * IP missing in the container crashed SMTP/IMAP/POP3 with EADDRNOTAVAIL, and
 * the close-and-relisten path could crash with EADDRINUSE).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { resolveBindAddress, listenWithRecovery, DEFAULT_BIND_ADDRESS, type ListenLogger } from './listen.js';

function recordingLog(): ListenLogger & { lines: Array<{ level: string; msg: string; obj: object }> } {
  const lines: Array<{ level: string; msg: string; obj: object }> = [];
  return {
    lines,
    info: (obj, msg) => { lines.push({ level: 'info', msg, obj }); },
    warn: (obj, msg) => { lines.push({ level: 'warn', msg, obj }); },
    error: (obj, msg) => { lines.push({ level: 'error', msg, obj }); },
  };
}

function closeServer(s: net.Server): Promise<void> {
  return new Promise((resolve) => { if (s.listening) s.close(() => resolve()); else resolve(); });
}

test('resolveBindAddress keeps IP literals and replaces anything else by 0.0.0.0', () => {
  assert.equal(resolveBindAddress('127.0.0.1'), '127.0.0.1');
  assert.equal(resolveBindAddress(' 10.0.0.5 '), '10.0.0.5');
  assert.equal(resolveBindAddress('::1'), '::1');
  assert.equal(resolveBindAddress('[::]'), '::');
  assert.equal(resolveBindAddress(''), DEFAULT_BIND_ADDRESS);
  assert.equal(resolveBindAddress(null), DEFAULT_BIND_ADDRESS);
  assert.equal(resolveBindAddress(undefined), DEFAULT_BIND_ADDRESS);
  const invalid: string[] = [];
  assert.equal(resolveBindAddress('mail.example.com', (a) => invalid.push(a)), DEFAULT_BIND_ADDRESS);
  assert.equal(resolveBindAddress('999.1.1.1', (a) => invalid.push(a)), DEFAULT_BIND_ADDRESS);
  assert.equal(resolveBindAddress('   ', (a) => invalid.push(a)), DEFAULT_BIND_ADDRESS);
  assert.deepEqual(invalid, ['mail.example.com', '999.1.1.1'], 'empty is the default, not a warning');
});

test('a host name as listener address is logged and the fallback address is bound', async (t) => {
  const server = net.createServer();
  t.after(() => closeServer(server));
  const log = recordingLog();
  const bound = await new Promise<string>((resolve) => {
    listenWithRecovery(server, {
      port: 0, address: 'mail.example.com', label: 'TEST', log, fallbackAddress: '127.0.0.1',
      onListening: resolve,
    });
  });
  assert.equal(bound, '127.0.0.1');
  assert.ok(log.lines.some((l) => l.level === 'warn' && /not an IP address/.test(l.msg)));
});

test('EADDRNOTAVAIL (IP not present on this host) falls back instead of crashing', async (t) => {
  const server = net.createServer();
  t.after(() => closeServer(server));
  const log = recordingLog();
  // 192.0.2.1 (TEST-NET-1, RFC 5737) is never assigned to a local interface.
  const bound = await new Promise<string>((resolve, reject) => {
    listenWithRecovery(server, {
      port: 0, address: '192.0.2.1', label: 'TEST', log, fallbackAddress: '127.0.0.1',
      onListening: resolve, onGiveUp: reject,
    });
  });
  assert.equal(bound, '127.0.0.1');
  assert.ok(server.listening);
  assert.ok(log.lines.some((l) => l.level === 'error' && /falling back/.test(l.msg)));
});

test('EADDRINUSE is retried with backoff and binds once the port is free', async (t) => {
  const blocker = net.createServer();
  await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
  const port = (blocker.address() as net.AddressInfo).port;
  const server = net.createServer();
  t.after(() => closeServer(server));
  const log = recordingLog();
  const listening = new Promise<string>((resolve, reject) => {
    listenWithRecovery(server, {
      port, address: '127.0.0.1', label: 'TEST', log, retries: 5, retryDelayMs: 20,
      onListening: resolve, onGiveUp: reject,
    });
  });
  // Release the port after the first failed attempt (old listener still closing).
  await new Promise((r) => setTimeout(r, 30));
  await closeServer(blocker);
  assert.equal(await listening, '127.0.0.1');
  assert.equal((server.address() as net.AddressInfo).port, port);
  assert.ok(log.lines.some((l) => l.level === 'warn' && /port in use/.test(l.msg)));
});

test('EADDRINUSE that never clears gives up with an error log, no exception', async (t) => {
  const blocker = net.createServer();
  await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
  t.after(() => closeServer(blocker));
  const port = (blocker.address() as net.AddressInfo).port;
  const server = net.createServer();
  const log = recordingLog();
  const err = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
    listenWithRecovery(server, {
      port, address: '127.0.0.1', label: 'TEST', log, retries: 2, retryDelayMs: 5,
      onListening: () => reject(new Error('must not listen')), onGiveUp: resolve,
    });
  });
  assert.equal(err.code, 'EADDRINUSE');
  assert.equal(server.listening, false);
  assert.equal(log.lines.filter((l) => /port in use/.test(l.msg)).length, 2, 'two retries');
  assert.ok(log.lines.some((l) => l.level === 'error' && /could not be started/.test(l.msg)));
});

test('a replaced listener stops retrying', async (t) => {
  const blocker = net.createServer();
  await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
  t.after(() => closeServer(blocker));
  const port = (blocker.address() as net.AddressInfo).port;
  const server = net.createServer();
  let current = true;
  let gaveUp = false;
  listenWithRecovery(server, {
    port, address: '127.0.0.1', label: 'TEST', log: recordingLog(), retries: 5, retryDelayMs: 10,
    isCurrent: () => current, onGiveUp: () => { gaveUp = true; },
  });
  current = false;
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(server.listening, false);
  assert.equal(gaveUp, false);
});
