/**
 * SORT and THREAD (RFC 5256). Pure module: base subject extraction, the sort
 * comparator and the ORDEREDSUBJECT / REFERENCES threading algorithms. No
 * database access — the handler (commands/index.ts) evaluates the search
 * criteria and passes the matching messages in.
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

function serializeNode(node: ThreadNode): string {
  const head = node.id === null ? '' : `${node.id}`;
  if (node.children.length === 0) return head;
  if (node.children.length === 1 && node.id !== null) return `${head} ${serializeNode(node.children[0]!)}`;
  const kids = node.children.map((c) => `(${serializeNode(c)})`).join('');
  return node.id === null ? kids : `${head} ${kids}`;
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

/** Extracts msg-ids ("<…>") from a header value; a bare value counts as one id. */
export function msgIds(value: string | null | undefined): string[] {
  if (!value) return [];
  const ids = value.match(/<[^<>\s]+>/g);
  if (ids) return ids;
  const bare = value.trim();
  return bare ? [`<${bare.replace(/^<|>$/g, '')}>`] : [];
}

interface Container {
  message: SortMessage | null;
  parent: Container | null;
  children: Container[];
}

function isAncestor(maybeAncestor: Container, node: Container): boolean {
  for (let p: Container | null = node; p; p = p.parent) if (p === maybeAncestor) return true;
  return false;
}

function link(parent: Container, child: Container): void {
  if (child.parent) child.parent.children = child.parent.children.filter((c) => c !== child);
  child.parent = parent;
  parent.children.push(child);
}

/** Earliest sent date in a container's subtree (dummy nodes sort by their first child). */
function containerDate(c: Container): SortMessage | null {
  if (c.message) return c.message;
  let best: SortMessage | null = null;
  for (const child of c.children) {
    const d = containerDate(child);
    if (d && (!best || byDate(d, best) < 0)) best = d;
  }
  return best;
}

function compareContainers(a: Container, b: Container): number {
  const x = containerDate(a);
  const y = containerDate(b);
  if (!x || !y) return x ? -1 : y ? 1 : 0;
  return byDate(x, y);
}

/**
 * THREAD=REFERENCES (RFC 5256 §3, the "JWZ" algorithm). The parent chain comes
 * from the References header; CoreMail stores In-Reply-To (and Message-ID) as
 * columns, so `referencesOf` supplies the reference list per message (by
 * default the In-Reply-To msg-id).
 */
export function threadReferences(
  messages: SortMessage[],
  idOf: (m: SortMessage) => number,
  referencesOf: (m: SortMessage) => string[] = (m) => msgIds(m.inReplyTo).slice(0, 1),
): ThreadNode[] {
  const byId = new Map<string, Container>();
  const all: Container[] = [];
  const containerFor = (id: string): Container => {
    let c = byId.get(id);
    if (!c) { c = { message: null, parent: null, children: [] }; byId.set(id, c); all.push(c); }
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
      // Missing or duplicate Message-ID → a container of its own.
      container = { message: null, parent: null, children: [] };
      all.push(container);
      if (own && !existing) byId.set(own, container);
    }
    container.message = m;

    let prev: Container | null = null;
    for (const ref of referencesOf(m)) {
      const c = containerFor(ref);
      if (prev && !c.parent && c !== prev && !isAncestor(c, prev)) link(prev, c);
      prev = c;
    }
    // (1B) the last reference becomes the parent (unless that creates a loop).
    if (container.parent) container.parent.children = container.parent.children.filter((c) => c !== container);
    container.parent = null;
    if (prev && prev !== container && !isAncestor(container, prev)) link(prev, container);
  }

  // (2) root set.
  let roots = all.filter((c) => c.parent === null);

  // (4) prune empty dummies; promote children of dummies (not at root level with > 1 child).
  const prune = (list: Container[], atRoot: boolean): Container[] => {
    const out: Container[] = [];
    for (const c of list) {
      c.children = prune(c.children, false);
      for (const child of c.children) child.parent = c;
      if (c.message === null) {
        if (c.children.length === 0) continue;
        if (!atRoot || c.children.length === 1) {
          for (const child of c.children) { child.parent = c.parent; out.push(child); }
          continue;
        }
      }
      out.push(c);
    }
    return out;
  };
  roots = prune(roots, true);
  for (const r of roots) r.parent = null;

  // (5) group the root set by base subject.
  const subjectOf = (c: Container): { base: string; reply: boolean } | null => {
    const m = c.message ?? c.children[0]?.message ?? null;
    if (!m) return null;
    const b = baseSubject(m.subject);
    return { base: casemapKey(b.base).toString('latin1'), reply: b.isReplyOrForward };
  };
  const table = new Map<string, Container>();
  for (const r of roots) {
    const s = subjectOf(r);
    if (!s || s.base === '') continue;
    const old = table.get(s.base);
    if (!old
      || (r.message === null && old.message !== null)
      || (old.message !== null && r.message !== null && subjectOf(old)!.reply && !s.reply)) {
      table.set(s.base, r);
    }
  }
  // (5B) merge roots with the same base subject.
  const result = [...roots];
  const drop = (c: Container): void => { const i = result.indexOf(c); if (i >= 0) result.splice(i, 1); };
  const swap = (old: Container, next: Container): void => { const i = result.indexOf(old); if (i >= 0) result[i] = next; };
  for (const r of roots) {
    if (!result.includes(r)) continue;
    const s = subjectOf(r);
    if (!s || s.base === '') continue;
    const target = table.get(s.base);
    if (!target || target === r || !result.includes(target)) continue;
    const targetReply = subjectOf(target)?.reply ?? false;
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
    } else if (!targetReply && s.reply) {
      link(target, r);
      drop(r);
    } else if (targetReply && !s.reply) {
      link(r, target);
      drop(target);
      table.set(s.base, r);
    } else {
      // Two real messages with the same subject: a new dummy holds them as siblings.
      const dummy: Container = { message: null, parent: null, children: [] };
      swap(target, dummy);
      link(dummy, target);
      link(dummy, r);
      drop(r);
      table.set(s.base, dummy);
    }
  }
  const finalRoots = result;

  // (6) sort siblings by sent date and convert.
  const convert = (c: Container): ThreadNode => ({
    id: c.message ? idOf(c.message) : null,
    children: [...c.children].sort(compareContainers).map(convert),
  });
  return finalRoots.sort(compareContainers).map(convert);
}
