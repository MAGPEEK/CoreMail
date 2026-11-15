/**
 * SORT and THREAD (RFC 5256). Pure module: base subject extraction, the sort
 * comparator and the ORDEREDSUBJECT / REFERENCES threading algorithms. No
 * database access — the handler (commands/index.ts) evaluates the search
 * criteria and passes the matching messages in; for REFERENCES it attaches the
 * stored References lists (`loadThreadReferences` of @coremail/storage, which
 * also indexes older rows lazily).
 *
 * Comparisons use the i;ascii-casemap collation (RFC 4790 §9.2): ASCII letters
 * are upper-cased, then the UTF-8 octets are compared.
 */
import { ImapParseError, tokenString, type Token } from '../server/tokenizer.js';

export type SortKey = 'ARRIVAL' | 'CC' | 'DATE' | 'FROM' | 'SIZE' | 'SUBJECT' | 'TO';
export interface SortCriterion { key: SortKey; reverse: boolean }
export type ThreadAlgorithm = 'ORDEREDSUBJECT' | 'REFERENCES';

/** Message data SORT/THREAD need (all stored columns). */
export interface SortMessage {
  uid: number;
  /** Message sequence number in the session's view (final tie-breaker). */
  seq: number;
  subject: string;
  fromAddr: string;
  toAddrs: string[];
  ccAddrs: string[];
  /** Sent date (Date header; the store falls back to the receive time). */
  date: Date;
  /** Internal date (arrival). */
  createdAt?: Date | null;
  rawSize: number;
  messageId?: string | null;
  inReplyTo?: string | null;
  /**
   * References header msg-ids, oldest first (`Message.references`, v9.1). Null,
   * undefined or [] → the first In-Reply-To msg-id is used (RFC 5256 §3).
   */
  references?: readonly string[] | null;
}

const SORT_KEYS = new Set<SortKey>(['ARRIVAL', 'CC', 'DATE', 'FROM', 'SIZE', 'SUBJECT', 'TO']);

/** Parses the sort program list "(REVERSE DATE SUBJECT)". */
export function parseSortCriteria(token: Token | undefined): SortCriterion[] {
  if (token?.type !== 'list' || token.items.length === 0) throw new ImapParseError('SORT expects a list of sort keys');
  const out: SortCriterion[] = [];
  let reverse = false;
  for (const item of token.items) {
    const name = item.type === 'atom' ? item.value.toUpperCase() : '';
    if (name === 'REVERSE') {
      if (reverse) throw new ImapParseError('REVERSE must be followed by a sort key');
      reverse = true;
      continue;
    }
    if (!SORT_KEYS.has(name as SortKey)) throw new ImapParseError(`Unsupported sort key ${name || '?'}`);
    out.push({ key: name as SortKey, reverse });
    reverse = false;
  }
  if (reverse) throw new ImapParseError('REVERSE must be followed by a sort key');
  return out;
}

/** Reads the mandatory charset argument of SORT / THREAD. */
export function parseCharset(token: Token | undefined): string {
  const value = tokenString(token);
  if (value === null || value === '') throw new ImapParseError('Charset expected');
  return value.toUpperCase();
}

// ─── Base subject (RFC 5256 §2.1) ────────────────────────────────────────────

// subj-blob = "[" *BLOBCHAR "]" *WSP
const BLOB = String.raw`\[[^\[\]]*\][ \t]*`;
// subj-refwd = ("re" / ("fw" ["d"])) *WSP [subj-blob] ":"
// subj-leader = (*subj-blob subj-refwd) / WSP
const LEADER_REFWD = new RegExp(String.raw`^(?:${BLOB})*(?:re|fwd?)[ \t]*(?:${BLOB})?:`, 'i');
const LEADING_BLOB = new RegExp(`^${BLOB}`);
const TRAILER = /(?:\(fwd\)|[ \t])$/i;

export interface BaseSubject {
  base: string;
  /** Something reply/forward-like ("Re:", "Fwd:", "(fwd)", "[fwd: …]") was removed. */
  isReplyOrForward: boolean;
}

/** Extracts the base subject (RFC 5256 §2.1); the input is already decoded (encoded words). */
export function baseSubject(subject: string): BaseSubject {
  // (1) tabs and line continuations become spaces, runs of spaces collapse.
  let s = subject.replace(/\r?\n[ \t]*/g, ' ').replace(/[\t ]+/g, ' ');
  let replyFwd = false;
  for (;;) {
    // (2) remove trailing "(fwd)" and whitespace.
    for (let m = TRAILER.exec(s); m; m = TRAILER.exec(s)) {
      if (m[0] !== ' ' && m[0] !== '\t') replyFwd = true;
      s = s.slice(0, -m[0].length);
    }
    // (3)–(5): remove subj-leader text, then one subj-blob if a base remains.
    for (let changed = true; changed;) {
      changed = false;
      for (;;) {
        const refwd = LEADER_REFWD.exec(s);
        if (refwd) { s = s.slice(refwd[0].length); replyFwd = true; changed = true; continue; }
        if (s.startsWith(' ') || s.startsWith('\t')) { s = s.slice(1); changed = true; continue; }
        break;
      }
      const blob = LEADING_BLOB.exec(s);
      if (blob && /[^ \t]/.test(s.slice(blob[0].length))) { s = s.slice(blob[0].length); changed = true; }
    }
    // (6) "[fwd: … ]" wrapper.
    if (/^\[fwd:/i.test(s) && s.endsWith(']')) {
      s = s.slice(5, -1);
      replyFwd = true;
      continue;
    }
    return { base: s, isReplyOrForward: replyFwd };
  }
}

// ─── Collation and keys ──────────────────────────────────────────────────────

/** i;ascii-casemap key: ASCII letters upper-cased, compared as UTF-8 octets. */
function casemapKey(value: string): Buffer {
  return Buffer.from(value.replace(/[a-z]+/g, (m) => m.toUpperCase()), 'utf8');
}

/** addr-mailbox (local part) of an address (RFC 5256 §3: FROM/TO/CC). */
function mailboxPart(address: string | undefined): string {
  if (!address) return '';
  const at = address.lastIndexOf('@');
  return at === -1 ? address : address.slice(0, at);
}

const EMPTY = Buffer.alloc(0);

/** Sorts messages (RFC 5256 §3); ties end in sequence-number order. Returns a new array. */
export function sortMessages<T extends SortMessage>(messages: T[], criteria: SortCriterion[]): T[] {
  // Keys are computed once per message (not per comparison).
  const keyed = messages.map((m) => ({
    m,
    keys: criteria.map((c): Buffer | number => {
      switch (c.key) {
        case 'ARRIVAL': return (m.createdAt ?? m.date).getTime();
        case 'DATE': return m.date.getTime();
        case 'SIZE': return m.rawSize;
        case 'SUBJECT': return casemapKey(baseSubject(m.subject).base);
        case 'FROM': return m.fromAddr ? casemapKey(mailboxPart(m.fromAddr)) : EMPTY;
        case 'TO': return casemapKey(mailboxPart(m.toAddrs[0]));
        case 'CC': return casemapKey(mailboxPart(m.ccAddrs[0]));
      }
    }),
  }));
  keyed.sort((a, b) => {
    for (const [i, c] of criteria.entries()) {
      const x = a.keys[i]!;
      const y = b.keys[i]!;
      const d = typeof x === 'number' ? x - (y as number) : Buffer.compare(x, y as Buffer);
      if (d !== 0) return c.reverse ? -d : d;
    }
    return a.m.seq - b.m.seq;
  });
  return keyed.map((k) => k.m);
}

// ─── Threads ─────────────────────────────────────────────────────────────────

export interface ThreadNode {
  /** Message number (UID or sequence number), null for a dummy node. */
  id: number | null;
  children: ThreadNode[];
}

/**
 * Thread syntax of one node (RFC 5256 §4): "id child" for a single child,
 * "id (a)(b)" for several, "(a)(b)" for a dummy. Iterative: a reply chain can
 * be thousands of messages deep.
 */
function serializeNode(root: ThreadNode): string {
  const out: string[] = [];
  const stack: Array<ThreadNode | string> = [root];
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (typeof item === 'string') { out.push(item); continue; }
    const head = item.id === null ? '' : `${item.id}`;
    const parts: Array<ThreadNode | string> = [];
    if (item.children.length === 0) parts.push(head);
    else if (item.children.length === 1 && item.id !== null) parts.push(`${head} `, item.children[0]!);
    else {
      if (item.id !== null) parts.push(`${head} `);
      for (const c of item.children) parts.push('(', c, ')');
    }
    for (let i = parts.length - 1; i >= 0; i--) stack.push(parts[i]!);
  }
  return out.join('');
}

/** Thread list of the THREAD response: "(3 6 (4 23)(44 7 96))((1)(2))". */
export function formatThreads(roots: ThreadNode[]): string {
  return roots.map((r) => `(${serializeNode(r)})`).join('');
}

const sentTime = (m: SortMessage): number => m.date.getTime();
const byDate = (a: SortMessage, b: SortMessage): number => sentTime(a) - sentTime(b) || a.seq - b.seq;

/**
 * THREAD=ORDEREDSUBJECT (RFC 5256 §3): messages are grouped by base subject;
 * in every group the earliest message is the parent of all others (in date
 * order); threads are ordered by the date of their first message.
 */
export function threadOrderedSubject(messages: SortMessage[], idOf: (m: SortMessage) => number): ThreadNode[] {
  const groups = new Map<string, SortMessage[]>();
  const sorted = [...messages].sort((a, b) => Buffer.compare(casemapKey(baseSubject(a.subject).base), casemapKey(baseSubject(b.subject).base)) || byDate(a, b));
  for (const m of sorted) {
    const key = casemapKey(baseSubject(m.subject).base).toString('latin1');
    const list = groups.get(key);
    if (list) list.push(m);
    else groups.set(key, [m]);
  }
  const threads = [...groups.values()].map((list) => list.sort(byDate));
  threads.sort((a, b) => byDate(a[0]!, b[0]!));
  return threads.map(([first, ...rest]) => ({
    id: idOf(first!),
    children: rest.map((m) => ({ id: idOf(m), children: [] })),
  }));
}

/**
 * Extracts msg-ids ("<…>") from a header value; a bare value counts as one id.
 * Tokens with whitespace or nested angle brackets are not msg-ids and are skipped.
 */
export function msgIds(value: string | null | undefined): string[] {
  if (!value) return [];
  const ids = value.match(/<[^<>\s]+>/g);
  if (ids) return ids;
  if (/[<>]/.test(value)) return [];
  const bare = value.trim();
  return bare && !/\s/.test(bare) ? [`<${bare}>`] : [];
}

/**
 * Reference list of a message (RFC 5256 §3 REFERENCES step 1B): the msg-ids of
 * its References header (`m.references`, oldest first); when it has none, the
 * first valid msg-id of In-Reply-To.
 */
export function referencesOf(m: SortMessage): string[] {
  const refs = (m.references ?? []).filter((r) => typeof r === 'string' && r.length > 0);
  if (refs.length > 0) return refs;
  return msgIds(m.inReplyTo).slice(0, 1);
}

interface Container {
  message: SortMessage | null;
  parent: Container | null;
  children: Container[];
}

const newContainer = (): Container => ({ message: null, parent: null, children: [] });

function isAncestor(maybeAncestor: Container, node: Container): boolean {
  // A container without children is nobody's ancestor (cheap common case).
  if (maybeAncestor.children.length === 0) return maybeAncestor === node;
  for (let p: Container | null = node; p; p = p.parent) if (p === maybeAncestor) return true;
  return false;
}

function unlink(child: Container): void {
  const parent = child.parent;
  if (!parent) return;
  const i = parent.children.indexOf(child);
  if (i >= 0) parent.children.splice(i, 1);
  child.parent = null;
}

function link(parent: Container, child: Container): void {
  unlink(child);
  child.parent = parent;
  parent.children.push(child);
}

/** Message whose sent date orders a container (dummies: their earliest child, recursively). */
function containerDate(c: Container, memo: Map<Container, SortMessage | null>): SortMessage | null {
  if (c.message) return c.message;
  const known = memo.get(c);
  if (known !== undefined) return known;
  let best: SortMessage | null = null;
  for (const child of c.children) {
    const d = containerDate(child, memo);
    if (d && (!best || byDate(d, best) < 0)) best = d;
  }
  memo.set(c, best);
  return best;
}

/**
 * THREAD=REFERENCES (RFC 5256 §3, Jamie Zawinski's algorithm):
 *
 *  1. every message gets the container of its Message-ID (duplicates and
 *     messages without one get a container of their own); the msg-ids of its
 *     reference list (References, else the first In-Reply-To id) are linked
 *     parent → child in order — existing links are kept, links that would
 *     create a loop are not added — and the last reference becomes the
 *     message's parent (missing messages are dummy containers);
 *  2. the root set is every container without a parent;
 *  4. dummies without children are removed; a dummy's children are promoted to
 *     its level (to the root set only when it has exactly one child);
 *  5. roots with the same base subject are merged (dummy preferred, an original
 *     preferred over a reply/forward, two of a kind become siblings under a new
 *     dummy);
 *  6. siblings are sorted by sent date (dummies by their earliest child; ties
 *     by sequence number), and so are the threads.
 *
 * `references` defaults to {@link referencesOf}. Complexity is O(n log n) for
 * the usual shapes (maps/sets, no list scans per root).
 */
export function threadReferences(
  messages: SortMessage[],
  idOf: (m: SortMessage) => number,
  references: (m: SortMessage) => string[] = referencesOf,
): ThreadNode[] {
  const byId = new Map<string, Container>();
  const all: Container[] = [];
  const containerFor = (id: string): Container => {
    let c = byId.get(id);
    if (!c) { c = newContainer(); byId.set(id, c); all.push(c); }
    return c;
  };

  // (1) link messages through their references.
  for (const m of messages) {
    const own = msgIds(m.messageId)[0];
    let container: Container;
    const existing = own ? byId.get(own) : undefined;
    if (own && existing && existing.message === null) {
      container = existing;
    } else {
      // (1A) Missing or duplicate Message-ID → a unique container of its own.
      container = newContainer();
      all.push(container);
      if (own && !existing) byId.set(own, container);
    }
    container.message = m;

    // (1B) link the reference chain; existing links win, no loops.
    let prev: Container | null = null;
    for (const ref of references(m)) {
      if (ref === own) continue; // a message never references itself
      const c = containerFor(ref);
      if (prev && c !== prev && !c.parent && !isAncestor(c, prev)) link(prev, c);
      prev = c;
    }
    // (1C) the last reference becomes the parent (unless it is the message
    // itself or a descendant of it); without references the message is a root.
    if (prev && prev !== container && !isAncestor(container, prev)) link(prev, container);
    else unlink(container);
  }

  // (2) root set.
  const rootSet = all.filter((c) => c.parent === null);

  // (4) prune empty dummies; promote children of dummies (not to the root set
  // when the dummy has more than one child).
  // Iterative post-order (reply chains can be thousands deep): children are
  // pruned before their parent looks at them.
  const top = newContainer();
  top.children = rootSet;
  const order: Container[] = [];
  for (const stack = [top]; stack.length > 0;) {
    const c = stack.pop()!;
    order.push(c);
    for (const child of c.children) stack.push(child);
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const node = order[i]!;
    const kept: Container[] = [];
    for (const c of node.children) {
      if (c.message === null) {
        if (c.children.length === 0) continue;
        if (node !== top || c.children.length === 1) {
          for (const child of c.children) kept.push(child);
          continue;
        }
      }
      kept.push(c);
    }
    node.children = kept;
    for (const c of kept) c.parent = node === top ? null : node;
  }
  const roots = top.children;

  // (5A/B) subject table over the root set.
  const subjectOf = (c: Container): { base: string; reply: boolean } | null => {
    const m = c.message ?? c.children[0]?.message ?? null;
    if (!m) return null;
    const b = baseSubject(m.subject);
    return { base: casemapKey(b.base).toString('latin1'), reply: b.isReplyOrForward };
  };
  const subjects = new Map<Container, { base: string; reply: boolean } | null>();
  for (const r of roots) subjects.set(r, subjectOf(r));
  const table = new Map<string, Container>();
  for (const r of roots) {
    const s = subjects.get(r);
    if (!s || s.base === '') continue;
    const old = table.get(s.base);
    if (!old
      || (r.message === null && old.message !== null)
      || (old.message !== null && r.message !== null && subjects.get(old)!.reply && !s.reply)) {
      table.set(s.base, r);
    }
  }

  // (5C) merge roots with the same base subject. `slot` keeps the root order;
  // a root that is merged away gets no slot, a new dummy takes its target's slot.
  const slot = new Map<Container, number>();
  roots.forEach((r, i) => slot.set(r, i));
  const finalRoots: Array<Container | null> = [...roots];
  const drop = (c: Container): void => { const i = slot.get(c); if (i !== undefined) { finalRoots[i] = null; slot.delete(c); } };
  for (const r of roots) {
    if (!slot.has(r)) continue;
    const s = subjects.get(r);
    if (!s || s.base === '') continue;
    const target = table.get(s.base);
    if (!target || target === r || !slot.has(target)) continue;
    if (target.message === null && r.message === null) {
      for (const child of [...r.children]) link(target, child);
      drop(r);
    } else if (target.message === null) {
      link(target, r);
      drop(r);
    } else if (r.message === null) {
      link(r, target);
      drop(target);
      table.set(s.base, r);
    } else if (!subjects.get(target)!.reply && s.reply) {
      link(target, r);
      drop(r);
    } else if (subjects.get(target)!.reply && !s.reply) {
      link(r, target);
      drop(target);
      table.set(s.base, r);
    } else {
      // Two real messages with the same subject: a new dummy holds them as siblings.
      const dummy = newContainer();
      const i = slot.get(target)!;
      slot.delete(target);
      finalRoots[i] = dummy;
      slot.set(dummy, i);
      link(dummy, target);
      link(dummy, r);
      drop(r);
      subjects.set(dummy, { base: s.base, reply: false });
      table.set(s.base, dummy);
    }
  }

  // (6) sort siblings by sent date and convert.
  const memo = new Map<Container, SortMessage | null>();
  const compare = (a: Container, b: Container): number => {
    const x = containerDate(a, memo);
    const y = containerDate(b, memo);
    if (!x || !y) return x ? -1 : y ? 1 : 0;
    return byDate(x, y);
  };
  const sortedRoots = finalRoots.filter((c): c is Container => c !== null).sort(compare);
  // Iterative conversion (deep chains). Depth-first pop order visits the
  // siblings of every list left to right, so appending keeps the sort order.
  const result: ThreadNode[] = [];
  const work: Array<{ c: Container; into: ThreadNode[] }> = [];
  for (let i = sortedRoots.length - 1; i >= 0; i--) work.push({ c: sortedRoots[i]!, into: result });
  while (work.length > 0) {
    const { c, into } = work.pop()!;
    const node: ThreadNode = { id: c.message ? idOf(c.message) : null, children: [] };
    into.push(node);
    const kids = [...c.children].sort(compare);
    for (let i = kids.length - 1; i >= 0; i--) work.push({ c: kids[i]!, into: node.children });
  }
  return result;
}
