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
 *
 * w3 scope leaks: a PUT resolves new grantees only inside the caller's
 * directory (GranteeDirectory) — an unknown, hidden or not grantable address
 * gets the same 400 UNKNOWN_GRANTEE; a scoped admin's view shows grantees of
 * other domains as "(andere Domain)".
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  prisma, GAL_VISIBLE_WHERE, describeFolderPermissions, setFolderPermissions, publishFolderPermissionChange,
  FolderPermissionError, FOLDER_ROLES, ROLE_RIGHTS, ALL_FOLDER_RIGHTS, DEFAULT_GRANTEE_KEY, userGranteeKey,
  type FolderPermissionAuthorizer, type FolderPermissionInput, type FolderPermissionView, type FolderPermissionWriteDb, type PermissionActor,
} from '@coremail/storage';
import { auditContext } from './audit.js';
import { NO_REDACTION, type AddressRedactor } from './admin-scope.js';

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

/** The users a request may name, by lower-case address and by id. */
export interface ResolvableGrantees { byEmail: ReadonlyMap<string, string>; ids: ReadonlySet<string> }

/**
 * Pure: the storage inputs of a PUT body; null when it names a user that is not
 * resolvable for the caller — unknown, or not grantable (w3: every such case
 * gets the same answer, UNKNOWN_GRANTEE).
 */
export function granteeInputs(entries: readonly PermissionRequestEntry[], known: ResolvableGrantees): FolderPermissionInput[] | null {
  const out: FolderPermissionInput[] = [];
  for (const e of entries) {
    let id: string | undefined;
    if (e.grantee === DEFAULT_GRANTEE_KEY) {
      out.push({ granteeKey: DEFAULT_GRANTEE_KEY, rights: e.rights, applyToSubfolders: e.applyToSubfolders });
      continue;
    }
    if ('userId' in e.grantee) id = known.ids.has(e.grantee.userId) ? e.grantee.userId : undefined;
    else id = known.byEmail.get(e.grantee.email.toLowerCase());
    if (!id) return null;
    out.push({ granteeKey: userGranteeKey(id), rights: e.rights, applyToSubfolders: e.applyToSubfolders });
  }
  return out;
}

/**
 * w3 scope leaks: a Prisma `where` on User — whom a caller may name as a NEW
 * grantee. The users the folder's permission view already shows (own and
 * inherited entries), the mailbox owner and the caller stay resolvable; any
 * other address answers exactly like an unknown one, so the PUT reveals neither
 * whether an address exists nor whether it is hidden from the address list.
 */
export type GranteeDirectory = Record<string, unknown>;

/** Webmail callers: the active users of their own domain shown in the address list (the picker's source). */
export async function webmailGranteeDirectory(userId: string): Promise<GranteeDirectory> {
  const caller = await prisma.user.findUnique({ where: { id: userId }, select: { domainId: true } });
  return caller?.domainId ? { domainId: caller.domainId, active: true, ...GAL_VISIBLE_WHERE } : { id: { in: [] } };
}

/** I/O: the users of the body the caller may name (directory, shown entries, owner, caller). */
async function resolvableGrantees(entries: readonly PermissionRequestEntry[], directory: GranteeDirectory, alwaysIds: readonly string[]): Promise<ResolvableGrantees> {
  const named = entries.flatMap((e) => (typeof e.grantee === 'object' ? [e.grantee] : []));
  const emails = named.flatMap((g) => ('email' in g ? [g.email.toLowerCase()] : []));
  const ids = named.flatMap((g) => ('userId' in g ? [g.userId] : []));
  const users = named.length === 0 ? [] : await prisma.user.findMany({
    where: {
      AND: [
        { OR: [{ email: { in: emails } }, { id: { in: ids } }] },
        { OR: [directory, { id: { in: [...alwaysIds] } }] },
      ],
    },
    select: { id: true, email: true },
  });
  return { byEmail: new Map(users.map((u) => [u.email.toLowerCase(), u.id])), ids: new Set(users.map((u) => u.id)) };
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

/** Pure (w3): entries with the grantees of other domains redacted for a scoped admin. */
export function redactEntries<E extends { user: { email: string; displayName: string } | null }>(r: AddressRedactor, entries: E[]): E[] {
  return r.active ? entries.map((e) => (e.user ? { ...e, user: r.person(e.user) } : e)) : entries;
}

const describe = (folder: PermissionFolder) => describeFolderPermissions(prisma as unknown as FolderPermissionWriteDb, folder);

/** GET: the folder's permissions (`redactor`: a scoped admin sees other domains' grantees redacted). */
export async function sendFolderPermissions(res: Response, folder: PermissionFolder, redactor: AddressRedactor = NO_REDACTION): Promise<void> {
  const view = await describe(folder);
  res.json({
    folderId: folder.id,
    folderName: folder.displayName || folder.name,
    entries: withFixedEntries(redactEntries(redactor, view.entries)),
    inherited: redactEntries(redactor, view.inherited),
  });
}

/** How a caller of the PUT is limited (see GranteeDirectory, FolderPermissionAuthorizer, sendFolderPermissions). */
export interface PermissionWriteRules {
  directory: GranteeDirectory;
  authorize?: FolderPermissionAuthorizer;
  redactor?: AddressRedactor;
}

const ERROR_TEXT: Record<string, string> = {
  UNKNOWN_GRANTEE: 'Unbekannter Benutzer',
  OWNER_GRANTEE: 'Der Postfachinhaber hat immer alle Rechte',
  INVALID_RIGHTS: 'Ungültige Berechtigungen',
  TOO_MANY_ENTRIES: 'Zu viele Einträge',
  FORBIDDEN_GRANTEE: 'Nur die Organisationsverwaltung darf sich selbst oder „Standard“ Rechte geben',
  SUBFOLDERS_NOT_ADMINISTERED: 'Keine Berechtigung für die Unterordner dieses Ordners',
};

/** Refusals of the caller's rights (403); every other code is an invalid request (400). */
const FORBIDDEN_CODES: ReadonlySet<string> = new Set(['FORBIDDEN_GRANTEE', 'SUBFOLDERS_NOT_ADMINISTERED']);

/** PUT: replaces the folder's permissions and answers with the new view. */
export async function replaceFolderPermissions(
  req: Request,
  res: Response,
  folder: PermissionFolder,
  mailboxOwnerId: string | null,
  source: PermissionActor['source'],
  rules: PermissionWriteRules,
): Promise<void> {
  const parsed = parsePermissionBody(req.body);
  if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }
  const shown = await describe(folder);
  const alwaysIds = [...shown.entries, ...shown.inherited].flatMap((e) => (e.user ? [e.user.id] : []));
  alwaysIds.push(req.apiUser!.userId, ...(mailboxOwnerId ? [mailboxOwnerId] : []));
  const inputs = granteeInputs(parsed.entries, await resolvableGrantees(parsed.entries, rules.directory, alwaysIds));
  if (!inputs) { res.status(400).json({ error: ERROR_TEXT['UNKNOWN_GRANTEE'], code: 'UNKNOWN_GRANTEE' }); return; }
  const { authorize } = rules;
  const ctx = auditContext(req);
  const actor: PermissionActor = {
    userId: req.apiUser!.userId, email: req.apiUser!.email, source,
    ...(ctx.ipAddress ? { ipAddress: ctx.ipAddress } : {}), ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
  };
  try {
    const changes = await setFolderPermissions(prisma as unknown as FolderPermissionWriteDb, {
      folder: { id: folder.id, mailboxId: folder.mailboxId, name: folder.name }, mailboxOwnerId, inputs, replace: true, actor,
      ...(authorize ? { authorize } : {}),
    });
    await publishFolderPermissionChange(changes, actor.userId);
  } catch (err) {
    if (err instanceof FolderPermissionError) { res.status(FORBIDDEN_CODES.has(err.code) ? 403 : 400).json({ error: ERROR_TEXT[err.code] ?? err.message, code: err.code }); return; }
    throw err;
  }
  await sendFolderPermissions(res, folder, rules.redactor);
}
