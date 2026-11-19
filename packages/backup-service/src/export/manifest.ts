/**
 * Manifest of a CoreMail ZIP mailbox backup (9.3): `coremail-manifest.json`
 * at the archive root. It carries what the .eml / .vcf files cannot — the exact
 * folder name (the path segment is sanitized for file systems), the IMAP
 * flags and (9.5) the internal (received) date of every message, and (9.5) the
 * display names of the plain-address members of every contact group (a vCard
 * MEMBER carries no name) — so a restore puts everything back as it was.
 * Archives without a manifest (before 9.3) restore from the paths
 * `mail/<folder>/<uid>.eml` with the flag \Seen. Additions stay optional, so
 * the format version stays 1. Pure.
 */
import type { ContactGroupMember } from '@coremail/storage';

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
  /** 9.5: internal date (when the message arrived in the mailbox, ISO); absent before 9.5. */
  internalDate?: string;
  size: number;
}

/** 9.5: one contact group of the archive (`contacts/<id>.vcf`). */
export interface ManifestContactGroup {
  path: string;
  /** Plain-address members with their display name. */
  memberNames: Array<{ address: string; name: string }>;
}

export interface BackupManifest {
  format: typeof MANIFEST_FORMAT;
  version: 1;
  createdAt: string;
  userId: string;
  folders: string[];
  messages: ManifestMessage[];
  contactGroups?: ManifestContactGroup[];
}

const iso = (d: Date): string => (Number.isNaN(d.getTime()) ? new Date(0) : d).toISOString();

/** Collects folder names, message rows and contact groups while the archive is written. */
export class ManifestBuilder {
  private readonly folders: string[] = [];
  private readonly folderIndex = new Map<string, number>();
  private readonly messages: ManifestMessage[] = [];
  private readonly contactGroups: ManifestContactGroup[] = [];

  constructor(private readonly userId: string, private readonly createdAt: Date = new Date()) {}

  add(path: string, folder: string, flags: string[], date: Date, size: number, internalDate?: Date): void {
    let idx = this.folderIndex.get(folder);
    if (idx === undefined) {
      idx = this.folders.length;
      this.folders.push(folder);
      this.folderIndex.set(folder, idx);
    }
    this.messages.push({
      path, folder: idx, flags: [...flags], date: iso(date),
      ...(internalDate && !Number.isNaN(internalDate.getTime()) ? { internalDate: internalDate.toISOString() } : {}),
      size,
    });
  }

  /** Records a contact group entry; only named address members need to be kept. */
  addContactGroup(path: string, members: readonly ContactGroupMember[]): void {
    const memberNames = members.flatMap((m) => (m.kind === 'address' && m.name ? [{ address: m.address, name: m.name }] : []));
    if (memberNames.length) this.contactGroups.push({ path, memberNames });
  }

  build(): BackupManifest {
    return {
      format: MANIFEST_FORMAT,
      version: 1,
      createdAt: this.createdAt.toISOString(),
      userId: this.userId,
      folders: [...this.folders],
      messages: this.messages,
      ...(this.contactGroups.length ? { contactGroups: this.contactGroups } : {}),
    };
  }
}

export interface ManifestLookup {
  folder: string;
  flags: string[];
  /** 9.5: internal date from the archive; null when the manifest has none (or it is invalid). */
  internalDate: Date | null;
}

/** The manifest object, or null when the JSON is not a CoreMail manifest. */
function manifestObject(json: string): (Partial<BackupManifest> & Pick<BackupManifest, 'folders' | 'messages'>) | null {
  let m: unknown;
  try { m = JSON.parse(json); } catch { return null; }
  if (!m || typeof m !== 'object') return null;
  const o = m as Partial<BackupManifest>;
  if (o.format !== MANIFEST_FORMAT || !Array.isArray(o.folders) || !Array.isArray(o.messages)) return null;
  return o as Partial<BackupManifest> & Pick<BackupManifest, 'folders' | 'messages'>;
}

function validDate(v: unknown): Date | null {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Parses a manifest (tolerant: unknown/invalid rows are ignored) into a map
 * entry path → folder + flags + internal date. Null when the JSON is not a CoreMail manifest.
 */
export function parseManifest(json: string): Map<string, ManifestLookup> | null {
  const o = manifestObject(json);
  if (!o) return null;
  const folders = o.folders.map((f) => (typeof f === 'string' ? f : null));
  const out = new Map<string, ManifestLookup>();
  for (const row of o.messages) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Partial<ManifestMessage>;
    const folder = typeof r.folder === 'number' ? folders[r.folder] : null;
    if (typeof r.path !== 'string' || !folder) continue;
    const flags = Array.isArray(r.flags) ? r.flags.filter((f): f is string => typeof f === 'string') : [];
    out.set(r.path, { folder, flags, internalDate: validDate(r.internalDate) });
  }
  return out;
}

/** Max. length of a member display name taken from an archive. */
const MAX_MEMBER_NAME = 200;

/** A member name from an archive: no control characters, length-capped. */
function cleanMemberName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_MEMBER_NAME);
}

/** 9.5: entry path → named address members of each contact group (empty map for older manifests). */
export function parseManifestContactGroups(json: string): Map<string, ContactGroupMember[]> {
  const out = new Map<string, ContactGroupMember[]>();
  const groups: unknown = manifestObject(json)?.contactGroups;
  if (!Array.isArray(groups)) return out;
  for (const g of groups as Array<Partial<ManifestContactGroup> | null>) {
    if (!g || typeof g !== 'object' || typeof g.path !== 'string' || !Array.isArray(g.memberNames)) continue;
    out.set(g.path, g.memberNames.flatMap((m): ContactGroupMember[] => (
      m && typeof m.address === 'string' && typeof m.name === 'string'
        ? [{ kind: 'address', address: m.address, name: cleanMemberName(m.name) }]
        : []
    )));
  }
  return out;
}
