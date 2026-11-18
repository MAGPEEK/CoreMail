/**
 * Shared fixtures for the ActiveSync body / ItemOperations / GetItemEstimate tests
 * (no runtime imports — safe to load before the Prisma seam is set).
 */
import type { WbxmlElement } from '../wbxml.js';

/**
 * RFC 5322 source with an HTML/plain alternative, an inline image (Content-ID) and a
 * PDF attachment. Contains one 8-bit Latin-1 octet (0xE9) in the plain part so a
 * UTF-8 round trip would be detected (MIME must be delivered byte-exact).
 */
export const RAW_MESSAGE: Buffer = Buffer.concat([
  Buffer.from([
    'From: "Alice Example" <alice@example.test>',
    'To: bob@example.test',
    'Subject: Quarterly report',
    'Date: Sun, 15 Nov 2026 08:00:00 +0000',
    'Message-ID: <q3@example.test>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="mix"',
    '',
    '--mix',
    'Content-Type: multipart/related; boundary="rel"',
    '',
    '--rel',
    'Content-Type: multipart/alternative; boundary="alt"',
    '',
    '--alt',
    'Content-Type: text/plain; charset=iso-8859-1',
    'Content-Transfer-Encoding: 8bit',
    '',
    'Caf',
  ].join('\r\n'), 'latin1'),
  Buffer.from([0xe9]),
  Buffer.from([
    ' report attached.',
    '--alt',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>Caf&eacute; report <img src="cid:logo@x"></p>',
    '--alt--',
    '--rel',
    'Content-Type: image/png',
    'Content-ID: <logo@x>',
    'Content-Disposition: inline; filename="logo.png"',
    'Content-Transfer-Encoding: base64',
    '',
    'iVBORw0KGgo=',
    '--rel--',
    '--mix',
    'Content-Type: application/pdf; name="report.pdf"',
    'Content-Disposition: attachment; filename="report.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    'JVBERi0xLjQK',
    '--mix--',
    '',
  ].join('\r\n'), 'latin1'),
]);

export const PDF_BYTES = Buffer.from('%PDF-1.4\n', 'latin1');
export const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Message row columns (as selected by EAS_MESSAGE_SELECT / the Sync window) for RAW_MESSAGE. */
export function messageRow(over: Record<string, unknown> = {}) {
  return {
    id: 'msg1', modSeq: 3n, flags: ['\\Seen'], subject: 'Quarterly report',
    fromAddr: 'alice@example.test', fromName: 'Alice Example',
    toAddrs: ['bob@example.test'], ccAddrs: [], replyTo: null,
    messageId: '<q3@example.test>', inReplyTo: null, threadId: null,
    date: new Date('2026-11-15T08:00:00Z'),
    bodyText: 'Café report attached. Ünïcödé ✓',
    bodyHtml: '<p>Caf&eacute; report <img src="cid:logo@x"></p>',
    storagePath: 'raw/abc', smimeMeta: null,
    ...over,
  };
}

export const ATTACHMENT_ROWS = [
  { id: 'att-logo', messageId: 'msg1', filename: 'logo.png', mimeType: 'image/png', size: PNG_BYTES.length, contentId: '<logo@x>', inline: true, storagePath: 'att/logo' },
  { id: 'att-pdf', messageId: 'msg1', filename: 'report.pdf', mimeType: 'application/pdf', size: PDF_BYTES.length, contentId: null, inline: false, storagePath: 'att/pdf' },
];

/** Depth-first search for the first element named `name` (optionally on `page`). */
export function find(e: WbxmlElement, name: string, page?: number): WbxmlElement | undefined {
  if (e.name === name && (page === undefined || e.page === page)) return e;
  for (const c of e.children ?? []) {
    if (typeof c === 'string') continue;
    const hit = find(c, name, page);
    if (hit) return hit;
  }
  return undefined;
}

export function findAll(e: WbxmlElement, name: string, out: WbxmlElement[] = []): WbxmlElement[] {
  if (e.name === name) out.push(e);
  for (const c of e.children ?? []) if (typeof c !== 'string') findAll(c, name, out);
  return out;
}

/** Client-side encoder like a real device: [page, token, children | text | raw bytes]. */
export type ClientNode = [number, number, (ClientNode[] | string | Buffer)?];
export function clientWbxml(root: ClientNode): Buffer {
  const out: number[] = [0x03, 0x01, 0x6a, 0x00];
  let page = -1;
  const walk = ([p, t, kids]: ClientNode) => {
    if (p !== page) { out.push(0x00, p); page = p; }
    out.push(t | (kids !== undefined ? 0x40 : 0));
    if (kids === undefined) return;
    // byte by byte: spreading a multi-megabyte body into push() overflows the call stack
    if (typeof kids === 'string' || Buffer.isBuffer(kids)) {
      out.push(0x03);
      for (const b of typeof kids === 'string' ? Buffer.from(kids, 'utf8') : kids) out.push(b);
      out.push(0x00);
    }
    else kids.forEach(walk);
    out.push(0x01);
  };
  walk(root);
  return Buffer.from(out);
}

/** Minimal env for importing @coremail/core / @coremail/storage in tests. */
export function testEnv(): void {
  process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/test';
  process.env['JWT_SECRET'] ??= 'test-secret-test-secret-test-secret-1234';
  process.env['PEPPER'] ??= 'test-pepper-test-pepper-test-pepper-1234';
}
