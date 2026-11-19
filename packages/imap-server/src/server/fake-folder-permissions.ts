/**
 * TEST-ONLY: in-memory FolderPermission + AuditLog models for the IMAP protocol
 * suites (w3 folder permissions) — the queries of storage folder-access.ts:
 * equality, `{ in: [...] }`, `{ not: x }` and `OR`.
 */
export interface FakeFolderPermission {
  folderId: string;
  mailboxId: string;
  granteeKey: string;
  granteeId: string | null;
  rights: number;
  applyToSubfolders: boolean;
  grantedBy?: string;
}

type Row = Record<string, unknown>;

function matches(row: Row, where: Row | undefined): boolean {
  return Object.entries(where ?? {}).every(([key, cond]) => {
    if (key === 'OR') return (cond as Row[]).some((c) => matches(row, c));
    if (cond !== null && typeof cond === 'object') {
      const c = cond as { in?: unknown[]; not?: unknown };
      if ('in' in c) return (c.in ?? []).includes(row[key]);
      if ('not' in c) return row[key] !== c.not;
      throw new Error(`fake folderPermission: unsupported condition on "${key}"`);
    }
    return row[key] === cond;
  });
}

export function fakeFolderPermissionModels(rows: FakeFolderPermission[], audit: Row[]) {
  return {
    folderPermission: {
      findMany: async ({ where }: { where?: Row }) => rows.filter((r) => matches(r as unknown as Row, where)).map((r) => ({ ...r })),
      upsert: async ({ where, create, update }: { where: { folderId_granteeKey: { folderId: string; granteeKey: string } }; create: FakeFolderPermission; update: Partial<FakeFolderPermission> }) => {
        const k = where.folderId_granteeKey;
        const row = rows.find((r) => r.folderId === k.folderId && r.granteeKey === k.granteeKey);
        if (row) Object.assign(row, update); else rows.push({ ...create });
        return {};
      },
      deleteMany: async ({ where }: { where: Row }) => {
        const keep = rows.filter((r) => !matches(r as unknown as Row, where));
        const count = rows.length - keep.length;
        rows.splice(0, rows.length, ...keep);
        return { count };
      },
    },
    auditLog: { create: async ({ data }: { data: Row }) => { audit.push(data); return {}; } },
  };
}

/** A grant row for a folder of `mailboxId`. */
export function grant(folderId: string, mailboxId: string, granteeKey: string, rights: number, applyToSubfolders = false): FakeFolderPermission {
  return { folderId, mailboxId, granteeKey, granteeId: granteeKey.startsWith('user:') ? granteeKey.slice(5) : null, rights, applyToSubfolders };
}
