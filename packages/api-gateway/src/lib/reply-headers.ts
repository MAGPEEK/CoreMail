/**
 * In-Reply-To / References for POST /mail/send (8.0.x).
 *
 * The web client sends the DATABASE id of the message it replies to as
 * `inReplyTo`; it used to be written verbatim into the headers (leaking
 * internal ids and breaking threading for every recipient). Now:
 *  - a value that looks like a Message-ID (contains '@') is normalised to
 *    `<id>` and used as In-Reply-To and References
 *  - anything else is treated as an internal message id, resolved within the
 *    mailboxes the caller can read (own, shared, delegated) and replaced by the
 *    parent's Message-ID; References = parent's References (from the stored
 *    raw message, else its In-Reply-To) + parent's Message-ID
 *  - unresolvable ids are dropped — an internal id is never emitted
 */
import { readableMailboxWhere } from './attachment-download.js';

export interface ReplyParent {
  id: string;
  messageId: string | null;
  inReplyTo: string | null;
  storagePath?: string | null;
}

export interface ReplyLookup {
  findParent(id: string, userId: string): Promise<ReplyParent | null>;
  /** Raw RFC 5322 octets of the parent (optional — for its References header). */
  loadRaw?(parent: ReplyParent): Promise<Buffer | null>;
}

const MAX_REFERENCES = 20;

/** `<local@domain>` for a syntactically plausible Message-ID, else null. */
export function normalizeMessageId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (!v || v.length > 995 || /[\s\0]/.test(v.replace(/^<|>$/g, ''))) return null;
  const inner = v.replace(/^<|>$/g, '');
  if (!/^[^<>@\s]+@[^<>@\s]+$/.test(inner)) return null;
  return `<${inner}>`;
}

/** Message-IDs from a References / In-Reply-To header value. */
export function parseIdList(value: string | null | undefined): string[] {
  if (!value) return [];
  return (value.match(/<[^<>\s]+@[^<>\s]+>/g) ?? []).map((v) => normalizeMessageId(v)).filter((v): v is string => !!v);
}

/** Unfolded value of `name` from the header block of a raw message. */
export function rawHeader(raw: Buffer, name: string): string | null {
  const head = raw.subarray(0, Math.min(raw.length, 256 * 1024)).toString('latin1');
  const end = head.search(/\r?\n\r?\n/);
  const block = (end >= 0 ? head.slice(0, end) : head).replace(/\r?\n[ \t]+/g, ' ');
  const re = new RegExp(`^${name}:[ \\t]*(.*)$`, 'im');
  const m = re.exec(block);
  return m ? m[1]!.trim() : null;
}

/** Max. number of Message-IDs a client may send in `references`. */
export const MAX_CLIENT_REFERENCES = 50;

/**
 * Validates the optional client `references` field of POST /mail/send: an array
 * of `<msg-id>` tokens or one whitespace-separated string of them. Max
 * MAX_CLIENT_REFERENCES ids, no CR/LF/NUL, every token a plausible Message-ID.
 * Returns `refs: null` when the field is absent/empty.
 */
export function parseClientReferences(value: unknown): { ok: true; refs: string[] | null } | { ok: false; error: string } {
  if (value === undefined || value === null || value === '') return { ok: true, refs: null };
  let tokens: string[];
  if (typeof value === 'string') tokens = value.split(/[ \t]+/);
  else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) tokens = value as string[];
  else return { ok: false, error: 'references must be a list of Message-IDs' };
  tokens = tokens.map((t) => t.trim()).filter((t) => t.length > 0);
  if (tokens.length === 0) return { ok: true, refs: null };
  if (tokens.length > MAX_CLIENT_REFERENCES) return { ok: false, error: `references: at most ${MAX_CLIENT_REFERENCES} Message-IDs` };
  const refs: string[] = [];
  for (const t of tokens) {
    if (/[\r\n\0]/.test(t) || !/^<[^<>]+>$/.test(t)) return { ok: false, error: 'references: invalid Message-ID' };
    const id = normalizeMessageId(t);
    if (!id) return { ok: false, error: 'references: invalid Message-ID' };
    if (!refs.includes(id)) refs.push(id);
  }
  return { ok: true, refs };
}

/**
 * In-Reply-To / References for an outgoing message. `clientReferences` (validated
 * by parseClientReferences) wins over the server-resolved chain; the resolved
 * In-Reply-To is always the last References entry.
 */
export async function resolveReplyHeaders(
  inReplyTo: string | undefined,
  userId: string,
  lookup: ReplyLookup,
  clientReferences?: string[] | null,
): Promise<{ inReplyTo?: string; references?: string }> {
  const resolved = await resolveServerReplyHeaders(inReplyTo, userId, lookup);
  if (!clientReferences || clientReferences.length === 0) return resolved;
  const refs = clientReferences.filter((r) => r !== resolved.inReplyTo);
  if (resolved.inReplyTo) refs.push(resolved.inReplyTo);
  return { ...resolved, references: refs.slice(-MAX_CLIENT_REFERENCES).join(' ') };
}

async function resolveServerReplyHeaders(
  inReplyTo: string | undefined,
  userId: string,
  lookup: ReplyLookup,
): Promise<{ inReplyTo?: string; references?: string }> {
  const v = inReplyTo?.trim();
  if (!v || /[\r\n\0]/.test(v)) return {};
  if (v.includes('@')) {
    const id = normalizeMessageId(v);
    return id ? { inReplyTo: id, references: id } : {};
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(v)) return {};
  const parent = await lookup.findParent(v, userId);
  const parentId = normalizeMessageId(parent?.messageId);
  if (!parent || !parentId) return {};
  let refs: string[] = [];
  if (lookup.loadRaw) {
    try {
      const raw = await lookup.loadRaw(parent);
      if (raw) refs = parseIdList(rawHeader(raw, 'References'));
    } catch { /* raw unavailable → fall back to In-Reply-To */ }
  }
  if (refs.length === 0) refs = parseIdList(parent.inReplyTo);
  refs = refs.filter((r) => r !== parentId);
  refs.push(parentId);
  return { inReplyTo: parentId, references: refs.slice(-MAX_REFERENCES).join(' ') };
}

/** Prisma-backed lookup: the parent must be in a mailbox the caller can read. */
export function prismaReplyLookup(
  db: { message: { findFirst(args: unknown): Promise<unknown> } },
  loadRaw?: (parent: ReplyParent) => Promise<Buffer | null>,
): ReplyLookup {
  return {
    findParent: async (id, userId) => (await db.message.findFirst({
      where: { id, folder: { mailbox: readableMailboxWhere(userId) } },
      select: { id: true, messageId: true, inReplyTo: true, storagePath: true },
    })) as ReplyParent | null,
    ...(loadRaw ? { loadRaw } : {}),
  };
}
