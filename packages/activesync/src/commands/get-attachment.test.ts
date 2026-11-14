/**
 * Regression (e2e 7.0.0): EAS GetAttachment returned Content-Length with an empty body.
 * Run: node --import tsx --test src/commands/get-attachment.test.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { handleGetAttachment, type GetAttachmentDeps } from './get-attachment.js';

const DATA = Buffer.from('attachment-bytes-'.repeat(200));
const deps: GetAttachmentDeps = {
  findAttachment: async (id, userId) => (id === 'a1' && userId === 'u1'
    ? { mimeType: 'application/pdf', size: DATA.length, storagePath: 'attachments/m1/x' }
    : id === 'gone' ? { mimeType: 'text/plain', size: 3, storagePath: 'missing' } : null),
  openStream: async (p) => { if (p === 'missing') throw new Error('NoSuchKey'); return Readable.from([DATA.subarray(0, 100), DATA.subarray(100)]); },
};
const app = express();
app.post('/eas', (req, res) => { void handleGetAttachment(res, 'u1', String(req.query['AttachmentName']), deps); });
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

test('streams the stored bytes with type and length', async () => {
  const r = await fetch(`${base}/eas?AttachmentName=a1`, { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(DATA));
});

test('unknown attachment or unreadable object → 404', async () => {
  assert.equal((await fetch(`${base}/eas?AttachmentName=nope`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(`${base}/eas?AttachmentName=gone`, { method: 'POST' })).status, 404);
});
