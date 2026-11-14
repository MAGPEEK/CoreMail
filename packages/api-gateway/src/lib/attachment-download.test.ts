/**
 * Attachment download: permission matrix (own / shared / delegated / foreign),
 * response headers (Content-Disposition RFC 6266, nosniff, inline only for raster
 * images), streaming and error paths.
 * Run: node --import tsx --test src/lib/attachment-download.test.ts  (in packages/api-gateway)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import {
  readableMailboxWhere, createAttachmentDownloadHandler, contentDisposition, safeContentType,
  type DownloadableAttachment,
} from './attachment-download.js';

// ── Permission matrix: evaluate the Prisma filter against fixture mailboxes ──

interface Perm { userId: string; permission: string }
interface FakeMailbox {
  id: string;
  userId: string | null;
  sharedBox: { active: boolean; permissions: Perm[] } | null;
  delegates: Array<{ granteeId: string; permission: string }>;
}

type Where = ReturnType<typeof readableMailboxWhere>;
function canRead(mb: FakeMailbox, where: Where): boolean {
  return where.OR.some((cond) => {
    if ('userId' in cond) return mb.userId === cond.userId;
    if ('sharedBox' in cond) {
      const sb = mb.sharedBox;
      const want = cond.sharedBox.permissions.some;
      return !!sb && sb.active === cond.sharedBox.active
        && sb.permissions.some((p) => p.userId === want.userId && want.permission.in.includes(p.permission as never));
    }
    const want = cond.delegates.some;
    return mb.delegates.some((d) => d.granteeId === want.granteeId && want.permission.in.includes(d.permission as never));
  });
}

const shared = (id: string, permission: string, active = true): FakeMailbox =>
  ({ id, userId: null, sharedBox: { active, permissions: [{ userId: 'u1', permission }] }, delegates: [] });
const delegated = (id: string, permission: string): FakeMailbox =>
  ({ id, userId: 'owner', sharedBox: null, delegates: [{ granteeId: 'u1', permission }] });

test('permission matrix: who may download an attachment', () => {
  const where = readableMailboxWhere('u1');
  const cases: Array<[FakeMailbox, boolean]> = [
    [{ id: 'own', userId: 'u1', sharedBox: null, delegates: [] }, true],
    [{ id: 'foreign', userId: 'u2', sharedBox: null, delegates: [] }, false],
    [shared('shared-full', 'FULL_ACCESS'), true],
    [shared('shared-ro', 'READ_ONLY'), true],
    [shared('shared-sendas', 'SEND_AS'), false],
    [shared('shared-onbehalf', 'SEND_ON_BEHALF'), false],
    [shared('shared-inactive', 'FULL_ACCESS', false), false],
    [delegated('deleg-full', 'FULL_ACCESS'), true],
    [delegated('deleg-ro', 'READ_ONLY'), true],
    [delegated('deleg-sendas', 'SEND_AS'), false],
    [{ id: 'shared-other-user', userId: null, sharedBox: { active: true, permissions: [{ userId: 'u2', permission: 'FULL_ACCESS' }] }, delegates: [] }, false],
  ];
  for (const [mb, expected] of cases) assert.equal(canRead(mb, where), expected, mb.id);
});

// ── Handler ──────────────────────────────────────────────────────────────────

class FakeRes extends Writable {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = Buffer.alloc(0);
  json?: unknown;
  done: Promise<void>;
  private resolve!: () => void;
  constructor() {
    super();
    this.done = new Promise((r) => { this.resolve = r; });
    this.on('finish', () => this.resolve());
  }
  override _write(chunk: Buffer, _enc: string, cb: () => void): void { this.body = Buffer.concat([this.body, chunk]); cb(); }
  status(code: number): this { this.statusCode = code; return this; }
  setHeader(k: string, v: string): void { this.headers[k.toLowerCase()] = v; }
  sendJson(v: unknown): void { this.json = v; this.resolve(); }
}

function call(att: DownloadableAttachment | null, query: Record<string, string> = {}, objects: Record<string, string> = {}) {
  const handler = createAttachmentDownloadHandler({
    findAttachment: async (id, userId) => (att && id === att.id && userId === 'u1' ? att : null),
    openStream: async (key) => {
      if (!(key in objects)) throw new Error('NoSuchKey');
      return Readable.from([Buffer.from(objects[key]!)]);
    },
  });
  const res = new FakeRes();
  (res as unknown as { json: (v: unknown) => void }).json = (v: unknown) => res.sendJson(v);
  const req = { apiUser: { userId: 'u1' }, params: { id: 'a1' }, query };
  return handler(req as never, res as never).then(() => res.done).then(() => res);
}

const pdf: DownloadableAttachment = { id: 'a1', filename: 'Bericht "Q1"\r\n/../ü.pdf', mimeType: 'application/pdf', size: 4, storagePath: 'attachments/m1/0' };

test('streams the object with attachment disposition, RFC 6266 filename* and nosniff', async () => {
  const res = await call(pdf, {}, { 'attachments/m1/0': '%PDF' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.toString(), '%PDF');
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.equal(res.headers['content-disposition'], `attachment; filename="Bericht Q1.._.pdf"; filename*=UTF-8''Bericht%20Q1..%C3%BC.pdf`);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.match(res.headers['content-security-policy'] ?? '', /sandbox/);
});

test('inline only for raster images; HTML and SVG are always downloads', async () => {
  const png = { ...pdf, filename: 'logo.png', mimeType: 'image/png' };
  assert.match((await call(png, { disposition: 'inline' }, { 'attachments/m1/0': 'x' })).headers['content-disposition']!, /^inline; /);
  for (const mimeType of ['text/html', 'image/svg+xml', 'application/xhtml+xml']) {
    const res = await call({ ...pdf, mimeType }, { disposition: 'inline' }, { 'attachments/m1/0': 'x' });
    assert.match(res.headers['content-disposition']!, /^attachment; /, mimeType);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  }
  assert.equal(safeContentType('text/html; charset=utf-8\r\nX: y'), 'application/octet-stream');
});

test('404 for foreign/unknown attachments, rows without content and missing objects', async () => {
  assert.equal((await call(null)).statusCode, 404);
  assert.equal((await call({ ...pdf, storagePath: '' })).statusCode, 404);
  assert.equal((await call(pdf, {}, {})).statusCode, 404);
});

test('contentDisposition strips control characters and quotes', () => {
  assert.equal(contentDisposition('attachment', 'a"b\r\nc.txt'), `attachment; filename="abc.txt"; filename*=UTF-8''abc.txt`);
  assert.equal(contentDisposition('attachment', ''), `attachment; filename="attachment"; filename*=UTF-8''attachment`);
});
