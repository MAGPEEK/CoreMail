/**
 * w3: the REST view and update of one folder's permissions — shared by
 *
 *   GET|PUT /api/v1/mail/folders/:folderId/permissions                 own folders
 *   GET|PUT /api/v1/mail/{shared,delegated}-mailboxes/:id/folders/:folderId/permissions
 *                                               foreign folders with the "folder owner" right
 *   GET|PUT /api/v1/admin/mailboxes/:id/folders/:folderId/permissions          (admin)
 *   GET|PUT /api/v1/admin/shared-mailboxes/:id/folders/:folderId/permissions   (admin)
 *
 * GET answers `{ folderId, folderName, entries, inherited }`: `entries` always
 * starts with Default and Anonymous (Anonymous fixed to none — never for
 * mail), then one entry per user. PUT takes the complete list
 * `{ entries: [{ grantee, role? | rights?, applyToSubfolders? }] }` with
 * grantee "default" | "anonymous" | { userId } | { email } (absent users are
 * removed) and answers with the new view. Storage folder-access.ts validates,
 * writes and audits (`mailbox.folder.permission.set|remove`); the grantees get
 * `permission-change` (live IMAP sessions re-check at once).
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  prisma, describeFolderPermissions, setFolderPermissions, publishFolderPermissionChange,
  FolderPermissionError, FOLDER_ROLES, ROLE_RIGHTS, ALL_FOLDER_RIGHTS, DEFAULT_GRANTEE_KEY, userGranteeKey,
  type FolderPermissionInput, type FolderPermissionView, type FolderPermissionWriteDb, type PermissionActor,
} from '@coremail/storage';
import { auditContext } from './audit.js';

export const ANONYMOUS_GRANTEE = 'anonymous';

const Grantee = z.union([
  z.literal(DEFAULT_GRANTEE_KEY),
  z.literal(ANONYMOUS_GRANTEE),
  z.object({ userId: z.string().min(1).max(64) }).strict(),
  z.object({ email: z.string().trim().min(3).max(320) }).strict(),
]);

const Entry = z.object({
  grantee: Grantee,
  role: z.enum(FOLDER_ROLES).optional(),
  rights: z.number().int().min(0).max(ALL_FOLDER_RIGHTS).optional(),
  applyToSubfolders: z.boolean().optional(),
}).strict();

const Body = z.object({ entries: z.array(Entry).max(200) }).strict();

type ParsedEntry = z.infer<typeof Entry>;
export type PermissionRequestEntry =
  | { grantee: 'default'; rights: number; applyToSubfolders: boolean }
  | { grantee: { userId: string } | { email: string }; rights: number; applyToSubfolders: boolean };

/**
 * Pure: validates a PUT body. A role wins over `rights`; Anonymous may only be
 * "none" and is dropped; a grantee named twice is refused.
 */
export function parsePermissionBody(body: unknown): { ok: true; entries: PermissionRequestEntry[] } | { ok: false; error: string } {
  const p = Body.safeParse(body ?? {});
  if (!p.success) return { ok: false, error: 'Ungültige Berechtigungen' };
  const seen = new Set<string>();
  const out: PermissionRequestEntry[] = [];
  for (const e of p.data.entries as ParsedEntry[]) {
    if (e.role === undefined && e.rights === undefined) return { ok: false, error: 'Rolle oder Rechte fehlen' };
    const rights = e.role !== undefined ? ROLE_RIGHTS[e.role] : (e.rights as number);
    const key = typeof e.grantee === 'string' ? e.grantee : 'userId' in e.grantee ? `id:${e.grantee.userId}` : `mail:${e.grantee.email.toLowerCase()}`;
    if (seen.has(key)) return { ok: false, error: 'Ein Empfänger ist doppelt aufgeführt' };
    seen.add(key);
    if (e.grantee === ANONYMOUS_GRANTEE) {
      if (rights !== 0) return { ok: false, error: 'Anonym kann für E-Mail-Ordner keine Rechte erhalten' };
      continue;
    }
    out.push({ grantee: e.grantee, rights, applyToSubfolders: e.applyToSubfolders ?? false } as PermissionRequestEntry);
  }
  return { ok: true, entries: out };
}

/** Resolves e-mail grantees to users; null when one is unknown. */
async function storageInputs(entries: PermissionRequestEntry[]): Promise<FolderPermissionInput[] | null> {
  const emails = entries.flatMap((e) => (typeof e.grantee === 'object' && 'email' in e.grantee ? [e.grantee.email.toLowerCase()] : []));
  const users = emails.length
    ? await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true, email: true } })
    : [];
  const byEmail = new Map(users.map((u) => [u.email.toLowerCase(), u.id]));
  const out: FolderPermissionInput[] = [];
  for (const e of entries) {
    let key: string;
    if (e.grantee === DEFAULT_GRANTEE_KEY) key = DEFAULT_GRANTEE_KEY;
    else if ('userId' in e.grantee) key = userGranteeKey(e.grantee.userId);
    else {
      const id = byEmail.get(e.grantee.email.toLowerCase());
      if (!id) return null;
      key = userGranteeKey(id);
    }
    out.push({ granteeKey: key, rights: e.rights, applyToSubfolders: e.applyToSubfolders });
  }
  return out;
}

export interface PermissionFolder { id: string; mailboxId: string; name: string; displayName: string }

/** Pure: Default (always present) and Anonymous (fixed none) first, then the users. */
export function withFixedEntries(entries: FolderPermissionView[]) {
  const def = entries.find((e) => e.granteeKey === DEFAULT_GRANTEE_KEY)
    ?? { granteeKey: DEFAULT_GRANTEE_KEY, user: null, rights: 0, role: 'none' as const, applyToSubfolders: false };
  return [
    def,
    { granteeKey: ANONYMOUS_GRANTEE, user: null, rights: 0, role: 'none' as const, applyToSubfolders: false, fixed: true },
    ...entries.filter((e) => e.granteeKey !== DEFAULT_GRANTEE_KEY),
  ];
}

/** GET: the folder's permissions. */
export async function sendFolderPermissions(res: Response, folder: PermissionFolder): Promise<void> {
  const view = await describeFolderPermissions(prisma as unknown as FolderPermissionWriteDb, folder);
  res.json({ folderId: folder.id, folderName: folder.displayName || folder.name, entries: withFixedEntries(view.entries), inherited: view.inherited });
}

const ERROR_TEXT: Record<string, string> = {
  UNKNOWN_GRANTEE: 'Unbekannter Benutzer',
  OWNER_GRANTEE: 'Der Postfachinhaber hat immer alle Rechte',
  INVALID_RIGHTS: 'Ungültige Berechtigungen',
  TOO_MANY_ENTRIES: 'Zu viele Einträge',
};

/** PUT: replaces the folder's permissions and answers with the new view. */
export async function replaceFolderPermissions(
  req: Request,
  res: Response,
  folder: PermissionFolder,
  mailboxOwnerId: string | null,
  source: PermissionActor['source'],
): Promise<void> {
  const parsed = parsePermissionBody(req.body);
  if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }
  const inputs = await storageInputs(parsed.entries);
  if (!inputs) { res.status(400).json({ error: ERROR_TEXT['UNKNOWN_GRANTEE'], code: 'UNKNOWN_GRANTEE' }); return; }
  const ctx = auditContext(req);
  const actor: PermissionActor = {
    userId: req.apiUser!.userId, email: req.apiUser!.email, source,
    ...(ctx.ipAddress ? { ipAddress: ctx.ipAddress } : {}), ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
  };
  try {
    const changes = await setFolderPermissions(prisma as unknown as FolderPermissionWriteDb, {
      folder: { id: folder.id, mailboxId: folder.mailboxId, name: folder.name }, mailboxOwnerId, inputs, replace: true, actor,
    });
    await publishFolderPermissionChange(changes, actor.userId);
  } catch (err) {
    if (err instanceof FolderPermissionError) { res.status(400).json({ error: ERROR_TEXT[err.code] ?? err.message, code: err.code }); return; }
    throw err;
  }
  await sendFolderPermissions(res, folder);
}
