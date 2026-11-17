/**
 * Manifest of a CoreMail ZIP mailbox backup (9.3): `coremail-manifest.json`
 * at the archive root. It carries what the .eml files cannot — the exact
 * folder name (the path segment is sanitized for file systems) and the IMAP
 * flags of every message — so a restore puts every message back into its
 * folder with its flags. Archives without a manifest (before 9.3) restore
 * from the paths `mail/<folder>/<uid>.eml` with the flag \Seen. Pure.
 */

export const MANIFEST_NAME = 'coremail-manifest.json';
export const MANIFEST_FORMAT = 'coremail-mailbox-backup';

export interface ManifestMessage {
  /** Entry name in the archive, e.g. `mail/INBOX/12.eml`. */
  path: string;
  /** Exact folder name (index into `folders`). */
  folder: number;
  flags: string[];
  /** Date header of the message (ISO). */
  date: string;
  size: number;
}

export interface BackupManifest {
  format: typeof MANIFEST_FORMAT;
  version: 1;
  createdAt: string;
  userId: string;
  folders: string[];
  messages: ManifestMessage[];
}

/** Collects folder names + message rows while the archive is written. */
export class ManifestBuilder {
  private readonly folders: string[] = [];
  private readonly folderIndex = new Map<string, number>();
  private readonly messages: ManifestMessage[] = [];

  constructor(private readonly userId: string, private readonly createdAt: Date = new Date()) {}

  add(path: string, folder: string, flags: string[], date: Date, size: number): void {
    let idx = this.folderIndex.get(folder);
    if (idx === undefined) {
      idx = this.folders.length;
      this.folders.push(folder);
      this.folderIndex.set(folder, idx);
    }
    const d = Number.isNaN(date.getTime()) ? new Date(0) : date;
    this.messages.push({ path, folder: idx, flags: [...flags], date: d.toISOString(), size });
  }

  build(): BackupManifest {
    return {
      format: MANIFEST_FORMAT,
      version: 1,
      createdAt: this.createdAt.toISOString(),
      userId: this.userId,
      folders: [...this.folders],
      messages: this.messages,
    };
  }
}

export interface ManifestLookup {
  folder: string;
  flags: string[];
}

/**
 * Parses a manifest (tolerant: unknown/invalid rows are ignored) into a map
 * entry path → folder + flags. Null when the JSON is not a CoreMail manifest.
 */
export function parseManifest(json: string): Map<string, ManifestLookup> | null {
  let m: unknown;
  try { m = JSON.parse(json); } catch { return null; }
  if (!m || typeof m !== 'object') return null;
  const o = m as Partial<BackupManifest>;
  if (o.format !== MANIFEST_FORMAT || !Array.isArray(o.folders) || !Array.isArray(o.messages)) return null;
  const folders = o.folders.map((f) => (typeof f === 'string' ? f : null));
  const out = new Map<string, ManifestLookup>();
  for (const row of o.messages) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Partial<ManifestMessage>;
    const folder = typeof r.folder === 'number' ? folders[r.folder] : null;
    if (typeof r.path !== 'string' || !folder) continue;
    const flags = Array.isArray(r.flags) ? r.flags.filter((f): f is string => typeof f === 'string') : [];
    out.set(r.path, { folder, flags });
  }
  return out;
}
