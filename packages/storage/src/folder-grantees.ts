/**
 * Who a caller may name as a NEW grantee of a folder permission — one rule for
 * the REST PUT (api-gateway lib/folder-permissions-api.ts) and IMAP SETACL /
 * DELETEACL (imap-server commands/acl.ts).
 *
 * w3 scope leaks: a grantee lookup must not be an address oracle. A caller
 * resolves new grantees only inside its directory (webmail / IMAP: the active
 * users of its own domain shown in the address list; admins: the users of their
 * scope); the users the folder's permission view already shows, the mailbox
 * owner and the caller stay resolvable. Every other identifier — unknown,
 * hidden from the address list, deactivated or of another domain — gets the
 * same answer from the caller, after the same single query.
 *
 * Database access is injected (`db`, the Prisma client or a test fake), like
 * folder-access.ts; no other runtime imports than the pure gal-visible.ts.
 */
import { GAL_VISIBLE_WHERE } from './gal-visible.js';

/** A Prisma `where` on User: the users a caller may name as new grantees. */
export type GranteeDirectory = Record<string, unknown>;

/** A directory that contains nobody (a caller without a domain). */
export const EMPTY_GRANTEE_DIRECTORY: GranteeDirectory = Object.freeze({ id: { in: [] } });

/** The users a request may name, by lower-case address and by id. */
export interface ResolvableGrantees { byEmail: ReadonlyMap<string, string>; ids: ReadonlySet<string> }

/** The identifiers a request names (addresses are compared trimmed and lower-cased). */
export interface NamedGrantees { emails: readonly string[]; ids: readonly string[] }

/** The part of the Prisma client the grantee lookup needs. */
export interface GranteeDb {
  user: {
    findUnique(args: { where: { id: string }; select: { domainId: true } }): Promise<{ domainId: string | null } | null>;
    findMany(args: { where: Record<string, unknown>; select: { id: true; email: true } }): Promise<Array<{ id: string; email: string }>>;
  };
}

/** Webmail / IMAP callers: the active users of their own domain shown in the address list (the picker's source). */
export async function webmailGranteeDirectory(db: GranteeDb, userId: string): Promise<GranteeDirectory> {
  const caller = userId ? await db.user.findUnique({ where: { id: userId }, select: { domainId: true } }) : null;
  return caller?.domainId ? { domainId: caller.domainId, active: true, ...GAL_VISIBLE_WHERE } : EMPTY_GRANTEE_DIRECTORY;
}

type ShownEntry = { user: { id: string } | null };

/** Pure: the user ids a folder's permission view shows (own and inherited entries). */
export function shownGranteeIds(view: { entries: readonly ShownEntry[]; inherited: readonly ShownEntry[] }): string[] {
  return [...view.entries, ...view.inherited].flatMap((e) => (e.user ? [e.user.id] : []));
}

/**
 * I/O: the named users the caller may name — inside `directory` or one of
 * `alwaysIds` (shown entries, mailbox owner, caller). One query whatever the
 * identifiers are; nothing named → no query.
 */
export async function resolvableGrantees(
  db: GranteeDb, named: NamedGrantees, directory: GranteeDirectory, alwaysIds: readonly string[],
): Promise<ResolvableGrantees> {
  const emails = [...new Set(named.emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  const ids = [...new Set(named.ids.filter(Boolean))];
  if (emails.length === 0 && ids.length === 0) return { byEmail: new Map(), ids: new Set() };
  const users = await db.user.findMany({
    where: {
      AND: [
        { OR: [{ email: { in: emails } }, { id: { in: ids } }] },
        { OR: [directory, { id: { in: [...new Set(alwaysIds)] } }] },
      ],
    },
    select: { id: true, email: true },
  });
  return { byEmail: new Map(users.map((u) => [u.email.toLowerCase(), u.id])), ids: new Set(users.map((u) => u.id)) };
}
