/**
 * 9.5: internal date of restored messages (archive date → Received → Date →
 * now), the mbox separator date and the manifest additions (internal dates,
 * contact group member names). Pure.
 * Run: node --import tsx --test src/restore/internal-date.test.ts  (in packages/backup-service)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['DATABASE_URL'] ??= 'postgresql://test:test@localhost:5432/coremail_test';
process.env['JWT_SECRET'] ??= 'test-jwt-secret-0123456789abcdef0123456789';
process.env['PEPPER'] ??= 'test-pepper-0123456789abcdef0123456789abcd';
// @coremail/storage is imported for its pure header parser — no database
(globalThis as Record<string, unknown>)['__prisma'] = { $on: () => undefined };

const { restoredInternalDate, headerDates, parseHeaderDate } = await import('./internal-date.js');
const { separatorLineDate } = await import('./mbox-reader.js');
const { mboxDate } = await import('../export/mbox.js');
const { ManifestBuilder, parseManifest, parseManifestContactGroups } = await import('../export/manifest.js');

const NOW = new Date('2026-11-19T12:00:00Z');
const raw = (...lines: string[]) => Buffer.from(`${lines.join('\r\n')}\r\n`, 'latin1');
const MSG = raw(
  'Received: from mx.example.test (mx.example.test [192.0.2.1])', '\tby mail.example.test; Tue, 3 Nov 2026 10:00:05 +0100 (CET)',
  'Received: from client; Tue, 3 Nov 2026 09:59:00 +0100',
  'Date: Tue, 03 Nov 2026 09:58:00 +0100', 'Subject: x', '', 'Received: not a header; Mon, 1 Jan 2001 00:00:00 +0000',
);

test('order: archive date first, then the topmost Received header, then Date, then now', () => {
  const archive = new Date('2026-10-01T08:00:00Z');
  assert.equal(restoredInternalDate(archive, MSG, NOW).toISOString(), archive.toISOString());
  assert.equal(restoredInternalDate(null, MSG, NOW).toISOString(), '2026-11-03T09:00:05.000Z', 'topmost Received (folded), comment ignored');
  const noReceived = raw('Date: Tue, 03 Nov 2026 09:58:00 +0100', '', 'body');
  assert.equal(restoredInternalDate(null, noReceived, NOW).toISOString(), '2026-11-03T08:58:00.000Z');
  assert.equal(restoredInternalDate(null, raw('Subject: none', '', 'b'), NOW).getTime(), NOW.getTime());
});

test('unusable dates are skipped: invalid, before 1970, far in the future', () => {
  assert.equal(restoredInternalDate(new Date(NaN), MSG, NOW).toISOString(), '2026-11-03T09:00:05.000Z');
  assert.equal(restoredInternalDate(new Date(0), MSG, NOW).toISOString(), '2026-11-03T09:00:05.000Z');
  const future = raw('Received: by x; Sat, 1 Jan 2050 00:00:00 +0000', 'Date: garbage', '', 'b');
  assert.equal(restoredInternalDate(null, future, NOW).getTime(), NOW.getTime());
  assert.equal(parseHeaderDate(''), null);
  assert.deepEqual(headerDates(raw('Received: no date here', '', 'b')), { received: null, date: null });
});

test('mbox separator line: asctime date (UTC) round trip; foreign / broken lines → null', () => {
  const d = new Date('2026-02-03T10:20:30Z');
  assert.equal(separatorLineDate(`From alice@x.test ${mboxDate(d)}\r\n`)?.toISOString(), d.toISOString());
  assert.equal(separatorLineDate(`From alice@x.test ${mboxDate(d)} cm-noeol\r\n`)?.toISOString(), d.toISOString());
  assert.equal(separatorLineDate('From - Tue Nov  3 09:00:00 2026\n')?.toISOString(), '2026-11-03T09:00:00.000Z', 'Thunderbird form');
  assert.equal(separatorLineDate('From x Tue Feb 31 10:00:00 2026\n'), null);
  assert.equal(separatorLineDate('From x yesterday\n'), null);
});

test('manifest: internal dates and contact group member names round trip; older manifests parse', () => {
  const b = new ManifestBuilder('u1', new Date('2026-11-19T00:00:00Z'));
  b.add('mail/INBOX/1.eml', 'INBOX', ['\\Seen'], new Date('2026-11-01T00:00:00Z'), 10, new Date('2026-11-01T00:05:00Z'));
  b.add('mail/INBOX/2.eml', 'INBOX', [], new Date('2026-11-02T00:00:00Z'), 10);
  b.addContactGroup('contacts/g1.vcf', [{ kind: 'card', uid: 'a' }, { kind: 'address', address: 'info@x.test', name: 'Info' }, { kind: 'address', address: 'n@x.test', name: '' }]);
  b.addContactGroup('contacts/g2.vcf', [{ kind: 'card', uid: 'a' }]);
  const json = JSON.stringify(b.build());
  const m = parseManifest(json)!;
  assert.equal(m.get('mail/INBOX/1.eml')!.internalDate?.toISOString(), '2026-11-01T00:05:00.000Z');
  assert.equal(m.get('mail/INBOX/2.eml')!.internalDate, null);
  const groups = parseManifestContactGroups(json);
  assert.deepEqual([...groups.keys()], ['contacts/g1.vcf'], 'groups without named address members are not recorded');
  assert.deepEqual(groups.get('contacts/g1.vcf'), [{ kind: 'address', address: 'info@x.test', name: 'Info' }]);
  // pre-9.5 manifest: no internalDate, no contactGroups
  const old = JSON.stringify({ format: 'coremail-mailbox-backup', version: 1, folders: ['INBOX'], messages: [{ path: 'p', folder: 0, flags: [] }] });
  assert.equal(parseManifest(old)!.get('p')!.internalDate, null);
  assert.equal(parseManifestContactGroups(old).size, 0);
  // names from an archive are cleaned
  const evil = JSON.stringify({ format: 'coremail-mailbox-backup', version: 1, folders: [], messages: [], contactGroups: [{ path: 'g', memberNames: [{ address: 'a@x.test', name: 'A\u0000\r\nB' }, { address: 1 }] }] });
  assert.deepEqual(parseManifestContactGroups(evil).get('g'), [{ kind: 'address', address: 'a@x.test', name: 'AB' }]);
});
