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

export async function resolveReplyHeaders(
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
