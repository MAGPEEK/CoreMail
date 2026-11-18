/**
 * 9.4: keeps the address bar and the mail view in step (lib/mailLinks.ts).
 *  - URL → view: opening a link, back/forward, the pre-9.4 `?mailbox=` form.
 *  - view → URL: selecting a mailbox/folder/message pushes a history entry; the
 *    automatic INBOX selection replaces the bare /mail entry instead.
 * Both directions read the store directly (not render values), so an update in
 * one direction never bounces back.
 */
import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useUiStore, useUiPrefs } from '../store/ui.js';
import { mailPath, parseMailPath, sameMailLocation, type MailLocation } from '../lib/mailLinks.js';
import { isForeign, mailboxKey, parseMailboxKey } from '../lib/mailboxContext.js';

function storeLocation(): MailLocation {
  const s = useUiStore.getState();
  return { mailbox: s.activeMailbox, folderId: s.selectedFolderId, messageId: s.selectedMessageId };
}

/** Search part without the pre-9.4 `mailbox` parameter. */
function searchWithoutMailbox(search: string): string {
  const params = new URLSearchParams(search);
  params.delete('mailbox');
  const s = params.toString();
  return s ? `?${s}` : '';
}

export function useMailDeepLink(): void {
  const location = useLocation();
  const navigate = useNavigate();
  const { activeMailbox, selectedFolderId, selectedMessageId } = useUiStore();
  const setMailboxExpanded = useUiPrefs((s) => s.setMailboxExpanded);

  // URL → view
  useEffect(() => {
    const parsed = parseMailPath(location.pathname);
    if (!parsed) return;
    const legacy = new URLSearchParams(location.search).get('mailbox');
    const target: MailLocation = legacy && !parsed.folderId ? { ...parsed, mailbox: parseMailboxKey(legacy) } : parsed;
    const s = useUiStore.getState();
    const current = storeLocation();
    if (mailboxKey(target.mailbox) !== mailboxKey(current.mailbox)) {
      if (target.folderId) s.setSelectedFolder(target.folderId, 'tree', target.mailbox);
      else s.setActiveMailbox(target.mailbox);
    } else if (target.folderId && target.folderId !== current.folderId) {
      s.setSelectedFolder(target.folderId, 'tree', target.mailbox);
    }
    // a bare /mail keeps the current selection (search links, app rail)
    if (target.folderId && target.messageId !== useUiStore.getState().selectedMessageId) {
      s.setSelectedMessage(target.messageId);
    }
    if (isForeign(target.mailbox)) setMailboxExpanded(mailboxKey(target.mailbox), true);
  }, [location.pathname, location.search, setMailboxExpanded]);

  // view → URL
  useEffect(() => {
    const current = storeLocation();
    const shown = parseMailPath(location.pathname);
    if (shown && sameMailLocation(shown, current) && !new URLSearchParams(location.search).has('mailbox')) return;
    // the folder-less entry (/mail, /mail/<mailbox>) is the automatic INBOX choice → replace
    const replace = !shown?.folderId;
    navigate(`${mailPath(current.mailbox, current.folderId, current.messageId)}${searchWithoutMailbox(location.search)}`, { replace });
    // render values only trigger the effect; the store is read inside
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMailbox, selectedFolderId, selectedMessageId]);
}
