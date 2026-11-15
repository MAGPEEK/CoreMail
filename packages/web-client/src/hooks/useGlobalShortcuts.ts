/**
 * App-wide shortcut handlers (layout level): new mail, help, undo, search and
 * the "g" go-to sequences. Pages register more specific handlers on top.
 */
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';
import type { Folder } from '../api/types.js';
import { useUiStore } from '../store/ui.js';
import { useShortcutHandlers, useShortcutManager } from './useShortcuts.js';
import { triggerLatestUndo } from '../components/UndoToast.js';
import { undoLatestSend } from '../components/DelayedSendToast.js';

export const GLOBAL_SEARCH_INPUT_ID = 'global-search-input';

export function useGlobalShortcuts(): void {
  useShortcutManager();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { openCompose, setShortcutHelpOpen, setSelectedFolder, setFilter } = useUiStore();

  const goFolder = (name: string, opts: { flagged?: boolean } = {}) => {
    navigate('/mail');
    void qc.fetchQuery({ queryKey: ['folders'], queryFn: () => api.get<Folder[]>('/mail/folders') })
      .then((folders) => {
        const f = folders.find((x) => x.name === name);
        if (!f) return;
        setSelectedFolder(f.id);
        if (opts.flagged) setFilter('flagged');
      })
      .catch(() => undefined);
  };

  useShortcutHandlers({
    'compose.new': () => { if (useUiStore.getState().composeOpen) return false; openCompose(); return true; },
    help: () => { setShortcutHelpOpen(true); },
    // A mail still waiting in the send delay is the most urgent thing to undo
    undo: () => { if (!undoLatestSend()) triggerLatestUndo(); },
    search: () => {
      const el = document.getElementById(GLOBAL_SEARCH_INPUT_ID) as HTMLInputElement | null;
      if (!el) return false;
      el.focus();
      el.select();
      return true;
    },
    'go.inbox': () => goFolder('INBOX'),
    'go.flagged': () => goFolder('INBOX', { flagged: true }),
    'go.sent': () => goFolder('Sent'),
    'go.drafts': () => goFolder('Drafts'),
    'go.all': () => goFolder('Archive'),
    'go.contacts': () => { navigate('/contacts'); },
    'go.calendar': () => { navigate('/calendar'); },
  });
}
