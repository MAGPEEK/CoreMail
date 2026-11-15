/**
 * Trace fields (RFC 5321 §4.4, §6.3, §7.2), Resent-* placement (RFC 5322
 * §3.6.6), rule-forward envelope (RFC 5321 §3.9.1), MSA header completion
 * (RFC 6409 §8), delivery idempotency (§6.1) and auto-reply addressing.
 * Run: node --import tsx --test src/handlers/trace.test.ts  (in packages/smtp-server)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
process.env['LOG_LEVEL'] = 'error';
(globalThis as unknown as { __prisma: unknown }).__prisma = { $on: () => undefined };

const { buildReceivedHeader, withReturnPath, countReceived, formatRfc5322Date, ipLiteral } = await import('./trace.js');
const { buildRuleForward } = await import('./rule-forward.js');
const { deliverOnce } = await import('./delivery.js');
const { completeSubmissionHeaders } = await import('../submission/handler.js');

const META = { helo: 'client.ext.test', protocol: 'ESMTPS' as const, hostname: 'mx.corp.test', sessionId: 'ABCD1234' };
const DATE = new Date('2026-11-15T10:00:00Z');

test('Received: names HELO, IP, host, protocol, id and an RFC 5322 date with a numeric zone', () => {
  const h = buildReceivedHeader({ ip: '::ffff:192.0.2.7', meta: META, recipients: ['bob@corp.test'], date: DATE });

  assert.equal(h, 'Received: from client.ext.test ([192.0.2.7])\r\n\tby mx.corp.test (CoreMail) with ESMTPS id ABCD1234\r\n\tfor <bob@corp.test>; Sun, 15 Nov 2026 10:00:00 +0000\r\n');
  assert.equal(ipLiteral('2001:db8::1'), '[IPv6:2001:db8::1]');
  assert.equal(formatRfc5322Date(DATE), 'Sun, 15 Nov 2026 10:00:00 +0000');
});

test('Received: has no "for" clause with several recipients (no Bcc exposure) and quotes a bogus HELO safely', () => {
  const h = buildReceivedHeader({ ip: '192.0.2.7', meta: { ...META, helo: 'bad (helo)\r\nX-Evil: 1' }, recipients: ['bcc@corp.test', 'to@ext.test'], date: DATE });

  assert.doesNotMatch(h, /\bfor </);
  assert.match(h, /^Received: from \[192\.0\.2\.7\] \(helo=bad helo X-Evil: 1\)\r\n/);
  assert.equal(h.split('\r\n').length, 3, 'two folded lines, no injected header line');
  assert.match(h, /^\tby mx\.corp\.test .*; Sun, 15 Nov 2026 10:00:00 \+0000$/m);
});

test('Return-Path: replaces earlier Return-Path fields and is the first line of the stored message', () => {
  const raw = Buffer.from('Return-Path: <forged@x.test>\r\nSubject: s\r\nReturn-Path:\r\n <other@x.test>\r\n\r\nbody\r\n');

  assert.equal(withReturnPath(raw, 'alice@ext.test').toString(), 'Return-Path: <alice@ext.test>\r\nSubject: s\r\n\r\nbody\r\n');
  assert.equal(withReturnPath(Buffer.from('Subject: s\r\n\r\nb'), '').toString(), 'Return-Path: <>\r\nSubject: s\r\n\r\nb');
});

test('hop counting counts the Received: fields of the header block only', () => {
  const raw = Buffer.from(`${'Received: from x by y; d\r\n'.repeat(3)}Subject: s\r\n\r\nReceived: in body\r\n`);

  assert.equal(countReceived(raw), 3);
});

test('rule redirect keeps the original envelope sender (also the null sender); forward prepends Resent-*', () => {
  const opts = { rawBuffer: Buffer.from('From: list@ext.test\r\nSubject: s\r\n\r\nb'), toAddress: 'me@else.test', forwardingUser: { id: 'u1', email: 'bob@corp.test' } };

  assert.equal(buildRuleForward({ ...opts, mode: 'redirect', originalFrom: 'bounces@lists.ext.test' }).envelopeFrom, 'bounces@lists.ext.test');
  assert.equal(buildRuleForward({ ...opts, mode: 'redirect', originalFrom: '' }).envelopeFrom, '');
  const fwd = buildRuleForward({ ...opts, mode: 'forward', originalFrom: 'x@ext.test' }, DATE);
  assert.equal(fwd.envelopeFrom, 'bob@corp.test');
  assert.match(fwd.raw.toString(), /^Resent-From: <bob@corp\.test>\r\nResent-To: <me@else\.test>\r\nResent-Date: Sun, 15 Nov 2026 10:00:00 \+0000\r\nResent-Message-ID: <[^>]+>\r\nX-CoreMail-RuleForwarded: u1\r\nFrom: list@ext\.test\r\n/);
});

test('the MSA adds a missing Date: and Message-ID:, existing ones are kept', () => {
  const added = completeSubmissionHeaders(Buffer.from('From: a@corp.test\r\n\r\nb'), 'mail.corp.test', DATE).toString();
  const kept = Buffer.from('Date: x\r\nMessage-ID: <1@a>\r\n\r\nb');

  assert.match(added, /^Date: Sun, 15 Nov 2026 10:00:00 \+0000\r\nMessage-ID: <[0-9a-f-]+@mail\.corp\.test>\r\nFrom:/);
  assert.equal(completeSubmissionHeaders(kept, 'mail.corp.test'), kept);
});

test('a failed delivery step is remembered: the retry skips stored recipients and the queued external part', async () => {
  const ledger = new Map<string, Set<string>>();
  const stored: string[] = [];
  const enqueued: string[][] = [];
  let failStore = true;
  let failEnqueue = true;
  const deps = {
    ledger: {
      delivered: async (k: string) => new Set(ledger.get(k) ?? []),
      remember: async (k: string, r: string[]) => { ledger.set(k, new Set(r)); },
    },
    storeLocal: async (rcpt: string) => {
      if (rcpt === 'b@corp.test' && failStore) { failStore = false; throw new Error('db down'); }
      stored.push(rcpt);
    },
    enqueueExternal: async (rcpts: string[]) => {
      if (failEnqueue) { failEnqueue = false; throw new Error('redis down'); }
      enqueued.push(rcpts);
    },
  };

  await assert.rejects(deliverOnce('k', ['a@corp.test', 'b@corp.test'], ['x@ext.test'], deps), /db down/);
  await assert.rejects(deliverOnce('k', ['a@corp.test', 'b@corp.test'], ['x@ext.test'], deps), /redis down/);
  const last = await deliverOnce('k', ['a@corp.test', 'b@corp.test'], ['x@ext.test'], deps);
  const again = await deliverOnce('k', ['a@corp.test', 'b@corp.test'], ['x@ext.test'], deps);

  assert.deepEqual(stored, ['a@corp.test', 'b@corp.test']);
  assert.deepEqual(enqueued, [['x@ext.test']]);
  assert.deepEqual(last.skipped, ['a@corp.test', 'b@corp.test']);
  assert.equal(again.stored.length, 0, 'a fully failed-then-retried transaction is still deduplicated');
});
