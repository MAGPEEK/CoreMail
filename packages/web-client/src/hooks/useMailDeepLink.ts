/**
 * 9.4: keeps the address bar and the mail view in step (lib/mailLinks.ts).
 *  - URL → view: opening a link, back/forward, the pre-9.4 `?mailbox=` form and
 *    the notification-click form `/mail?folder=…&message=…` (Web Push).
 *  - view → URL: selecting a mailbox/folder/message pushes a history entry; the
 *    automatic INBOX selection replaces the bare /mail entry instead.
 * Both directions read the store directly (not render values), so an update in
 * one direction never bounces back.
 */
import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useUiStore, useUiPrefs } from '../store/ui.js';
import {
  hasLegacyMailParams, mailLocationFromUrl, mailPath, parseMailPath, sameMailLocation, searchWithoutLegacyMailParams,
  type MailLocation,
} from '../lib/mailLinks.js';
import { isForeign, mailboxKey } from '../lib/mailboxContext.js';

function storeLocation(): MailLocation {
  const s = useUiStore.getState();
  return { mailbox: s.activeMailbox, folderId: s.selectedFolderId, messageId: s.selectedMessageId };
}

export function useMailDeepLink(): void {
  const location = useLocation();
  const navigate = useNavigate();
  const { activeMailbox, selectedFolderId, selectedMessageId } = useUiStore();
  const setMailboxExpanded = useUiPrefs((s) => s.setMailboxExpanded);

  // URL → view
  useEffect(() => {
    const target = mailLocationFromUrl(location.pathname, location.search);
    if (!target) return;
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
    if (shown && sameMailLocation(shown, current) && !hasLegacyMailParams(location.search)) return;
    // the folder-less entry (/mail, /mail/<mailbox>) is the automatic INBOX choice → replace
    const replace = !shown?.folderId;
    navigate(`${mailPath(current.mailbox, current.folderId, current.messageId)}${searchWithoutLegacyMailParams(location.search)}`, { replace });
    // render values only trigger the effect; the store is read inside
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMailbox, selectedFolderId, selectedMessageId]);
}
