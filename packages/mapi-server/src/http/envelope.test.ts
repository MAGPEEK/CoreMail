/** MAPI over HTTP envelope (MS-OXCMAPIHTTP 2.2.2–2.2.7): headers, cookies, meta-tags. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  doneSection, parseCookies, readMapiHeaders, responseHeaders, ResponseCode, setCookie, clearCookie, validateRequest,
  isCookieValue,
} from './envelope.js';

const headers = (h: Record<string, string>) => readMapiHeaders((n) => h[n]);
const base = { 'x-requesttype': 'Execute', 'x-requestid': '{A}:1', 'x-clientinfo': '{C}' };

test('X-ResponseCode values follow the specification table', () => {
  assert.deepEqual(
    [ResponseCode.InvalidVerb, ResponseCode.InvalidHeader, ResponseCode.InvalidRequestType, ResponseCode.MissingHeader,
      ResponseCode.AnonymousNotAllowed, ResponseCode.TooLarge, ResponseCode.ContextNotFound, ResponseCode.InvalidRequestBody,
      ResponseCode.MissingCookie, ResponseCode.InvalidSequence, ResponseCode.EndpointDisabled],
    [2, 4, 5, 7, 8, 9, 10, 12, 13, 15, 16],
  );
});

test('validateRequest: verb, required headers, request type per endpoint, content type', () => {
  const ct = 'application/mapi-http';
  assert.equal(validateRequest('emsmdb', 'GET', ct, headers(base)), ResponseCode.InvalidVerb);
  assert.equal(validateRequest('emsmdb', 'POST', ct, headers({ ...base, 'x-requestid': '' })), ResponseCode.MissingHeader);
  assert.equal(validateRequest('emsmdb', 'POST', ct, headers({ ...base, 'x-requesttype': 'Bind' })), ResponseCode.InvalidRequestType);
  assert.equal(validateRequest('nspi', 'POST', ct, headers({ ...base, 'x-requesttype': 'Bind' })), null);
  assert.equal(validateRequest('emsmdb', 'POST', 'text/xml', headers(base)), ResponseCode.InvalidHeader);
  assert.equal(validateRequest('emsmdb', 'POST', undefined, headers({ ...base, 'x-requesttype': 'PING' })), null);
  assert.equal(validateRequest('emsmdb', 'POST', `${ct}; charset=x`, headers(base)), null);
  assert.equal(validateRequest('emsmdb', 'POST', ct, headers({ ...base, 'x-requestid': 'x'.repeat(300) })), ResponseCode.InvalidHeader);
});

test('cookies: parsing, issued format, attributes', () => {
  assert.deepEqual(parseCookies('MapiContext=abc; MapiSequence=def;  other=1'), { MapiContext: 'abc', MapiSequence: 'def', other: '1' });
  assert.equal(isCookieValue('A'.repeat(43)), true);
  assert.equal(isCookieValue('A'.repeat(42)), false);
  assert.equal(isCookieValue('A'.repeat(42) + ';'), false);
  assert.equal(setCookie('MapiContext', 'v', true), 'MapiContext=v; Path=/mapi/; HttpOnly; SameSite=Strict; Secure');
  assert.equal(clearCookie('MapiSequence', false), 'MapiSequence=; Path=/mapi/; Max-Age=0; HttpOnly; SameSite=Strict');
});

test('DONE section: meta-tag, final X-ResponseCode, timing headers, blank line, body', () => {
  const started = new Date('2026-11-17T10:00:00Z');
  const done = doneSection(0, 12.4, started, Buffer.from([1, 2]));
  assert.equal(done.subarray(0, done.length - 2).toString('ascii'),
    'DONE\r\nX-ResponseCode: 0\r\nX-ElapsedTime: 12\r\nX-StartTime: Tue, 17 Nov 2026 10:00:00 GMT\r\n\r\n');
  assert.deepEqual(done.subarray(done.length - 2), Buffer.from([1, 2]));
});

test('response headers echo the request id, type and client info', () => {
  const r = responseHeaders(headers(base), 0, { 'X-PendingPeriod': '15000' });
  assert.equal(r['X-RequestId'], '{A}:1');
  assert.equal(r['X-RequestType'], 'Execute');
  assert.equal(r['X-ClientInfo'], '{C}');
  assert.equal(r['X-ResponseCode'], '0');
  assert.equal(r['Content-Type'], 'application/mapi-http');
  assert.equal(r['X-PendingPeriod'], '15000');
});
