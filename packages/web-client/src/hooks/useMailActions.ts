/**
 * Mail actions with undo (OWA style): delete (→ Trash), archive, move and
 * mark-as-junk show an 8 s "Undo" toast (also `z`). Undo moves every message
 * back to the folder it came from — selections spanning several folders
 * (search results) are restored folder by folder. Permanent deletes
 * (Shift+Del, or deleting inside Trash) ask for confirmation and offer no undo.
 */
import { useCallback } from 'react';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import type { Folder, MessagesResponse } from '../api/types.js';
import { toastError } from '../lib/errors.js';
import { planUndo, splitDelete, type MessageLocation, type MailUndoableAction } from '../lib/undo-stack.js';
import { showUndoToast } from '../components/UndoToast.js';
import { translate, fmt } from '../i18n/useT.js';
import type { TranslationKey } from '../i18n/translations.js';

type BulkBody = { ids: string[]; action: string; folderId?: string };

const LABELS: Record<MailUndoableAction, [TranslationKey, TranslationKey]> = {
  delete: ['undo_deleted_one', 'undo_deleted_many'],
  archive: ['undo_archived_one', 'undo_archived_many'],
  move: ['undo_moved_one', 'undo_moved_many'],
  spam: ['undo_junk_one', 'undo_junk_many'],
};

function label(action: MailUndoableAction, n: number): string {
  const [one, many] = LABELS[action];
  return n === 1 ? translate(one) : fmt(translate(many), { n });
}

/** Runs async jobs with a small concurrency limit. */
async function inBatches<T>(items: T[], size: number, fn: (it: T) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

export function useMailActions() {
  const qc = useQueryClient();

  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['messages'] });
    void qc.invalidateQueries({ queryKey: ['folders'] });
  }, [qc]);

  const bulk = useCallback((body: BulkBody) => api.post('/mail/messages/bulk', body), []);

  const folderIdByName = useCallback((name: string): string | null => {
    const folders = qc.getQueryData<Folder[]>(['folders']) ?? [];
    return folders.find((f) => f.name === name)?.id ?? null;
  }, [qc]);

  /** Permanently deletes (confirmation, no undo). Returns false when cancelled. */
  const deletePermanently = useCallback(async (items: MessageLocation[]): Promise<boolean> => {
    if (items.length === 0) return false;
    if (!window.confirm(fmt(translate('confirm_delete_permanent'), { n: items.length }))) return false;
    try {
      await inBatches(items, 8, (it) => api.delete(`/mail/messages/${it.id}?hard=true`));
      toast.success(translate('deleted_permanent'), { duration: 2000 });
    } catch (err) {
      toastError(err);
    } finally {
      invalidate();
    }
    return true;
  }, [invalidate]);

  /**
   * delete / archive / spam / move with an undo toast. Only messages that
   * actually change folder are part of the undo. Returns false when nothing
   * happened (empty selection or a cancelled confirmation).
   */
  const runWithUndo = useCallback(async (
    action: MailUndoableAction,
    items: MessageLocation[],
    targetFolderId?: string,
  ): Promise<boolean> => {
    let undoable = items;
    if (action === 'delete') {
      const { toTrash, permanent } = splitDelete(items, folderIdByName('Trash'));
      if (permanent.length) {
        const done = await deletePermanently(permanent);
        if (!done && toTrash.length === 0) return false;
      }
      undoable = toTrash;
    } else if (action === 'move') {
      if (!targetFolderId) return false;
      undoable = items.filter((i) => i.folderId !== targetFolderId);
    } else if (action === 'archive') {
      const archive = folderIdByName('Archive');
      undoable = items.filter((i) => i.folderId !== archive);
    } else if (action === 'spam') {
      const junk = folderIdByName('Junk');
      undoable = items.filter((i) => i.folderId !== junk);
    }
    if (undoable.length === 0) return items.length > 0;

    const ids = undoable.map((i) => i.id);
    try {
      await bulk({ ids, action, ...(action === 'move' && targetFolderId ? { folderId: targetFolderId } : {}) });
    } catch (err) {
      toastError(err);
      invalidate();
      return false;
    }
    invalidate();
    // Undo is only offered after the server confirmed the action
    const inboxId = folderIdByName('INBOX');
    showUndoToast({
      message: label(action, ids.length),
      onUndo: async () => {
        try {
          for (const step of planUndo(action, undoable, inboxId)) await bulk(step);
        } finally {
          invalidate();
        }
      },
    });
    return true;
  }, [bulk, deletePermanently, folderIdByName, invalidate]);

  /** read / unread / flag / unflag / pin / unpin (no undo — toggling again reverts). */
  const setState = useCallback(async (action: 'read' | 'unread' | 'flag' | 'unflag' | 'pin' | 'unpin', ids: string[]) => {
    if (ids.length === 0) return;
    try { await bulk({ ids, action }); } catch (err) { toastError(err); } finally { invalidate(); }
  }, [bulk, invalidate]);

  /**
   * Original folders of message ids, looked up in the cached message lists
   * (folder pages and search results); unknown ids fall back to `fallbackFolderId`.
   */
  const locateIds = useCallback((ids: string[], fallbackFolderId: string): MessageLocation[] => {
    const known = new Map<string, string>();
    for (const [, data] of qc.getQueriesData<InfiniteData<MessagesResponse>>({ queryKey: ['messages'] })) {
      for (const page of data?.pages ?? []) {
        for (const m of page.messages ?? []) if (m.folderId && !known.has(m.id)) known.set(m.id, m.folderId);
      }
    }
    return ids.map((id) => ({ id, folderId: known.get(id) ?? fallbackFolderId }));
  }, [qc]);

  return { runWithUndo, deletePermanently, setState, invalidate, locateIds };
}
