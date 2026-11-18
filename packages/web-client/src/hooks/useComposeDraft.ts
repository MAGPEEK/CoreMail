/**
 * Server draft of a compose tab (9.4): autosave through the tab's runtime
 * (components/compose/composeRuntime.ts), reopen of a server draft, and what
 * happens when the compose area unmounts without being finished (another draft
 * or a mail is shown, the user leaves the mail view): its state is frozen into
 * the tab and pending changes are saved — the tab strip brings it back as it was.
 */
import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { loadDraft, type LoadedDraft, type SavedDraftResponse } from '../lib/draft-api.js';
import type { SaveStatus } from '../lib/draft-autosave.js';
import { toastError } from '../lib/errors.js';
import { useUiStore, type ComposeContext, type ComposeSnapshot } from '../store/ui.js';
import { composeRuntime, frozenBindings, type ComposePayload, type ComposeRuntime } from '../components/compose/composeRuntime.js';

export interface SaveInfo { status: SaveStatus; savedAt?: string }

export function useComposeDraft(o: {
  tabKey: string;
  ctx: ComposeContext;
  editor: Editor | null;
  /** Reopen this server draft (no in-memory snapshot of it). */
  loadFromServer: boolean;
  payload: () => ComposePayload;
  /** State for the tab strip; null = still loading (the tab reopens from the server / context). */
  freeze: () => ComposeSnapshot | null;
  onLoaded: (d: LoadedDraft) => void;
  onSaved: (saved: SavedDraftResponse, state: ComposePayload) => void;
}): { runtime: ComposeRuntime; saveInfo: SaveInfo; draftLoading: boolean } {
  const [runtime] = useState(() => composeRuntime(o.tabKey, o.ctx.draftId ?? null));
  const [saveInfo, setSaveInfo] = useState<SaveInfo>(() => ({
    status: runtime.saver.status, ...(runtime.savedAt ? { savedAt: runtime.savedAt } : {}),
  }));
  const [draftLoading, setDraftLoading] = useState(o.loadFromServer);
  const latest = useRef(o);
  latest.current = o;

  useEffect(() => {
    runtime.bind = {
      snapshot: () => latest.current.payload(),
      saved: (saved, state) => latest.current.onSaved(saved, state),
      status: (status, info) => setSaveInfo({ status, ...info }),
    };
    return () => {
      if (runtime.finished) return;
      const { tabKey, ctx } = latest.current;
      const snapshot = latest.current.freeze();
      runtime.bind = frozenBindings(tabKey, latest.current.payload());
      if (snapshot) {
        const draftId = runtime.saver.draftId ?? ctx.draftId;
        useUiStore.getState().updateComposeTab(tabKey, {
          subject: snapshot.subject,
          ctx: { ...ctx, restore: snapshot, ...(draftId ? { draftId } : {}) },
          ...(draftId ? { draftId } : {}),
        });
      }
      void runtime.saver.flush().catch(() => undefined);
    };
  }, [runtime]);

  // Typing in the editor (setContent of signature / draft does not emit updates)
  useEffect(() => {
    const { editor } = o;
    if (!editor) return;
    const onUpdate = () => runtime.saver.touch();
    editor.on('update', onUpdate);
    return () => { editor.off('update', onUpdate); };
  }, [o.editor, runtime]);

  // Reopen a server draft (once per mount; a tab left while loading reloads)
  useEffect(() => {
    const { editor, loadFromServer, ctx } = latest.current;
    if (!loadFromServer || !ctx.draftId || !editor) return;
    let cancelled = false;
    loadDraft(ctx.draftId).then((d) => {
      if (cancelled) return;
      latest.current.onLoaded(d);
      runtime.savedAt = d.savedAt;
      setSaveInfo({ status: 'saved', savedAt: d.savedAt });
    }, (err: unknown) => {
      if (!cancelled) toastError(err);
    }).finally(() => { if (!cancelled) setDraftLoading(false); });
    return () => { cancelled = true; };
  }, [o.editor]);

  return { runtime, saveInfo, draftLoading };
}
