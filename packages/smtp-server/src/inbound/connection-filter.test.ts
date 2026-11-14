/**
 * Caller-side decision logic for the security-filter connection stages.
 * Run: node --import tsx --test src/inbound/connection-filter.test.ts  (in packages/smtp-server)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  callConnectionFilter,
  connectionAllowed,
  dataStageGreylistReply,
  interpretConnectionFilterResponse as interpret,
  rcptReplyForDecision,
} from './connection-filter.js';

test('200 + accept → accept', () => {
  assert.deepEqual(interpret(200, { action: 'accept', reason: 'ok' }), { kind: 'accept', reason: 'ok' });
});

test('200 + reject/defer → block with reason', () => {
  assert.deepEqual(interpret(200, { action: 'reject', reason: 'DNSBL' }), { kind: 'block', action: 'reject', reason: 'DNSBL' });
  assert.deepEqual(interpret(200, { action: 'defer' }), { kind: 'block', action: 'defer', reason: 'Try again later' });
});

test('non-200 is "unavailable", never a silent accept (old 400 bug)', () => {
  const d = interpret(400, { error: 'Missing senderIp, mailFrom, or rcptTo' });
  assert.equal(d.kind, 'unavailable');
  assert.match((d as { detail: string }).detail, /HTTP 400: Missing senderIp/);
  assert.equal(interpret(500, undefined).kind, 'unavailable');
});

test('missing or unknown action is "unavailable"', () => {
  assert.equal(interpret(200, {}).kind, 'unavailable');
  assert.equal(interpret(200, { action: 'maybe' }).kind, 'unavailable');
  assert.equal(interpret(200, null).kind, 'unavailable');
  assert.equal(interpret(200, 'accept').kind, 'unavailable');
});

test('connect stage: only an explicit block closes the connection (fail-open)', () => {
  assert.equal(connectionAllowed({ kind: 'accept' }), true);
  assert.equal(connectionAllowed({ kind: 'unavailable', detail: 'x' }), true);
  assert.equal(connectionAllowed({ kind: 'block', action: 'reject', reason: 'r' }), false);
  assert.equal(connectionAllowed({ kind: 'block', action: 'defer', reason: 'r' }), false);
});

test('RCPT stage replies: defer → 4.7.1, reject → 5.7.1, unavailable → accept', () => {
  assert.equal(rcptReplyForDecision({ kind: 'block', action: 'defer', reason: 'Greylisted' }), '4.7.1 Greylisted');
  assert.equal(rcptReplyForDecision({ kind: 'block', action: 'reject', reason: 'No' }), '5.7.1 No');
  assert.equal(rcptReplyForDecision({ kind: 'unavailable', detail: 'down' }), null);
  assert.equal(rcptReplyForDecision({ kind: 'accept' }), null);
});

test('DATA-stage fallback: any reject wins, then any defer, else continue', () => {
  const ok = { kind: 'accept' } as const;
  const defer = { kind: 'block', action: 'defer', reason: 'Greylisted' } as const;
  const reject = { kind: 'block', action: 'reject', reason: 'Blocked' } as const;
  assert.equal(dataStageGreylistReply([ok, ok]), null);
  assert.equal(dataStageGreylistReply([ok, defer]), '451 4.7.1 Greylisted');
  assert.equal(dataStageGreylistReply([defer, reject]), '550 5.7.1 Blocked');
  assert.equal(dataStageGreylistReply([{ kind: 'unavailable', detail: 'x' }]), null);
});

test('callConnectionFilter sends the stage payload and maps the response', async () => {
  let seen: { url: string; body: unknown } | null = null;
  const fake = async (url: string, init: { body: string }) => {
    seen = { url, body: JSON.parse(init.body) };
    return { status: 200, json: async () => ({ action: 'defer', reason: 'Greylisted' }) };
  };
  const d = await callConnectionFilter('http://sf:3002', {
    stage: 'rcpt', senderIp: '192.0.2.1', mailFrom: '', rcptTo: 'bob@firma.de',
  }, fake);
  assert.deepEqual(d, { kind: 'block', action: 'defer', reason: 'Greylisted' });
  assert.deepEqual(seen, {
    url: 'http://sf:3002/check/connection',
    body: { stage: 'rcpt', senderIp: '192.0.2.1', mailFrom: '', rcptTo: 'bob@firma.de' },
  });
});

test('callConnectionFilter: network error / non-JSON body → unavailable', async () => {
  const down = async () => { throw new Error('ECONNREFUSED'); };
  const d1 = await callConnectionFilter('http://sf', { stage: 'connect', senderIp: '192.0.2.1' }, down);
  assert.equal(d1.kind, 'unavailable');
  const garbage = async () => ({ status: 200, json: async () => { throw new SyntaxError('bad json'); } });
  const d2 = await callConnectionFilter('http://sf', { stage: 'connect', senderIp: '192.0.2.1' }, garbage);
  assert.equal(d2.kind, 'unavailable');
});
