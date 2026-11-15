/**
 * Regression (e2e 7.0.0): WBXML code pages per [MS-ASWBXML] and code-page-aware
 * encoding. Previously AirSync tokens were shifted (no ServerId 0x0D), Ping lived
 * on page 17 instead of 13, ComposeMail on 25 instead of 21, and shared names
 * (Status, SyncKey, ServerId, …) were always emitted on the first page that
 * defines them — FolderSync/Provision responses carried AirSync:Status.
 * Run: node --import tsx --test src/wbxml.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWbxml, decodeWbxml, el, type WbxmlElement } from './wbxml.js';

const kids = (e: WbxmlElement): WbxmlElement[] => (e.children ?? []).filter((c): c is WbxmlElement => typeof c !== 'string');

/** [page, token] of every tag in a WBXML buffer (header: 4 single-byte fields). */
function tags(buf: Buffer): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let i = 4, page = 0;
  while (i < buf.length) {
    const b = buf[i++]!;
    if (b === 0x00) { page = buf[i++]!; continue; }
    if (b === 0x01) continue;
    if (b === 0x03) { while (buf[i++] !== 0x00); continue; }
    out.push([page, b & 0x3f]);
  }
  return out;
}

/** Builds a client request like a real device: [page, token, children | text]. */
type Node = [number, number, (Node[] | string)?];
function clientWbxml(root: Node): Buffer {
  const out = [0x03, 0x01, 0x6a, 0x00];
  let page = -1;
  const walk = ([p, t, kids]: Node) => {
    if (p !== page) { out.push(0x00, p); page = p; }
    out.push(t | (kids !== undefined ? 0x40 : 0));
    if (kids === undefined) return;
    if (typeof kids === 'string') out.push(0x03, ...Buffer.from(kids), 0x00); else kids.forEach(walk);
    out.push(0x01);
  };
  walk(root);
  return Buffer.from(out);
}

test('FolderSync response: every tag on the FolderHierarchy page (7)', () => {
  const buf = encodeWbxml(el('FolderSync', undefined, [
    el('Status', '1'), el('SyncKey', '42'),
    el('Changes', undefined, [el('Count', '1'), el('Add', undefined, [
      el('ServerId', 'f1'), el('ParentId', '0'), el('DisplayName', 'Inbox'), el('Type', '2'),
    ])]),
  ]));
  assert.deepEqual(tags(buf), [[7, 0x16], [7, 0x0c], [7, 0x12], [7, 0x0e], [7, 0x17], [7, 0x0f], [7, 0x08], [7, 0x09], [7, 0x07], [7, 0x0a]]);
});

test('Provision response: Status / PolicyKey on the Provision page (14)', () => {
  const buf = encodeWbxml(el('Provision', undefined, [
    el('Status', '1'),
    el('Policies', undefined, [el('Policy', undefined, [el('PolicyType', 'MS-EAS-Provisioning-WBXML'), el('Status', '1'), el('PolicyKey', '1')])]),
  ]));
  assert.ok(tags(buf).every(([p]) => p === 14), JSON.stringify(tags(buf)));
  assert.deepEqual(tags(buf).filter(([, t]) => t === 0x0b).length, 2); // Provision:Status
});

test('Sync response: AirSync tokens per spec (Status 0x0E, Collection 0x0F, ServerId 0x0D)', () => {
  const buf = encodeWbxml(el('Sync', undefined, [el('Collections', undefined, [el('Collection', undefined, [
    el('SyncKey', '2'), el('CollectionId', 'c1'), el('Status', '1'),
    el('Commands', undefined, [el('Add', undefined, [el('ServerId', 'm1'), el('ApplicationData', undefined, [el('Subject', 'Hi')])])]),
  ])])]));
  assert.deepEqual(tags(buf), [[0, 0x05], [0, 0x1c], [0, 0x0f], [0, 0x0b], [0, 0x12], [0, 0x0e], [0, 0x16], [0, 0x07], [0, 0x0d], [0, 0x1d], [2, 0x14]]);
});

test('decodes spec-encoded client requests (Sync, Ping on page 13, SendMail on page 21)', () => {
  const sync = decodeWbxml(clientWbxml([0, 0x05, [[0, 0x1c, [[0, 0x0f, [[0, 0x0b, '0'], [0, 0x12, 'inbox-id']]]]]]]));
  const col = kids(kids(sync)[0]!)[0]!;
  assert.equal(col.name, 'Collection');
  assert.deepEqual(kids(col).map((c) => [c.name, c.text]), [['SyncKey', '0'], ['CollectionId', 'inbox-id']]);

  const ping = decodeWbxml(clientWbxml([13, 0x05, [[13, 0x08, '480'], [13, 0x09, [[13, 0x0a, [[13, 0x0b, 'f1'], [13, 0x0c, 'Email']]]]]]]));
  assert.equal(ping.name, 'Ping');
  assert.deepEqual(kids(ping).map((c) => c.name), ['HeartbeatInterval', 'Folders']);

  const send = decodeWbxml(clientWbxml([21, 0x05, [[21, 0x11, 'cid'], [21, 0x08], [21, 0x10, 'From: a@b\r\n\r\nx']]]));
  assert.equal(send.name, 'SendMail');
  assert.deepEqual(kids(send).map((c) => c.name), ['ClientId', 'SaveInSentItems', 'Mime']);
});

test('encode → decode round trip keeps names', () => {
  const tree = el('Ping', undefined, [el('Status', '2'), el('Folders', undefined, [el('Folder', 'f1')])]);
  const back = decodeWbxml(encodeWbxml(tree));
  assert.equal(back.name, 'Ping');
  assert.deepEqual(kids(back).map((c) => c.name), ['Status', 'Folders']);
  assert.ok(tags(encodeWbxml(tree)).every(([p]) => p === 13));
});

test('decoder rejects truncated OPAQUE data, unterminated strings and unsupported global tokens', () => {
  const H = [0x03, 0x01, 0x6a, 0x00, 0x00, 21];
  // Mime (0x50) with OPAQUE length 10 but only 3 bytes left
  assert.throws(() => decodeWbxml(Buffer.from([...H, 0x45, 0x50, 0xc3, 0x0a, 0x41, 0x42, 0x43])), /OPAQUE/);
  // STR_I without terminator
  assert.throws(() => decodeWbxml(Buffer.from([...H, 0x45, 0x50, 0x03, 0x41, 0x42])), /Unterminated/);
  // STR_T (0x83), LITERAL (0x04), EXT_I_0 (0x40) are not EAS — never parsed as elements
  for (const g of [0x83, 0x04, 0x40, 0x02]) {
    assert.throws(() => decodeWbxml(Buffer.from([...H, 0x45, g, 0x00, 0x01, 0x01])), /global token/, `0x${g.toString(16)}`);
  }
  // a valid OPAQUE still decodes byte-exact
  const ok = decodeWbxml(Buffer.from([...H, 0x45, 0x50, 0xc3, 0x02, 0xe9, 0x00, 0x01, 0x01]));
  assert.deepEqual([...(kids(ok)[0]!.bytes ?? [])], [0xe9, 0x00]);
});
