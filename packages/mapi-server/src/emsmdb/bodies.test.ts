/** Mailbox endpoint bodies (MS-OXCMAPIHTTP 2.2.4.1–2.2.4.4). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConnectResponse, buildDisconnectResponse, buildExecuteResponse, buildNotificationWaitResponse,
  parseConnectRequest, parseDisconnectRequest, parseExecuteRequest, parseNotificationWaitRequest,
} from './bodies.js';
import { connectBody, executeBody, parseConnectResponse, parseExecuteResponse, wrapExtended } from '../testing/mapi-client.js';
import { WireFormatError } from '../wire/reader.js';

const hex = (s: string): Buffer => Buffer.from(s.replace(/\s+/g, ''), 'hex');

test('Connect request: UserDn, Flags, DefaultCodePage, LcidSort, LcidString, auxiliary buffer', () => {
  const body = Buffer.concat([Buffer.from('/o=X/cn=u\u0000', 'ascii'), hex('00000000 e4040000 09040000 07040000 02000000 abcd')]);
  assert.deepEqual(parseConnectRequest(body), { userDn: '/o=X/cn=u', flags: 0, codePage: 1252, lcidSort: 0x409, lcidString: 0x407 });
  assert.deepEqual(parseConnectRequest(connectBody('')).codePage, 1252);
  assert.throws(() => parseConnectRequest(hex('2f6f')), WireFormatError);
  assert.throws(() => parseConnectRequest(Buffer.concat([Buffer.from('a\u0000'), hex('00000000 00000000 00000000 00000000 05000000 ab')])), WireFormatError);
});

test('Connect response: StatusCode 0, ErrorCode, polling values, ASCII DnPrefix, Unicode DisplayName, empty aux', () => {
  const b = buildConnectResponse({ errorCode: 0, pollsMax: 60000, retryCount: 6, retryDelay: 10000, dnPrefix: '/o=X', displayName: 'Ünal' });
  assert.deepEqual(b.subarray(0, 20), hex('00000000 00000000 60ea0000 06000000 10270000'));
  assert.deepEqual(b.subarray(20, 25), Buffer.from('/o=X\u0000', 'ascii'));
  assert.deepEqual(b.subarray(25, 35), Buffer.from('Ünal\u0000', 'utf16le'));
  assert.deepEqual(b.subarray(35), hex('00000000'));
  assert.deepEqual(parseConnectResponse(b), { statusCode: 0, errorCode: 0, dnPrefix: '/o=X', displayName: 'Ünal' });
});

test('Execute request and response round trip (RopBuffer with RPC_HEADER_EXT)', () => {
  const rops = hex('0300 ff');
  const req = parseExecuteRequest(executeBody(rops, 0x10008));
  assert.equal(req.maxRopOut, 0x10008);
  assert.deepEqual(req.ropBuffer, wrapExtended(rops));
  const res = buildExecuteResponse(0, wrapExtended(hex('0200')));
  assert.deepEqual(res.subarray(0, 16), hex('00000000 00000000 00000000 0a000000'));
  assert.deepEqual(parseExecuteResponse(res), { statusCode: 0, errorCode: 0, ropBuffer: hex('0200') });
  assert.deepEqual(parseExecuteResponse(buildExecuteResponse(0x4b6, Buffer.alloc(0))), { statusCode: 0, errorCode: 0x4b6, ropBuffer: Buffer.alloc(0) });
});

test('Disconnect and NotificationWait bodies', () => {
  parseDisconnectRequest(hex('00000000'));
  parseDisconnectRequest(Buffer.alloc(0));
  assert.deepEqual(buildDisconnectResponse(), hex('00000000 00000000 00000000'));
  assert.deepEqual(parseNotificationWaitRequest(hex('00000000 00000000')), { flags: 0 });
  assert.deepEqual(buildNotificationWaitResponse(true), hex('00000000 00000000 01000000 00000000'));
});
