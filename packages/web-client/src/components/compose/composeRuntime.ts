/**
 * 9.4: the autosave of every open draft tab. A draft in the tab strip is not
 * mounted, but its saver keeps the draft id and finishes a running save; when
 * the tab is shown again the same saver continues (no second draft is
 * created). Mounted, the compose area binds its live state; unmounted, the
 * saver works on the frozen state and stores what the server returned in the
 * tab. Logout saves every open draft first (lib/compose-flush.ts).
 */
import { createDraftAutosave, mergeSavedAttachments, isDraftAttachment, type DraftAutosave, type SaveStatus } from '../../lib/draft-autosave.js';
import { isDraftLocked, saveDraft, type DraftPayload, type SavedDraftResponse } from '../../lib/draft-api.js';
import { registerComposeFlush } from '../../lib/compose-flush.js';
import { createRuntimeRegistry } from '../../lib/composeRuntime.js';
import { hasPendingChanges } from '../../lib/composeRules.js';
import { useUiStore, type ComposeAttachment } from '../../store/ui.js';

export type ComposePayload = DraftPayload & { snapshot: ComposeAttachment[] };

export interface RuntimeBindings {
  snapshot: () => ComposePayload;
  saved: (saved: SavedDraftResponse, state: ComposePayload) => void;
  status: (status: SaveStatus, info: { savedAt?: string }) => void;
}

export interface ComposeRuntime {
  saver: DraftAutosave;
  bind: RuntimeBindings;
  /** Sent, discarded, closed or moved to its own window: nothing is saved on unmount. */
  finished: boolean;
  /** Control that opened the compose; focus returns there when it closes. */
  returnFocus: HTMLElement | null;
  /** Time of the last successful save (status line after a tab switch). */
  savedAt: string | undefined;
}

const EMPTY_PAYLOAD: ComposePayload = {
  to: [], cc: [], bcc: [], subject: '', bodyHtml: '', bodyText: '', keepAttachmentIds: [], files: [], snapshot: [],
};

/** Attachments the server keeps after a save (refs of a replaced version it no longer has are dropped). */
export function attachmentsAfterSave(
  current: ComposeAttachment[], state: ComposePayload, saved: SavedDraftResponse,
): { list: ComposeAttachment[]; lost: number } {
  const stored = saved.attachments ?? [];
  const merged = mergeSavedAttachments(current, state.snapshot, stored);
  const list = merged.filter((a) => !isDraftAttachment(a) || stored.some((s) => s.id === a.id));
  return { list, lost: merged.length - list.length };
}

/** Bindings of a draft in the tab strip: saves its frozen state, results go into the tab. */
export function frozenBindings(key: string, payload: ComposePayload): RuntimeBindings {
  return {
    snapshot: () => payload,
    saved: (saved, state) => {
      const ui = useUiStore.getState();
      const tab = ui.compose.tabs.find((t) => t.key === key);
      if (!tab) return;
      const restore = tab.ctx.restore;
      const attachments = restore ? attachmentsAfterSave(restore.attachments, state, saved).list : undefined;
      ui.updateComposeTab(key, {
        draftId: saved.id,
        ctx: { ...tab.ctx, draftId: saved.id, ...(restore && attachments ? { restore: { ...restore, attachments } } : {}) },
      });
    },
    status: () => undefined,
  };
}

/** Released with the tab: its logout flush goes; the saver is disposed by whoever finished it. */
export const composeRuntimes = createRuntimeRegistry<ComposeRuntime & { unregisterFlush: () => void }>((rt) => rt.unregisterFlush());

/** The runtime of a draft tab (created on first use). */
export function composeRuntime(key: string, initialId: string | null): ComposeRuntime {
  return composeRuntimes.ensure(key, () => {
    const rt = {
      bind: frozenBindings(key, EMPTY_PAYLOAD),
      finished: false,
      returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      savedAt: undefined,
    } as ComposeRuntime & { unregisterFlush: () => void };
    rt.saver = createDraftAutosave<ComposePayload>({
      initialId,
      snapshot: () => rt.bind.snapshot(),
      save: (id, { snapshot: _snapshot, ...payload }) => saveDraft(id, payload),
      // 8.1: being / already sent elsewhere → stop autosaving (no duplicate draft)
      isFatal: isDraftLocked,
      onStatus: (status, info) => {
        if (info.savedAt) rt.savedAt = info.savedAt;
        rt.bind.status(status, info.savedAt ? { savedAt: info.savedAt } : {});
      },
      onSaved: (saved, state) => rt.bind.saved(saved as SavedDraftResponse, state),
    });
    // 8.1: logout saves pending changes BEFORE the session ends
    rt.unregisterFlush = registerComposeFlush(async () => {
      if (!rt.finished && hasPendingChanges(rt.saver.status)) await rt.saver.flush();
    });
    return rt;
  });
}

/** Ends a draft tab: no more saving on unmount, logout flush removed. Returns the saver. */
export function finishRuntime(key: string): DraftAutosave | null {
  const rt = composeRuntimes.get(key);
  if (!rt) return null;
  rt.finished = true;
  composeRuntimes.release(key);
  return rt.saver;
}

/** Saves a draft of the tab strip and ends it (✕ on a tab that is not shown). */
export async function closeStripDraft(key: string): Promise<{ saved: boolean }> {
  const rt = composeRuntimes.get(key);
  if (!rt) return { saved: false };
  const pending = hasPendingChanges(rt.saver.status);
  await rt.saver.flush();
  finishRuntime(key);
  rt.saver.dispose();
  return { saved: pending && !!rt.saver.draftId };
}
