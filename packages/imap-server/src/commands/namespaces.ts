/**
 * v9.1: shared and delegated mailboxes over IMAP (RFC 2342 NAMESPACE, RFC 4314 rights).
 *
 *   personal        ""             delimiter "."   the user's own mailbox (unchanged)
 *   other users     "Other Users/" delimiter "/"   mailboxes delegated to the user (MailboxDelegate)
 *   shared          "Shared/"      delimiter "/"   Shared Mailboxes (FULL_ACCESS / READ_ONLY)
 *
 * A foreign folder is named  <prefix>/<address>/<folder path>, e.g.
 * "Shared/team@example.com/INBOX" or "Other Users/alice@example.com/Archive/2025"
 * (the "." hierarchy of the stored folder name becomes "/"). The address level is
 * not a mailbox (\Noselect). "/" is the delimiter of these namespaces because the
 * addresses contain "." (the personal delimiter); folder names that contain "/"
 * themselves cannot be expressed and are not listed there.
 *
 * Access follows @coremail/storage `listAccessibleMailboxes` (the JMAP/REST policy).
 * It is cached per session for at most IMAP_SHARED_ACCESS_CACHE_MS (≤ 30 s) and
 * re-read without the cache on SELECT/EXAMINE and before every write, so a revoked
 * permission takes effect within 30 s for reads and immediately for writes.
 */
import { prisma, listAccessibleMailboxes, type AccessibleMailbox, type ForeignMailboxKind } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { type ImapSession, sendUntagged } from '../session/state.js';
import { canonicalInbox, decodeMutf7, storedCandidates } from './mailbox-name.js';

const log = createLogger('imap:namespaces');

export const PERSONAL_DELIMITER = '.';
export const FOREIGN_DELIMITER = '/';

/**
 * RFC 4314 §2.1 rights plus the obsolete RFC 2086 "c" and "d" that §2.1.1 asks
 * servers to report for compatibility.
 */
export const OWNER_RIGHTS = 'lrswipkxteacd';
/** FULL_ACCESS: everything except administering the ACL ("a"). */
export const FULL_ACCESS_RIGHTS = 'lrswipkxtecd';
/**
 * READ_ONLY: lookup + read. No "s": the \Seen state cannot be changed either
 * (the mailbox is always opened read-only, like EXAMINE).
 */
export const READ_ONLY_RIGHTS = 'lr';

// ─── Configuration ───────────────────────────────────────────────────────────

export interface NamespaceConfig {
  /** Prefix root of the "Other Users" namespace (delegations), null = disabled. */
  otherUsers: string | null;
  /** Prefix root of the "Shared" namespace (Shared Mailboxes), null = disabled. */
  shared: string | null;
  /** Lifetime of the per-session access cache in ms (0–30000). */
  cacheMs: number;
}

const DISABLED = new Set(['', 'off', 'none', 'false', 'disabled']);
export const DEFAULT_OTHER_USERS_PREFIX = 'Other Users';
export const DEFAULT_SHARED_PREFIX = 'Shared';
export const MAX_ACCESS_CACHE_MS = 30_000;

/**
 * A namespace prefix root from the environment: printable ASCII without the
 * hierarchy delimiters, wildcards, quotes or backslash, not INBOX. A trailing
 * "/" is accepted and dropped. undefined → default, disabled words → null,
 * invalid → default (with a warning).
 */
export function parseNamespacePrefix(value: string | undefined, fallback: string): string | null {
  if (value === undefined) return fallback;
  const v = value.trim().replace(/\/+$/, '');
  if (DISABLED.has(v.toLowerCase())) return null;
  if (v.length > 64 || !/^[\x20-\x7e]+$/.test(v) || /[./%*"\\]/.test(v) || v.toUpperCase() === 'INBOX' || v !== v.trim()) {
    log.warn({ value, fallback }, 'invalid IMAP namespace prefix — using the default');
    return fallback;
  }
  return v;
}

export function loadNamespaceConfig(env: NodeJS.ProcessEnv = process.env): NamespaceConfig {
  const otherUsers = parseNamespacePrefix(env['IMAP_NAMESPACE_OTHER_USERS'], DEFAULT_OTHER_USERS_PREFIX);
  let shared = parseNamespacePrefix(env['IMAP_NAMESPACE_SHARED'], DEFAULT_SHARED_PREFIX);
  if (otherUsers !== null && shared !== null && otherUsers.toLowerCase() === shared.toLowerCase()) {
    log.warn({ otherUsers, shared }, 'IMAP namespace prefixes must differ — Shared namespace disabled');
    shared = null;
  }
  const raw = Number(env['IMAP_SHARED_ACCESS_CACHE_MS'] ?? MAX_ACCESS_CACHE_MS);
  const cacheMs = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 0), MAX_ACCESS_CACHE_MS) : MAX_ACCESS_CACHE_MS;
  return { otherUsers, shared, cacheMs };
}

let config: NamespaceConfig = loadNamespaceConfig();

export function namespaceConfig(): NamespaceConfig {
  return config;
}

/** Replaces the configuration (tests, or a reload). */
export function setNamespaceConfig(next: NamespaceConfig): void {
  config = next;
  invalidateAccessCaches();
}

export function prefixOf(kind: ForeignMailboxKind): string | null {
  return kind === 'shared' ? config.shared : config.otherUsers;
}

/** The untagged NAMESPACE response (RFC 2342 §5). */
export function namespaceResponse(): string {
  const ns = (prefix: string | null): string => (prefix === null ? 'NIL' : `(("${prefix}${FOREIGN_DELIMITER}" "${FOREIGN_DELIMITER}"))`);
  return `NAMESPACE (("" "${PERSONAL_DELIMITER}")) ${ns(config.otherUsers)} ${ns(config.shared)}`;
}

// ─── Access (cached per session, ≤ 30 s) ─────────────────────────────────────

let generation = 0;

/** Drops every session's cached access list (auth invalidation event, tests). */
export function invalidateAccessCaches(): void {
  generation++;
}

/**
 * The foreign mailboxes the session's user may currently open (enabled
 * namespaces only). `fresh` bypasses the cache (SELECT and writes).
 */
export async function foreignMailboxes(session: ImapSession, fresh = false): Promise<AccessibleMailbox[]> {
  if (!session.userId || (config.otherUsers === null && config.shared === null)) return [];
  const cached = session.foreignAccess;
  const now = Date.now();
  if (!fresh && cached && cached.gen === generation && cached.userId === session.userId && now - cached.at < config.cacheMs) {
    return cached.list;
  }
  const gen = generation;
  const all = await listAccessibleMailboxes(prisma as never, session.userId);
  const list = all.filter((a) => prefixOf(a.kind) !== null && !a.email.includes(FOREIGN_DELIMITER));
  session.foreignAccess = { userId: session.userId, at: now, gen, list };
  return list;
}

export function rightsOf(access: AccessibleMailbox | null): string {
  if (!access) return OWNER_RIGHTS;
  return access.readOnly ? READ_ONLY_RIGHTS : FULL_ACCESS_RIGHTS;
}

// ─── Names ───────────────────────────────────────────────────────────────────

/** A decoded mailbox name inside a foreign namespace. */
export interface ForeignName {
  kind: ForeignMailboxKind;
  /** Lower-cased address; '' for the namespace root itself. */
  email: string;
  /**
   * Folder name in the target mailbox's own ("."-delimited) form; null for the
   * namespace root or an address level; undefined when the path is invalid
   * (empty level, a "." inside a level).
   */
  path: string | null | undefined;
}

/** Parses a decoded (UTF-8) name; null when it belongs to the personal namespace. */
export function parseForeignName(name: string): ForeignName | null {
  for (const kind of ['delegated', 'shared'] as const) {
    const prefix = prefixOf(kind);
    if (prefix === null) continue;
    if (name.length < prefix.length + 1 || name.slice(0, prefix.length + 1).toLowerCase() !== `${prefix.toLowerCase()}${FOREIGN_DELIMITER}`) continue;
    const rest = name.slice(prefix.length + 1);
    if (rest === '') return { kind, email: '', path: null };
    const slash = rest.indexOf(FOREIGN_DELIMITER);
    const email = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
    if (slash === -1 || slash === rest.length - 1) return { kind, email, path: null };
    const segments = rest.slice(slash + 1).split(FOREIGN_DELIMITER);
    if (segments.some((s) => s === '' || s.includes(PERSONAL_DELIMITER))) return { kind, email, path: undefined };
    return { kind, email, path: canonicalInbox(segments.join(PERSONAL_DELIMITER)) };
  }
  return null;
}

/**
 * Client name of a folder of a foreign mailbox (decoded form); null when the
 * folder name cannot be expressed (contains "/").
 */
export function foreignClientName(access: Pick<AccessibleMailbox, 'kind' | 'email'>, displayName: string): string | null {
  const prefix = prefixOf(access.kind);
  if (prefix === null || displayName.includes(FOREIGN_DELIMITER)) return null;
  return `${prefix}${FOREIGN_DELIMITER}${access.email}${FOREIGN_DELIMITER}${displayName.split(PERSONAL_DELIMITER).join(FOREIGN_DELIMITER)}`;
}

/** Decodes a client mailbox name (modified UTF-7 for rev1 clients) without INBOX canonicalisation. */
export function decodeClientName(session: ImapSession, raw: string): string {
  return session.imap4rev2Enabled ? raw : (decodeMutf7(raw) ?? raw);
}

/** Stored folder name in `mailboxId` for a (decoded) folder name — UTF-8 row first, then a legacy modified UTF-7 row. */
export async function storedNameIn(mailboxId: string, name: string): Promise<string> {
  const candidates = storedCandidates(name);
  if (candidates.length === 1) return name;
  const rows: Array<{ name: string }> = await prisma.folder.findMany({
    where: { mailboxId, name: { in: candidates } },
    select: { name: true },
  });
  if (rows.some((r) => r.name === name)) return name;
  return rows[0]?.name ?? name;
}

/** A mailbox name resolved to the mailbox (own or foreign) it lives in. */
export interface MailboxTarget {
  mailboxId: string;
  /** Folder name in the target mailbox, as the client means it (decoded, "." hierarchy). */
  folderName: string;
  /** Stored row name to look up (legacy rows resolved). */
  storedName: string;
  /** null = the user's own mailbox. */
  foreign: AccessibleMailbox | null;
  /** Hierarchy delimiter of the name on the wire. */
  delimiter: string;
  rights: string;
  /** Writes (STORE, EXPUNGE, APPEND, COPY/MOVE into, folder changes) are permitted. */
  writable: boolean;
}

export type ResolveResult =
  | { ok: true; target: MailboxTarget }
  /** The name is in a foreign namespace but names no folder the user may open (no oracle). */
  | { ok: false; reason: 'nonexistent' | 'noselect' };

/**
 * Resolves a mailbox name sent by the client. Foreign names resolve only with a
 * current permission; anything else is reported exactly like a missing mailbox.
 */
export async function resolveMailbox(session: ImapSession, raw: string, fresh = false): Promise<ResolveResult> {
  const decoded = decodeClientName(session, raw);
  const foreign = parseForeignName(decoded);
  if (!foreign) {
    if (!session.mailboxId) return { ok: false, reason: 'nonexistent' };
    const folderName = canonicalInbox(decoded);
    return {
      ok: true,
      target: {
        mailboxId: session.mailboxId, folderName, storedName: await storedNameIn(session.mailboxId, folderName),
        foreign: null, delimiter: PERSONAL_DELIMITER, rights: OWNER_RIGHTS, writable: true,
      },
    };
  }
  if (foreign.path === undefined) return { ok: false, reason: 'nonexistent' };
  const access = (await foreignMailboxes(session, fresh)).find((a) => a.kind === foreign.kind && a.email === foreign.email);
  if (!access) return { ok: false, reason: 'nonexistent' };
  if (foreign.path === null) return { ok: false, reason: 'noselect' };
  return {
    ok: true,
    target: {
      mailboxId: access.mailboxId, folderName: foreign.path, storedName: await storedNameIn(access.mailboxId, foreign.path),
      foreign: access, delimiter: FOREIGN_DELIMITER, rights: rightsOf(access), writable: !access.readOnly,
    },
  };
}

/** Resolves a name and loads its folder (with the mailbox row); null when it does not exist / is not accessible. */
export async function findTargetFolder(session: ImapSession, raw: string, fresh = false) {
  const resolved = await resolveMailbox(session, raw, fresh);
  if (!resolved.ok) return null;
  const { target } = resolved;
  const folder = await prisma.folder.findFirst({
    where: { mailboxId: target.mailboxId, name: target.storedName },
    include: { mailbox: true },
  });
  return folder ? { ...folder, target } : null;
}

/** Client (decoded) name of a target folder after a rename etc. */
export function clientNameOf(target: Pick<MailboxTarget, 'foreign'>, folderName: string): string {
  return target.foreign ? (foreignClientName(target.foreign, folderName) ?? folderName) : folderName;
}

// ─── The selected foreign mailbox ────────────────────────────────────────────

/**
 * Re-checks the permission for a selected foreign mailbox. A downgrade to
 * read-only makes the view read-only; a revocation closes the mailbox
 * (`* OK [CLOSED]`, RFC 7162 §3.2.11 / RFC 9051 §7.1) and returns false.
 */
export async function revalidateSelected(session: ImapSession, fresh: boolean): Promise<boolean> {
  const view = session.selected;
  if (!view?.foreign) return true;
  let access: AccessibleMailbox | undefined;
  try {
    access = (await foreignMailboxes(session, fresh)).find((a) => a.mailboxId === view.mailboxId && a.kind === view.foreign!.kind);
  } catch (err) {
    // Fail closed: no access without a successful check.
    log.warn({ err, id: session.id }, 'IMAP: shared mailbox permission check failed');
    access = undefined;
  }
  if (session.selected !== view) return true;
  if (!access) {
    session.selected = null;
    if (session.state === 'SELECTED') session.state = 'AUTHENTICATED';
    sendUntagged(session, 'OK [CLOSED] Access to the selected mailbox was revoked');
    log.info({ id: session.id, mailboxId: view.mailboxId }, 'IMAP: selected shared mailbox closed — permission revoked');
    return false;
  }
  if (access.readOnly && !view.noWrite) {
    view.noWrite = true;
    view.readOnly = true;
  }
  return true;
}

/** Fresh permission check before a write to the selected mailbox (true for the own mailbox). */
export async function selectedWritable(session: ImapSession): Promise<boolean> {
  const view = session.selected;
  if (!view) return false;
  if (!view.foreign) return !view.readOnly;
  if (!(await revalidateSelected(session, true))) return false;
  return session.selected === view && !view.noWrite && !view.readOnly;
}

export const NOPERM = '[NOPERM] Permission denied';
