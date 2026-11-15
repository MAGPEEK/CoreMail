/**
 * Review 7.1.0: SendMail decoded the opaque `Mime` as UTF-8 (8-bit MIME corrupted), a retried
 * SendMail (same ClientId) was sent twice, SmartReply/SmartForward ignored Source/ReplaceMime
 * (forwards lost the original body and attachments), and the Sent copy had no raw message and
 * no attachments.
 * Run: node --import tsx --test src/commands/send-mail.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installFakeDb } from '../test-support/fake-db.js';

const db = installFakeDb({
  user: [{ id: 'u1', email: 'bob@example.com', active: true }],
  emailAlias: [], sharedMailboxPerm: [],
  mailbox: [{ id: 'mb1', userId: 'u1', uidNext: 5, highestModSeq: 9n }],
  folder: [{ id: 'inbox', mailboxId: 'mb1', name: 'INBOX', totalCount: 0 }, { id: 'sent', mailboxId: 'mb1', name: 'Sent', totalCount: 0 }],
  message: [], attachment: [], systemLog: [],
});

const { handleSendMail, saveSentCopy } = await import('./send-mail.js');
const { decodeWbxml } = await import('../wbxml.js');
const storage = await import('@coremail/storage');
type E = import('../wbxml.js').WbxmlElement;
type Deps = import('./send-mail.js').SendMailDeps;
type Job = import('../outbound.js').RawOutboundJob;

/** 8-bit Latin-1 MIME (0xE9 is not valid UTF-8 on its own). */
const MIME = Buffer.concat([
  Buffer.from('From: bob@example.com\r\nTo: carol@ext.test\r\nSubject: caf\xe9\r\nDate: Sun, 15 Nov 2026 08:00:00 +0000\r\nMessage-ID: <x1@example.com>\r\n'
    + 'MIME-Version: 1.0\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\nCaf', 'latin1'),
  Buffer.from([0xe9]),
  Buffer.from(' ole\r\n', 'latin1'),
]);
const ORIGINAL = Buffer.from('From: carol@ext.test\r\nTo: bob@example.com\r\nSubject: Report\r\nMIME-Version: 1.0\r\n'
  + 'Content-Type: multipart/mixed; boundary="o"\r\n\r\n--o\r\nContent-Type: text/plain\r\n\r\nsee attached\r\n--o\r\n'
  + 'Content-Type: application/pdf; name="r.pdf"\r\nContent-Disposition: attachment; filename="r.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQK\r\n--o--\r\n', 'latin1');

/** ComposeMail request with Mime as WBXML OPAQUE (how devices send it). */
function composeReq(cmd: 'SendMail' | 'SmartReply' | 'SmartForward', mime: Buffer, extra: number[] = []): E {
  const tok = { SendMail: 0x05, SmartForward: 0x06, SmartReply: 0x07 }[cmd];
  const mb = (n: number) => { const out = [n & 0x7f]; n >>= 7; while (n > 0) { out.unshift((n & 0x7f) | 0x80); n >>= 7; } return out; };
  return decodeWbxml(Buffer.from([0x03, 0x01, 0x6a, 0x00, 0x00, 21, tok | 0x40, ...extra, 0x08, 0x50, 0xc3, ...mb(mime.length), ...mime, 0x01, 0x01]));
}
const str = (tok: number, s: string) => [tok | 0x40, 0x03, ...Buffer.from(s), 0x00, 0x01];
const clientId = (id: string) => str(0x11, id);
const source = (itemId: string, folderId = 'inbox') => [0x4b, ...str(0x0c, folderId), ...str(0x0d, itemId), 0x01];
const status = (buf: Buffer) => (decodeWbxml(buf).children?.find((c) => typeof c !== 'string' && c.name === 'Status') as E | undefined)?.text;

function deps(over: Partial<Deps> = {}) {
  const jobs: Job[] = [];
  const claimed = new Set<string>();
  const marks: string[] = [];
  const sent: unknown[] = [];
  const d: Deps = {
    enqueue: async (j) => { jobs.push(j); },
    claimClientId: async (u, c) => { const k = `${u}:${c}`; if (claimed.has(k)) return false; claimed.add(k); return true; },
    releaseClientId: async (u, c) => { claimed.delete(`${u}:${c}`); },
    saveSentCopy: async (_u, plan) => { sent.push(plan); },
    loadSource: async (_u, ref) => (ref.itemId === 'orig'
      ? { id: 'orig', folderId: 'inbox', flags: [], mailboxId: 'mb1', subject: 'Report', raw: ORIGINAL } : null),
    markSource: async (_s, flag) => { marks.push(flag); },
    ...over,
  };
  return { d, jobs, marks, sent };
}

test('opaque 8-bit MIME is queued byte-exact (no UTF-8 round trip)', async () => {
  const { d, jobs } = deps();
  assert.equal(status(await handleSendMail(composeReq('SendMail', MIME), 'u1', 'SendMail', d)), '1');
  assert.equal(jobs.length, 1);
  assert.ok(Buffer.from(jobs[0]!.rawMessage, 'base64').equals(MIME), 'rawMessage must be the client octets');
});

test('ClientId: a retried SendMail is not sent twice (Status 118); a failed send can be retried', async () => {
  const { d, jobs } = deps();
  assert.equal(status(await handleSendMail(composeReq('SendMail', MIME, clientId('c-1')), 'u1', 'SendMail', d)), '1');
  assert.equal(status(await handleSendMail(composeReq('SendMail', MIME, clientId('c-1')), 'u1', 'SendMail', d)), '118');
  assert.equal(jobs.length, 1);

  let fail = true;
  const flaky = deps({ enqueue: async (j) => { if (fail) throw new Error('redis down'); jobs.push(j); } }).d;
  assert.equal(status(await handleSendMail(composeReq('SendMail', MIME, clientId('c-2')), 'u1', 'SendMail', flaky)), '110');
  fail = false;
  assert.equal(status(await handleSendMail(composeReq('SendMail', MIME, clientId('c-2')), 'u1', 'SendMail', flaky)), '1');
  assert.equal(jobs.length, 2);
});

test('SmartForward appends the original (body + attachments) as message/rfc822; source flagged $Forwarded', async () => {
  const { d, jobs, marks } = deps();
  assert.equal(status(await handleSendMail(composeReq('SmartForward', MIME, source('orig')), 'u1', 'SmartForward', d)), '1');
  const raw = Buffer.from(jobs[0]!.rawMessage, 'base64');
  assert.ok(raw.includes(ORIGINAL), 'original octets embedded unchanged');
  assert.ok(raw.includes(MIME.subarray(MIME.indexOf('\r\n\r\n') + 4)), 'client body kept byte-exact');
  const head = raw.subarray(0, raw.indexOf('\r\n\r\n')).toString('latin1');
  assert.match(head, /^To: carol@ext.test$/m);
  assert.match(head, /^Content-Type: multipart\/mixed; boundary=/m);
  assert.match(raw.toString('latin1'), /Content-Type: message\/rfc822\r\nContent-Disposition: attachment; filename\*=UTF-8''Report\.eml/);
  assert.match(raw.toString('latin1'), /Content-Type: text\/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\nCaf/);
  assert.deepEqual(jobs[0]!.to, ['carol@ext.test']);
  assert.deepEqual(marks, ['$Forwarded']);
  const parsed = await storage.parseRawMessage(raw);
  assert.ok(parsed.attachments.length >= 1, 'the original travels as an attachment');
});

test('SmartReply: inline original, \\Answered; ReplaceMime → client MIME as is; unknown source → 150', async () => {
  const r = deps();
  assert.equal(status(await handleSendMail(composeReq('SmartReply', MIME, source('orig')), 'u1', 'SmartReply', r.d)), '1');
  assert.match(Buffer.from(r.jobs[0]!.rawMessage, 'base64').toString('latin1'), /Content-Disposition: inline; filename\*=UTF-8''Report\.eml/);
  assert.deepEqual(r.marks, ['\\Answered']);

  const replace = deps();
  assert.equal(status(await handleSendMail(composeReq('SmartReply', MIME, [...source('orig'), 0x09]), 'u1', 'SmartReply', replace.d)), '1');
  assert.ok(Buffer.from(replace.jobs[0]!.rawMessage, 'base64').equals(MIME));
  assert.deepEqual(replace.marks, ['\\Answered']);

  const missing = deps();
  assert.equal(status(await handleSendMail(composeReq('SmartForward', MIME, source('nope')), 'u1', 'SmartForward', missing.d)), '150');
  assert.equal(missing.jobs.length, 0);
});

test('Sent copy: raw message stored, row parsed from it, attachments stored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eas-sent-'));
  (globalThis as Record<string, unknown>)['__objectStore'] = new storage.FilesystemObjectStore(dir);
  try {
    const raw = Buffer.from(ORIGINAL.toString('latin1').replace('From: carol@ext.test', 'From: bob@example.com\r\nBcc: hidden@ext.test'), 'latin1');
    const planned = await (await import('./send-mail-plan.js')).planEasSubmission(raw, { userEmail: 'bob@example.com', allowedSenders: ['bob@example.com'] });
    assert.ok(planned.ok);
    await saveSentCopy('u1', planned.plan);
    const copy = db.tables['message']!.find((m) => m['folderId'] === 'sent')!;
    assert.ok(copy, 'Sent copy created');
    assert.ok(copy['storagePath'], 'raw object referenced');
    assert.equal(copy['subject'], 'Report');
    assert.deepEqual(copy['bccAddrs'], ['hidden@ext.test']);
    assert.ok((await storage.loadRawMessage(copy as never)).equals(planned.plan.raw), 'stored octets = sent octets');
    const atts = db.tables['attachment']!.filter((a) => a['messageId'] === copy['id']);
    assert.deepEqual(atts.map((a) => a['filename']), ['r.pdf']);
  } finally {
    delete (globalThis as Record<string, unknown>)['__objectStore'];
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v8.1: a mailbox over its ProhibitSendQuota gets Status 113 (SendMail/SmartReply), nothing is queued', async () => {
  const h = deps({ sendAllowed: async () => false });
  assert.equal(status(await handleSendMail(composeReq('SendMail', MIME), 'u1', 'SendMail', h.d)), '113');
  assert.equal(status(await handleSendMail(composeReq('SmartReply', MIME, source('orig')), 'u1', 'SmartReply', h.d)), '113');
  assert.equal(h.jobs.length, 0);
  assert.equal(h.sent.length, 0);
  const ok = deps({ sendAllowed: async () => true });
  assert.equal(status(await handleSendMail(composeReq('SendMail', MIME), 'u1', 'SendMail', ok.d)), '1');
  assert.equal(ok.jobs.length, 1);
});
