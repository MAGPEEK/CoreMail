/**
 * Import input (8.0.1): accepts an encrypted backup (`CMBK` header, see
 * crypto/backup-crypto.ts) as well as a legacy plaintext MBOX. Encrypted input
 * is fully decrypted AND authenticated into a temp file before anything is
 * imported — a modified or truncated file imports nothing.
 */
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { decryptFile, isEncrypted, type BackupKeyring } from '../crypto/backup-crypto.js';

export interface PreparedImport {
  /** Plaintext MBOX path inside `dir`. */
  path: string;
  encrypted: boolean;
}

export async function prepareImportFile(body: Buffer, dir: string, keyring: () => Pick<BackupKeyring, 'keys'>): Promise<PreparedImport> {
  const plainPath = join(dir, 'import.mbox');
  if (!isEncrypted(body)) {
    await writeFile(plainPath, body, { mode: 0o600 });
    return { path: plainPath, encrypted: false };
  }
  const encPath = join(dir, 'import.mbox.enc');
  await writeFile(encPath, body, { mode: 0o600 });
  try {
    await decryptFile(encPath, plainPath, keyring());
  } catch (err) {
    await unlink(plainPath).catch(() => undefined);
    throw err;
  } finally {
    await unlink(encPath).catch(() => undefined);
  }
  return { path: plainPath, encrypted: true };
}
