/**
 * Draft save conflicts (8.1) — framework-free so node --test can cover it.
 *
 * The server answers a PUT on a stale draft id with
 *   409 DRAFT_SUPERSEDED { currentId, attachmentIds }  (another tab / a raced save)
 *   409 DRAFT_SENDING | DRAFT_SENT                     (stop saving)
 *   404                                               (gone: discarded elsewhere)
 * Only the last one may create a new draft; the others must never duplicate it.
 */

export interface DraftPayloadLike {
  keepAttachmentIds: string[];
}

/** 409 DRAFT_SUPERSEDED: the id is an old version; the server names the current one. */
// (no TS parameter properties: the file runs under node's type stripping in tests)
export class DraftSupersededError extends Error {
  readonly status = 409;
  readonly code = 'DRAFT_SUPERSEDED';
  readonly currentId: string;
  readonly attachmentIds: Record<string, string>;
  constructor(message: string, currentId: string, attachmentIds: Record<string, string>) {
    super(message);
    this.name = 'DraftSupersededError';
    this.currentId = currentId;
    this.attachmentIds = attachmentIds;
  }
}

/** 409 DRAFT_SENDING / DRAFT_SENT: the draft is being / was sent — stop saving it. */
export class DraftLockedError extends Error {
  readonly status = 409;
  readonly code: 'DRAFT_SENDING' | 'DRAFT_SENT';
  constructor(message: string, code: 'DRAFT_SENDING' | 'DRAFT_SENT') {
    super(message);
    this.name = 'DraftLockedError';
    this.code = code;
  }
}

/** The conflict error for a draft-save response body, or null for anything else. */
export function draftConflictFromBody(body: unknown, status: number, message: string): Error | null {
  if (status !== 409) return null;
  const b = (body && typeof body === 'object' ? body : {}) as { code?: unknown; error?: unknown; currentId?: unknown; attachmentIds?: unknown };
  const code = typeof b.code === 'string' ? b.code : typeof b.error === 'string' ? b.error : '';
  if (code === 'DRAFT_SUPERSEDED' && typeof b.currentId === 'string') {
    const map = b.attachmentIds && typeof b.attachmentIds === 'object' ? b.attachmentIds as Record<string, string> : {};
    return new DraftSupersededError(message, b.currentId, map);
  }
  if (code === 'DRAFT_SENDING' || code === 'DRAFT_SENT') return new DraftLockedError(message, code);
  return null;
}

/** A draft-save error after which autosave must stop (createDraftAutosave isFatal). */
export const isDraftLocked = (err: unknown): boolean => err instanceof DraftLockedError;

/**
 * Create (id null) or replace a draft with the conflict rules above:
 * superseded → retry once on the current version (kept attachments mapped to
 * their new ids); locked → thrown; 404 → recreate without kept attachments.
 */
export async function saveDraftWith<P extends DraftPayloadLike, R>(
  id: string | null,
  p: P,
  ops: { post: (p: P) => Promise<R>; put: (id: string, p: P) => Promise<R> },
): Promise<R> {
  if (!id) return ops.post(p);
  try {
    try {
      return await ops.put(id, p);
    } catch (err) {
      if (!(err instanceof DraftSupersededError)) throw err;
      const keepAttachmentIds = p.keepAttachmentIds.map((a) => err.attachmentIds[a]).filter((a): a is string => !!a);
      return await ops.put(err.currentId, { ...p, keepAttachmentIds });
    }
  } catch (err) {
    if ((err as { status?: unknown } | null)?.status === 404) return ops.post({ ...p, keepAttachmentIds: [] });
    throw err;
  }
}
