/**
 * EAS request line: the plain query (+ MS-ASProtocolVersion / X-MS-PolicyKey headers) and the
 * base64-encoded query value of [MS-ASHTTP] (version byte, command code, locale, DeviceId,
 * policy key, DeviceType, tag/length/value parameters) yield the same facts.
 * Run: node --import tsx --test src/request.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequestLine, deviceIdText } from './request.js';

const headers = (h: Record<string, string>) => (name: string) => h[name];
const noHeaders = headers({});

/** Base64 request line as a device builds it, percent-encoded for the URL. */
function base64Line(opts: {
  version?: number; command?: number; deviceId?: Buffer; policyKey?: number[]; deviceType?: string; params?: Array<[number, Buffer | string]>;
} = {}): string {
  const deviceId = opts.deviceId ?? Buffer.from('ABC123');
  const deviceType = Buffer.from(opts.deviceType ?? 'TestPhone');
  const policyKey = opts.policyKey ?? [];
  const params = (opts.params ?? []).flatMap(([tag, v]) => { const b = Buffer.from(v); return [tag, b.length, ...b]; });
  const blob = Buffer.from([
    opts.version ?? 121, opts.command ?? 0, 0x09, 0x04,
    deviceId.length, ...deviceId, policyKey.length, ...policyKey, deviceType.length, ...deviceType, ...params,
  ]);
  return encodeURIComponent(blob.toString('base64'));
}

test('plain query: command, device, command parameters; version and policy key from the headers', () => {
  const r = parseRequestLine('Cmd=SmartReply&User=bob&DeviceId=ABC123&DeviceType=TestPhone&ItemId=m1&CollectionId=inbox&SaveInSent=T',
    headers({ 'MS-ASProtocolVersion': '12.1', 'X-MS-PolicyKey': '42' }));
  assert.deepEqual(r, { ok: true, line: {
    command: 'SmartReply', deviceId: 'ABC123', deviceType: 'TestPhone', protocolVersion: '12.1', policyKey: '42',
    params: { saveInSent: true, itemId: 'm1', collectionId: 'inbox' },
  } });
  const att = parseRequestLine('Cmd=GetAttachment&AttachmentName=att-1&LongId=x&Occurrence=2&SaveInSent=F', noHeaders);
  assert.ok(att.ok);
  assert.deepEqual(att.line.params, { saveInSent: false, attachmentName: 'att-1', longId: 'x', occurrence: '2' });
});

test('plain query defaults: unknown device, no version, no policy key; an empty query has no command', () => {
  const r = parseRequestLine('Cmd=Sync', noHeaders);
  assert.deepEqual(r, { ok: true, line: {
    command: 'Sync', deviceId: 'unknown', deviceType: 'Unknown', protocolVersion: '', policyKey: undefined, params: { saveInSent: false },
  } });
  const empty = parseRequestLine('', noHeaders);
  assert.ok(empty.ok && empty.line.command === '');
});

test('base64 query (byte fixture): version 121, SmartReply, GUID DeviceId as hex, policy key LE, parameters', () => {
  const guid = Buffer.from([...Array(16).keys()]);
  const raw = base64Line({
    version: 121, command: 3, deviceId: guid, policyKey: [0x78, 0x56, 0x34, 0x12],
    params: [[3, 'm1'], [1, 'inbox'], [7, Buffer.from([0x01])], [8, 'bob']],
  });
  assert.ok(!/[+/=]/.test(raw) && /%3D/.test(raw), 'base64 padding etc. percent-encoded in the URL');
  // the base64 form carries version and policy key itself: request headers are ignored
  const r = parseRequestLine(raw, headers({ 'MS-ASProtocolVersion': '14.1', 'X-MS-PolicyKey': '1' }));
  assert.deepEqual(r, { ok: true, line: {
    command: 'SmartReply', deviceId: '000102030405060708090A0B0C0D0E0F', deviceType: 'TestPhone',
    protocolVersion: '12.1', policyKey: String(0x12345678), params: { saveInSent: true, itemId: 'm1', collectionId: 'inbox' },
  } });
});

test('base64 query: every command code, version byte → dotted version, no policy key, AttachmentName / LongId', () => {
  const codes: Record<number, string> = {
    0: 'Sync', 1: 'SendMail', 2: 'SmartForward', 3: 'SmartReply', 4: 'GetAttachment', 9: 'FolderSync', 13: 'MoveItems',
    14: 'GetItemEstimate', 15: 'MeetingResponse', 16: 'Search', 17: 'Settings', 18: 'Ping', 19: 'ItemOperations',
    20: 'Provision', 21: 'ResolveRecipients',
  };
  for (const [code, name] of Object.entries(codes)) {
    const r = parseRequestLine(base64Line({ command: Number(code) }), noHeaders);
    assert.ok(r.ok && r.line.command === name, name);
  }
  const r = parseRequestLine(base64Line({ version: 140, command: 4, params: [[0, 'att-1'], [4, 'long-1'], [6, '3']] }), noHeaders);
  assert.ok(r.ok);
  assert.equal(r.line.protocolVersion, '14.0');
  assert.equal(r.line.policyKey, undefined);
  assert.equal(r.line.deviceId, 'ABC123', 'ASCII DeviceId kept as text');
  assert.deepEqual(r.line.params, { saveInSent: false, attachmentName: 'att-1', longId: 'long-1', occurrence: '3' });
  const unknown = parseRequestLine(base64Line({ command: 99 }), noHeaders);
  assert.ok(unknown.ok && unknown.line.command === '#99');
});

test('base64 query: truncated blob, bad policy key length, non-base64 and malformed escapes are refused', () => {
  const full = Buffer.from(decodeURIComponent(base64Line({ policyKey: [1, 2, 3, 4], params: [[1, 'inbox']] })), 'base64');
  const paramsStart = full.length - 7; // tag, length, 'inbox'
  for (let cut = 1; cut < full.length; cut++) {
    const r = parseRequestLine(encodeURIComponent(full.subarray(0, cut).toString('base64')), noHeaders);
    assert.equal(r.ok, cut === paramsStart, `cut at ${cut}: only the line without parameters is complete`);
  }
  assert.equal(parseRequestLine(base64Line({ policyKey: [1, 2, 3] }), noHeaders).ok, false);
  assert.equal(parseRequestLine('foo=bar&x=1', noHeaders).ok, false);
  assert.equal(parseRequestLine('%E0%A4%A', noHeaders).ok, false);
});

test('deviceIdText: alphanumerics as text, binary (GUID) as upper-case hex', () => {
  assert.equal(deviceIdText(Buffer.from('Dev42')), 'Dev42');
  assert.equal(deviceIdText(Buffer.from([0xde, 0xad, 0x00, 0x01])), 'DEAD0001');
  assert.equal(deviceIdText(Buffer.from('dev-1')), '6465762D31');
});
