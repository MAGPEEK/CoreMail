/**
 * Compose autosave (OWA style): after `idleMs` without changes the current
 * compose state is saved as a server draft (POST /mail/drafts, then PUT
 * /mail/drafts/:id — every save returns the id of the new version). Saves never
 * overlap: changes made while a save is running are saved afterwards. `flush()`
 * saves immediately (close, minimise, send) and resolves with the draft id.
 * Framework-free; uses the global timers so tests can fake them.
 */

export const AUTOSAVE_IDLE_MS = 3000;

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'locked';

export interface SavedDraft {
  id: string;
  savedAt: string;
}

export interface AutosaveOptions<S> {
  idleMs?: number;
  /** Draft being edited (reopened draft), or null for a new one. */
  initialId?: string | null;
  /** The state to save, read at save time. */
  snapshot: () => S;
  /** Creates (draftId null) or replaces a draft; resolves with the new version. */
  save: (draftId: string | null, state: S) => Promise<SavedDraft>;
  onStatus?: (status: SaveStatus, info: { savedAt?: string; error?: unknown }) => void;
  /** Called after each successful save with the state that was saved. */
  onSaved?: (saved: SavedDraft, state: S) => void;
  /**
   * 8.1: a save error after which saving must stop for good (the draft is being
   * or was sent elsewhere): status 'locked', no retries, flush() saves nothing.
   */
  isFatal?: (error: unknown) => boolean;
}

export interface DraftAutosave {
  readonly draftId: string | null;
  readonly status: SaveStatus;
  /** Content changed: (re)starts the idle timer. */
  touch(): void;
  /** Saves now if anything changed (waits for a running save); resolves with the draft id. */
  flush(): Promise<string | null>;
  /** Stops the timer (window closed); does not save. */
  dispose(): void;
  /** Draft id no longer valid (discarded / sent): the next save creates a new draft. */
  forget(): void;
}

export function createDraftAutosave<S>(o: AutosaveOptions<S>): DraftAutosave {
  const idleMs = o.idleMs ?? AUTOSAVE_IDLE_MS;
  let draftId: string | null = o.initialId ?? null;
  let status: SaveStatus = 'idle';
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let disposed = false;
  let locked = false;

  const setStatus = (s: SaveStatus, info: { savedAt?: string; error?: unknown } = {}) => {
    status = s;
    o.onStatus?.(s, info);
  };
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = null; };

  /** One save of the current state; a change during the save leaves `dirty` set. */
  const saveOnce = (): Promise<void> => {
    dirty = false;
    const state = o.snapshot();
    setStatus('saving');
    const p = o.save(draftId, state).then(
      (saved) => {
        draftId = saved.id;
        o.onSaved?.(saved, state);
        setStatus(dirty ? 'dirty' : 'saved', { savedAt: saved.savedAt });
      },
      (error: unknown) => {
        if (o.isFatal?.(error)) {
          locked = true;            // being / already sent: never save again
          dirty = false;
          clearTimer();
          setStatus('locked', { error });
          return;
        }
        dirty = true;               // keep the change; retried on the next touch/flush
        setStatus('error', { error });
      },
    ).finally(() => {
      running = null;
      // Changes typed during the save: save them after another idle period
      if (dirty && !disposed && status !== 'error') arm();
    });
    running = p;
    return p;
  };

  const arm = () => {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      if (running) return;          // the running save re-arms when it ends
      if (dirty) void saveOnce();
    }, idleMs);
  };

  return {
    get draftId() { return draftId; },
    get status() { return status; },
    touch() {
      if (disposed || locked) return;
      dirty = true;
      if (status !== 'saving') setStatus('dirty');
      arm();
    },
    async flush() {
      clearTimer();
      if (running) await running;
      if (dirty && !locked) await saveOnce();
      if (status === 'error') throw new Error('Draft could not be saved');
      return draftId;
    },
    dispose() {
      disposed = true;
      clearTimer();
    },
    forget() {
      draftId = null;
    },
  };
}

// ── Attachment bookkeeping ────────────────────────────────────────────────────

/** An attachment already stored with the server draft. */
export interface DraftAttachmentRef {
  id: string;
  filename: string;
  size: number;
  mimeType: string;
}

export type ComposeAttachmentLike<F> = F | DraftAttachmentRef;

export function isDraftAttachment(a: unknown): a is DraftAttachmentRef {
  return !!a && typeof a === 'object' && typeof (a as DraftAttachmentRef).id === 'string'
    && typeof (a as DraftAttachmentRef).filename === 'string' && !('arrayBuffer' in (a as object));
}

/**
 * After a save, the server returns the attachments of the new version (new ids).
 * Replaces every entry that was part of the saved snapshot with its stored
 * counterpart (matched by name + size), and keeps entries added since then.
 */
export function mergeSavedAttachments<F extends { name: string; size: number }>(
  current: Array<F | DraftAttachmentRef>,
  saved: Array<F | DraftAttachmentRef>,
  stored: DraftAttachmentRef[],
): Array<F | DraftAttachmentRef> {
  const pool = [...stored];
  const mapping = new Map<F | DraftAttachmentRef, DraftAttachmentRef>();
  for (const entry of saved) {
    const name = isDraftAttachment(entry) ? entry.filename : entry.name;
    const idx = pool.findIndex((s) => s.filename === name && s.size === entry.size);
    if (idx >= 0) { mapping.set(entry, pool[idx]!); pool.splice(idx, 1); }
  }
  return current.map((entry) => mapping.get(entry) ?? entry);
}
