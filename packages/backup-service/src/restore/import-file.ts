/**
 * Import input: accepts an encrypted backup (`CMBK` header, see
 * crypto/backup-crypto.ts) as well as a legacy plaintext MBOX. Encrypted input
 * is fully decrypted AND authenticated into a temp file before anything is
 * imported — a modified or truncated file imports nothing.
 */
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { decryptFile, isEncrypted, isEncryptedFile, type BackupKeyring } from '../crypto/backup-crypto.js';

export interface PreparedImport {
  /** Plaintext MBOX path inside `dir`. */
  path: string;
  encrypted: boolean;
}

/**
 * 9.3: the same for an upload already on disk (streamed there by the route —
 * the old route buffered up to 500 MB in memory). An encrypted file is
 * decrypted next to it and removed; returns the plaintext path.
 */
export async function prepareUploadedFile(path: string, dir: string, keyring: () => Pick<BackupKeyring, 'keys'>): Promise<PreparedImport> {
  if (!(await isEncryptedFile(path))) return { path, encrypted: false };
  const plainPath = join(dir, 'upload.plain');
  try {
    await decryptFile(path, plainPath, keyring());
  } catch (err) {
    await unlink(plainPath).catch(() => undefined);
    throw err;
  } finally {
    await unlink(path).catch(() => undefined);
  }
  return { path: plainPath, encrypted: true };
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
