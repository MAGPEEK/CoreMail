/**
 * Undo stack for reversible mail actions (delete → Trash, move, archive, junk).
 * Each entry lives for `ttlMs` (default 8 s, like the undo toast); `z` / Ctrl+Z
 * runs the newest live entry. Framework-free and unit-tested.
 */

export const UNDO_TTL_MS = 8000;

export interface UndoEntry {
  id: string;
  label: string;
  undo: () => unknown;
  expiresAt: number;
}

export interface UndoStackOptions {
  ttlMs?: number;
  max?: number;
  now?: () => number;
}

export function createUndoStack(opts: UndoStackOptions = {}) {
  const ttlMs = opts.ttlMs ?? UNDO_TTL_MS;
  const max = opts.max ?? 20;
  const now = opts.now ?? (() => Date.now());
  let entries: UndoEntry[] = [];
  let seq = 0;

  const prune = () => {
    const t = now();
    entries = entries.filter((e) => e.expiresAt > t);
  };

  return {
    push(label: string, undo: () => unknown, ttl: number = ttlMs): UndoEntry {
      prune();
      const entry: UndoEntry = { id: `undo-${++seq}`, label, undo, expiresAt: now() + ttl };
      entries.push(entry);
      if (entries.length > max) entries = entries.slice(-max);
      return entry;
    },
    /** Removes an entry (toast button used / toast closed); returns it if still live. */
    remove(id: string): UndoEntry | undefined {
      prune();
      const e = entries.find((x) => x.id === id);
      entries = entries.filter((x) => x.id !== id);
      return e;
    },
    /** Takes the newest live entry (keyboard undo). */
    takeLatest(): UndoEntry | undefined {
      prune();
      return entries.pop();
    },
    size(): number {
      prune();
      return entries.length;
    },
    clear(): void { entries = []; },
  };
}

export type UndoStack = ReturnType<typeof createUndoStack>;

export interface MessageLocation { id: string; folderId: string }

/** Groups message ids by their original folder (undo moves each group back). */
export function groupByFolder(items: MessageLocation[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const it of items) {
    const list = out.get(it.folderId);
    if (list) list.push(it.id);
    else out.set(it.folderId, [it.id]);
  }
  return out;
}

export type MailUndoableAction = 'delete' | 'archive' | 'spam' | 'move';

export interface UndoStep { action: 'move' | 'notSpam'; ids: string[]; folderId?: string }

/**
 * The bulk requests that revert an action. Moves go back folder by folder.
 * "Junk" is reverted with `notSpam` first (removes the sender from the user's
 * junk list and re-learns the mails as ham — that action moves to the Inbox),
 * then mails that did not come from the Inbox are moved on to their folder.
 */
export function planUndo(action: MailUndoableAction, items: MessageLocation[], inboxId: string | null): UndoStep[] {
  const groups = groupByFolder(items);
  if (action !== 'spam') {
    return [...groups.entries()].map(([folderId, ids]) => ({ action: 'move', ids, folderId }));
  }
  const steps: UndoStep[] = [{ action: 'notSpam', ids: items.map((i) => i.id) }];
  for (const [folderId, ids] of groups) {
    if (folderId !== inboxId) steps.push({ action: 'move', ids, folderId });
  }
  return steps;
}

/**
 * Splits a delete into items that go to Trash (undoable) and items already in
 * Trash (deleted permanently by the server → need a confirmation, no undo).
 */
export function splitDelete(items: MessageLocation[], trashId: string | null): { toTrash: MessageLocation[]; permanent: MessageLocation[] } {
  // No Trash folder → nothing can be restored, treat as permanent
  if (!trashId) return { toTrash: [], permanent: items };
  return {
    toTrash: items.filter((i) => i.folderId !== trashId),
    permanent: items.filter((i) => i.folderId === trashId),
  };
}
