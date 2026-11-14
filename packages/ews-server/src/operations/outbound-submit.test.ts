/**
 * EWS CreateItem send path → smtp-outbound structured job.
 * Run: node --import tsx --test src/operations/outbound-submit.test.ts  (in packages/ews-server)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';
(globalThis as unknown as { __prisma: unknown }).__prisma = { $on: () => undefined };

const { OUTBOUND_QUEUE_NAME, buildEwsOutboundJob, splitEwsBody } = await import('./outbound-submit.js');

const base = { userId: 'u1', email: 'Alice@Firma.de', subject: 'S', bodyText: '', bodyHtml: '<p>x</p>', now: new Date('2026-11-14T10:00:00Z') };

test('queue name is the one the smtp-server worker consumes', () => {
  assert.equal(OUTBOUND_QUEUE_NAME, 'smtp-outbound');
});

test('job: From forced to the authenticated user, envelope = To+Cc+Bcc, Bcc not in headers list', () => {
  const job = buildEwsOutboundJob({ ...base, to: ['Bob@example.com'], cc: ['carol@firma.de', 'bob@example.com'], bcc: ['secret@example.net'] });
  assert.ok(job);
  assert.match(job.messageId, /^ews-/);
  assert.equal(job.from, 'alice@firma.de');
  assert.equal(job.senderUserId, 'u1');
  assert.deepEqual(job.to, ['bob@example.com', 'carol@firma.de', 'secret@example.net']);
  assert.equal(job.message.from, 'alice@firma.de');
  assert.deepEqual(job.message.to, ['bob@example.com']);
  assert.deepEqual(job.message.cc, ['carol@firma.de', 'bob@example.com']);
  assert.deepEqual(job.message.bcc, ['secret@example.net']);
  assert.equal(job.message.html, '<p>x</p>');
  assert.equal(job.message.date, '2026-11-14T10:00:00.000Z');
  assert.match(job.message.messageId, /^<[0-9a-f-]+@firma\.de>$/);
  assert.deepEqual(job.message.attachments, []);
});

test('no recipients → null (caller answers ErrorInvalidRecipients)', () => {
  assert.equal(buildEwsOutboundJob({ ...base, to: [], cc: [' '], bcc: [] }), null);
});

test('splitEwsBody honours BodyType (old code put HTML into bodyText too)', () => {
  assert.deepEqual(splitEwsBody({ _: 'plain', $: { BodyType: 'Text' } }), { bodyText: 'plain', bodyHtml: '' });
  assert.deepEqual(splitEwsBody({ _: '<b>h</b>', $: { BodyType: 'HTML' } }), { bodyText: '', bodyHtml: '<b>h</b>' });
  assert.deepEqual(splitEwsBody({ _: '<i>d</i>' }), { bodyText: '', bodyHtml: '<i>d</i>' });
  assert.deepEqual(splitEwsBody(undefined), { bodyText: '', bodyHtml: '' });
});
