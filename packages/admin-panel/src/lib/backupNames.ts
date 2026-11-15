/**
 * File names for backup downloads (v8.1). Backups are stored encrypted as
 * `<name>.enc` (BackupJob.downloadUrl / archive key); the download endpoints
 * decrypt on the fly and send the plaintext, so the suggested file name is the
 * key's last segment WITHOUT `.enc`. The server's Content-Disposition name wins
 * when present. No imports — unit-tested with `node --test`.
 */

const ENC = '.enc';

/** Safe file name (no path, quotes or control characters). */
function clean(name: string): string {
  return name.replace(/["\\/\r\n\u0000-\u001f]/g, '_').trim();
}

/** Suggested name for a backup key / downloadUrl (`mailbox/u1/123.zip.enc` → `123.zip`). */
export function backupFileName(keyOrUrl: string | null | undefined, fallback = 'backup.bin'): string {
  const last = (keyOrUrl ?? '').split('?')[0]!.split('/').pop() ?? '';
  const base = last.endsWith(ENC) ? last.slice(0, -ENC.length) : last;
  return clean(base) || fallback;
}

/** File name from a Content-Disposition header (filename*= or filename=), or null. */
export function contentDispositionName(header: string | null | undefined): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star) {
    try { return clean(decodeURIComponent(star[1]!.trim())) || null; } catch { /* fall through */ }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/.exec(header);
  return plain ? clean(plain[1]!) || null : null;
}
