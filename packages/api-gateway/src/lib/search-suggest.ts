/**
 * 10.2: search suggestions while typing (GET /api/v1/mail/search/suggest?q= and the
 * same route of a shared / delegated mailbox, routes/foreign-mailbox.ts).
 *
 *   { people:   [{ name, address }]                                      ≤ 4
 *     messages: [{ id, folderId, folderName, subject, fromName, fromAddr, date }] ≤ 6 }
 *
 * - The query is matched literally as one substring (no operators — the webmail asks
 *   only for plain words), case-insensitive, 2–100 characters.
 * - Messages: subject / sender name / sender address of the live messages in the
 *   folders the caller may read, newest first. Never bodies. The trigram GIN index
 *   `messages_search_trgm_idx` (pg_trgm, schema.prisma) serves these ILIKE '%…%'
 *   conditions — docs/search.md has the plan and the measured cost.
 * - People: senders of those messages (newest first), recipients of the newest
 *   messages of the readable Sent folder, and the caller's own contacts (when the
 *   contacts module is on) — de-duplicated by address, word-start matches first.
 * - Every query is bounded (`take` / LIMIT); the folder scope is computed by the
 *   caller (own mailbox: all folders; foreign mailbox: canReadFolder, as /search).
 */
import type { FolderRef } from './search-query.js';

export const SUGGEST_MIN_LENGTH = 2;
export const SUGGEST_MAX_LENGTH = 100;
export const MAX_PEOPLE = 4;
export const MAX_MESSAGES = 6;
/** Sender rows (newest matching messages) read for the people group. */
export const SENDER_SCAN = 40;
/** Newest Sent messages whose recipients are matched (bounded index scan). */
export const RECIPIENT_WINDOW = 2000;
/** Distinct recipient addresses read from that window. */
export const RECIPIENT_SCAN = 20;
/** Own contacts read for the people group. */
export const CONTACT_SCAN = 10;
const MAX_NAME = 200;
const MAX_ADDRESS = 320;

export interface PersonSuggestion { name: string; address: string }
export interface MessageSuggestion {
  id: string;
  folderId: string;
  folderName: string;
  subject: string;
  fromName: string;
  fromAddr: string;
  date: string;
}
export interface Suggestions { people: PersonSuggestion[]; messages: MessageSuggestion[] }

export const EMPTY_SUGGESTIONS: Suggestions = Object.freeze({ people: [], messages: [] }) as Suggestions;

/**
 * The query to suggest for, or null (too short, not a single string). Control
 * characters become spaces, runs of whitespace one space; capped at 100 characters.
 */
export function normalizeSuggestQuery(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const q = [...raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()]
    .slice(0, SUGGEST_MAX_LENGTH).join('').trim();
  return [...q].length >= SUGGEST_MIN_LENGTH ? q : null;
}

/**
 * The LIKE wildcards (% _) and the escape character (\) of q escaped. Prisma 5
 * passes `contains` into ILIKE '%…%' WITHOUT escaping them (verified against
 * PostgreSQL 16), so a typed "_" or "%" would otherwise match any character(s).
 */
export function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const ci = (value: string) => ({ contains: escapeLike(value), mode: 'insensitive' as const });

/** Prisma where: live messages in the folders whose subject or sender contains q. */
export function suggestMessageWhere(folderIds: string[], q: string): Record<string, unknown> {
  return {
    folderId: { in: folderIds },
    deletedAt: null,
    OR: [{ subject: ci(q) }, { fromName: ci(q) }, { fromAddr: ci(q) }],
  };
}

/** Prisma where: live messages in the folders whose sender contains q. */
export function suggestSenderWhere(folderIds: string[], q: string): Record<string, unknown> {
  return {
    folderId: { in: folderIds },
    deletedAt: null,
    OR: [{ fromName: ci(q) }, { fromAddr: ci(q) }],
  };
}

/** Prisma where: the caller's contacts whose name or e-mail contains q. */
export function suggestContactWhere(userId: string, q: string): Record<string, unknown> {
  return { userId, OR: [{ displayName: ci(q) }, { email: ci(q) }, { email2: ci(q) }] };
}

export const SUGGEST_MESSAGE_SELECT = {
  id: true, folderId: true, subject: true, fromName: true, fromAddr: true, date: true,
} as const;

/** ILIKE pattern "%q%" with the LIKE wildcards and the escape character escaped. */
export function likeContains(q: string): string {
  return `%${escapeLike(q)}%`;
}

/** A plausible single mailbox address (no display name, no whitespace). */
function cleanAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const a = value.trim();
  if (!a || a.length > MAX_ADDRESS || /\s/.test(a) || !/^[^@]+@[^@]+$/.test(a)) return null;
  return a;
}

function cleanName(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) : '';
}

/** True when q starts the name, a word of the name, the address or a part of its local part / domain. */
export function wordStartMatch(p: PersonSuggestion, q: string): boolean {
  const needle = q.toLowerCase();
  const parts = [
    p.address.toLowerCase(),
    ...p.address.toLowerCase().split(/[.@_+-]/),
    p.name.toLowerCase(),
    ...p.name.toLowerCase().split(/[\s,.()"'-]+/),
  ];
  return parts.some((s) => s.length > 0 && s.startsWith(needle));
}

/**
 * People from all sources in priority order: de-duplicated by lower-case address
 * (the first entry wins, a later one only fills a missing name), entries that
 * match at a word start before those matching inside a word, then `limit`.
 */
export function mergePeople(
  candidates: Array<{ name?: unknown; address?: unknown }>,
  q: string,
  limit = MAX_PEOPLE,
): PersonSuggestion[] {
  const byAddress = new Map<string, PersonSuggestion>();
  for (const c of candidates) {
    const address = cleanAddress(c.address);
    if (!address) continue;
    const key = address.toLowerCase();
    const name = cleanName(c.name);
    const seen = byAddress.get(key);
    if (seen) { if (!seen.name && name) seen.name = name; continue; }
    byAddress.set(key, { name, address });
  }
  const all = [...byAddress.values()];
  const first = all.filter((p) => wordStartMatch(p, q));
  const rest = all.filter((p) => !wordStartMatch(p, q));
  return [...first, ...rest].slice(0, limit);
}

/** Message rows → suggestions with the folder's display name. */
export function toMessageSuggestions(
  rows: Array<{ id: string; folderId: string; subject: string | null; fromName: string | null; fromAddr: string | null; date: Date | string }>,
  folders: FolderRef[],
): MessageSuggestion[] {
  const names = new Map(folders.map((f) => [f.id, f.displayName || f.name]));
  return rows.map((m) => ({
    id: m.id,
    folderId: m.folderId,
    folderName: names.get(m.folderId) ?? '',
    subject: m.subject ?? '',
    fromName: m.fromName ?? '',
    fromAddr: m.fromAddr ?? '',
    date: (m.date instanceof Date ? m.date : new Date(m.date)).toISOString(),
  }));
}

/**
 * The addresses a matching contact suggests: those containing the (lower-case)
 * query, or — matched by its name — its first address.
 */
export function contactAddresses(c: { email: string; email2: string }, needle: string): string[] {
  const all = [c.email, c.email2].filter((a) => a);
  const hits = all.filter((a) => a.toLowerCase().includes(needle));
  return hits.length > 0 ? hits : all.slice(0, 1);
}

/** The Sent folder of the scope (system name), or null. */
export function sentFolderOf(folders: FolderRef[]): string | null {
  return folders.find((f) => f.name === 'Sent')?.id ?? null;
}

/** The part of the Prisma client the suggestions use (faked in tests). */
export interface SuggestDb {
  message: { findMany(args: unknown): Promise<unknown[]> };
  contact: { findMany(args: unknown): Promise<unknown[]> };
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

export interface SuggestInput {
  q: string;
  /** Folders the caller may read (the whole scope of the suggestions). */
  folders: FolderRef[];
  /** The caller, when the own contacts may be suggested (contacts module on); else null. */
  contactsOwnerId: string | null;
}

type MessageRow = Parameters<typeof toMessageSuggestions>[0][number];

/** Runs the bounded queries of one suggestion request (all in parallel). */
export async function loadSuggestions(db: SuggestDb, input: SuggestInput): Promise<Suggestions> {
  const { q, folders, contactsOwnerId } = input;
  const folderIds = folders.map((f) => f.id);
  if (folderIds.length === 0 && !contactsOwnerId) return { people: [], messages: [] };
  const sentId = sentFolderOf(folders);
  const [messages, senders, recipients, contacts] = await Promise.all([
    folderIds.length === 0 ? [] : db.message.findMany({
      where: suggestMessageWhere(folderIds, q),
      orderBy: { date: 'desc' },
      take: MAX_MESSAGES,
      select: SUGGEST_MESSAGE_SELECT,
    }) as Promise<MessageRow[]>,
    folderIds.length === 0 ? [] : db.message.findMany({
      where: suggestSenderWhere(folderIds, q),
      orderBy: { date: 'desc' },
      take: SENDER_SCAN,
      select: { fromName: true, fromAddr: true },
    }) as Promise<Array<{ fromName: string; fromAddr: string }>>,
    // Recipients of the newest Sent messages: a bounded backward scan of the
    // (folderId, date) index, then the matching addresses, most recent first.
    !sentId ? [] : db.$queryRaw<Array<{ address: string }>>`
      SELECT r AS "address", max(s."date") AS "last"
      FROM (
        SELECT "toAddrs", "ccAddrs", "date" FROM "messages"
        WHERE "folderId" = ${sentId} AND "deletedAt" IS NULL
        ORDER BY "date" DESC LIMIT ${RECIPIENT_WINDOW}
      ) s CROSS JOIN LATERAL unnest(s."toAddrs" || s."ccAddrs") AS r
      WHERE r ILIKE ${likeContains(q)}
      GROUP BY r ORDER BY "last" DESC LIMIT ${RECIPIENT_SCAN}`,
    !contactsOwnerId ? [] : db.contact.findMany({
      where: suggestContactWhere(contactsOwnerId, q),
      orderBy: { displayName: 'asc' },
      take: CONTACT_SCAN,
      select: { displayName: true, email: true, email2: true },
    }) as Promise<Array<{ displayName: string; email: string; email2: string }>>,
  ]);
  const needle = q.toLowerCase();
  const people = mergePeople([
    ...senders.map((s) => ({ name: s.fromName, address: s.fromAddr })),
    ...recipients.map((r) => ({ name: '', address: r.address })),
    ...contacts.flatMap((c) => contactAddresses(c, needle).map((a) => ({ name: c.displayName, address: a }))),
  ], q);
  return { people, messages: toMessageSuggestions(messages, folders) };
}
