/**
 * Message trace (10.2): bounded stage recorder, reader-side sanitiser and the
 * RFC 8601 Authentication-Results parser.
 * Run: node --import tsx --test src/message-trace.test.ts  (in packages/storage)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTraceRecorder, sanitizeTrace, traceStage, boundDetail, traceText, TRACE_LIMITS,
  parseAuthenticationResults, authResultDomain,
} from './message-trace.js';

const AT = new Date('2026-11-20T10:00:00Z');

test('a stage keeps valid detail keys only, caps strings and lists, and flattens control characters', () => {
  const s = traceStage('connection', 'ok', {
    clientIp: '192.0.2.1',
    helo: 'mx.example\r\nInjected: header',
    'bad key': 'x',
    hosts: Array.from({ length: 20 }, (_, i) => `mx${i}.example`),
    long: 'a'.repeat(1000),
    empty: '',
    nested: { no: 'objects' },
    port: 25,
    tls: false,
  }, { at: AT, ms: 12.6 });
  assert.equal(s.stage, 'connection');
  assert.equal(s.at, AT.toISOString());
  assert.equal(s.ms, 13);
  assert.equal(s.detail?.['helo'], 'mx.example Injected: header');
  assert.equal(s.detail?.['bad key'], undefined);
  assert.equal(s.detail?.['empty'], undefined);
  assert.equal(s.detail?.['nested'], undefined);
  assert.equal((s.detail?.['hosts'] as string[]).length, TRACE_LIMITS.list + 1);
  assert.equal((s.detail?.['hosts'] as string[]).at(-1), '+8');
  assert.equal((s.detail?.['long'] as string).length, TRACE_LIMITS.string);
  assert.equal(s.detail?.['port'], 25);
  assert.equal(s.detail?.['tls'], false);
});

test('an unknown stage name or result is normalised, never stored verbatim', () => {
  const s = traceStage('Bad Stage!', 'weird' as never, undefined, { at: AT });
  assert.equal(s.stage, 'other');
  assert.equal(s.result, 'info');
  assert.equal('detail' in s, false);
});

test('the recorder is seeded, bounded and returns copies', () => {
  const seed = [traceStage('connection', 'ok', { port: 25 }, { at: AT })];
  const r = createTraceRecorder(seed, () => AT);
  r.add('spam', 'ok', { score: 1.2 });
  const snapshot = r.stages();
  snapshot.pop();
  assert.equal(r.stages().length, 2, 'stages() is a copy');
  for (let i = 0; i < 100; i++) r.add('remote', 'warn', { i });
  assert.equal(r.stages().length, TRACE_LIMITS.stages);
  assert.equal(r.toJSON().v, 1);
});

test('boundDetail caps the number of keys', () => {
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i]));
  assert.equal(Object.keys(boundDetail(many) ?? {}).length, TRACE_LIMITS.detailKeys);
  assert.equal(boundDetail([1, 2]), undefined);
  assert.equal(traceText(null), '');
});

test('sanitizeTrace drops malformed stages and rows without a trace', () => {
  assert.equal(sanitizeTrace(undefined), null);
  assert.equal(sanitizeTrace({ stages: 'x' }), null);
  assert.equal(sanitizeTrace({ stages: [{ stage: 'x y', at: AT.toISOString(), result: 'ok' }] }), null);
  const t = sanitizeTrace({
    v: 1,
    stages: [
      { stage: 'spam', at: AT.toISOString(), result: 'ok', ms: 5, detail: { score: 2, '<script>': 'x' } },
      { stage: 'delivery', at: 'not a date', result: 'ok' },
      { stage: 'delivery', at: AT.toISOString(), result: 'bogus', detail: { folder: 'INBOX' }, ms: -3 },
      null,
    ],
  });
  assert.ok(t);
  assert.equal(t.stages.length, 2);
  assert.deepEqual(t.stages[0], { stage: 'spam', at: AT.toISOString(), ms: 5, result: 'ok', detail: { score: 2 } });
  assert.deepEqual(t.stages[1], { stage: 'delivery', at: AT.toISOString(), result: 'info', detail: { folder: 'INBOX' } });
});

test('Authentication-Results: Gmail-style verdict with comments and quoted values', () => {
  const v = 'mx.google.com;\r\n       dkim=pass header.i=@example.com header.s=sel1 header.b=AbCd;\r\n'
    + '       spf=pass (google.com: domain of bounce@example.com designates 192.0.2.1 as permitted sender) smtp.mailfrom=bounce@example.com;\r\n'
    + '       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com;\r\n'
    + '       arc=none reason="no; signatures"';
  const r = parseAuthenticationResults(v);
  assert.equal(r.authservId, 'mx.google.com');
  assert.deepEqual(r.results.map((x) => [x.method, x.result]), [['dkim', 'pass'], ['spf', 'pass'], ['dmarc', 'pass'], ['arc', 'none']]);
  assert.equal(authResultDomain(r.results[0]!), 'example.com');
  assert.equal(authResultDomain(r.results[1]!), 'example.com');
  assert.equal(r.results[2]!.props['header.from'], 'example.com');
  assert.equal(r.results[3]!.props['reason'], 'no; signatures');
});

test('Authentication-Results: ARC instance tag, versions, garbage and huge input', () => {
  const arc = parseAuthenticationResults('i=1; mx.microsoft.com 1; spf=fail smtp.mailfrom=x.test; dkim/1=none');
  assert.equal(arc.authservId, 'mx.microsoft.com');
  assert.deepEqual(arc.results.map((x) => x.method), ['spf', 'dkim']);
  assert.deepEqual(parseAuthenticationResults('none').results, []);
  assert.deepEqual(parseAuthenticationResults('host; ;;; =; spf; garbage here').results, []);
  const huge = `host; ${'spf=pass '.repeat(5000)}${'('.repeat(10000)}`;
  const t0 = Date.now();
  const h = parseAuthenticationResults(huge);
  assert.ok(Date.now() - t0 < 500, 'linear time on hostile input');
  assert.ok(h.results.length <= 16);
});
