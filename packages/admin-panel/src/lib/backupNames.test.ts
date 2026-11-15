import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backupFileName, contentDispositionName } from './backupNames.ts';

test('backup download names: .enc keys → decrypted plaintext name', () => {
  assert.equal(backupFileName('mailbox/u1/1700000000000.zip.enc'), '1700000000000.zip');
  assert.equal(backupFileName('full/2026-11-15.mbox.enc'), '2026-11-15.mbox');
  assert.equal(backupFileName('legacy/old.zip'), 'old.zip', 'pre-8.1 plaintext objects unchanged');
  assert.equal(backupFileName(null, 'backup-abc.bin'), 'backup-abc.bin');
  assert.equal(backupFileName('x/.enc', 'fb.bin'), 'fb.bin');
  assert.equal(backupFileName('a/b"c.zip.enc?sig=1'), 'b_c.zip');
});

test('Content-Disposition file name parsing', () => {
  assert.equal(contentDispositionName('attachment; filename="1700.zip"'), '1700.zip');
  assert.equal(contentDispositionName("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.mbox"), 'résumé.mbox');
  assert.equal(contentDispositionName('attachment'), null);
  assert.equal(contentDispositionName(null), null);
  assert.equal(contentDispositionName('attachment; filename="../../etc/passwd"'), '.._.._etc_passwd');
});
