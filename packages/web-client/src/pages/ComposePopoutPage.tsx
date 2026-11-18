/**
 * 9.4: a draft in its own window (/compose/<draftId>, opened by "In neuem
 * Fenster öffnen"). Loads the server draft into the compose area; sending hands
 * the mail to the main window (undo toast there), closing (✕, Esc) saves and
 * returns the draft to the main window's tab strip. Closing the browser window
 * with unsaved changes asks first and saves; the draft returns as well.
 * The window answers "is this draft open?" for every id the draft had (the
 * main window then brings it to the front instead of opening it inline) and
 * keeps its address on the current id (a reload loads the current version).
 * The mailbox the draft is written in comes with the address (`?mailbox=`): a
 * shared / delegated mailbox keeps its sender choice and signature defaults.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { ComposePane, type ComposeOutcome } from '../components/compose/ComposePane.js';
import { composeRuntimes } from '../components/compose/composeRuntime.js';
import { postToOpener, serveDraftPresence } from '../components/compose/popoutChannel.js';
import { useSendGuard } from '../components/DelayedSendToast.js';
import { useUiStore } from '../store/ui.js';
import { isDraftId, popoutMailbox, popoutUrl, returnedMessage } from '../lib/composePopout.js';
import { hasPendingChanges } from '../lib/composeRules.js';
import { tabTitle } from '../lib/composeTabs.js';
import { mailboxKey, parseMailboxKey, type MailboxRef } from '../lib/mailboxContext.js';
import { useT } from '../i18n/useT.js';

type Done = 'saved' | 'sending' | null;

/** Saves on browser close (asks first) and returns the draft to the main window. */
function useWindowCloseGuard(draftId: string, mailbox: MailboxRef): void {
  useEffect(() => {
    const live = () => {
      const key = useUiStore.getState().compose.activeKey;
      const rt = key ? composeRuntimes.get(key) : undefined;
      return rt && !rt.finished ? { key, rt } : null;
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const cur = live();
      if (!cur || !hasPendingChanges(cur.rt.saver.status)) return;
      void cur.rt.saver.flush().catch(() => undefined);
      e.preventDefault();
      e.returnValue = '';
    };
    const onPageHide = () => {
      const cur = live();
      if (!cur) return;
      const tab = useUiStore.getState().compose.tabs.find((t) => t.key === cur.key);
      postToOpener(returnedMessage(cur.rt.saver.draftId ?? draftId, tab?.subject ?? '', mailbox));
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [draftId, mailbox]);
}

/** Presence for every id the draft had; the address follows the current id (and keeps the mailbox). */
function useDraftWindowIdentity(openedId: string, currentId: string | null | undefined, mailbox: MailboxRef): void {
  const held = useRef(new Set<string>([openedId]));
  useEffect(() => serveDraftPresence(() => held.current), []);
  useEffect(() => {
    if (!currentId || !isDraftId(currentId)) return;
    held.current.add(currentId);
    const url = popoutUrl(currentId, mailbox);
    if (window.location.pathname + window.location.search !== url) window.history.replaceState(window.history.state, '', url);
  }, [currentId, mailbox]);
}

export function ComposePopoutPage() {
  const t = useT();
  const { draftId = '' } = useParams<{ draftId: string }>();
  const { search } = useLocation();
  // one ref per mailbox key (stable across renders; invalid keys are the own mailbox)
  const mailboxParam = mailboxKey(popoutMailbox(search));
  const mailbox = useMemo(() => parseMailboxKey(mailboxParam), [mailboxParam]);
  const valid = isDraftId(draftId);
  const activeKey = useUiStore((s) => s.compose.activeKey);
  const subject = useUiStore((s) => s.compose.tabs.find((x) => x.key === s.compose.activeKey)?.subject ?? '');
  const currentId = useUiStore((s) => s.compose.tabs.find((x) => x.key === s.compose.activeKey)?.draftId);
  const [done, setDone] = useState<Done>(null);
  useSendGuard();
  useWindowCloseGuard(draftId, mailbox);
  useDraftWindowIdentity(draftId, currentId, mailbox);

  useEffect(() => {
    // the compose opens in the mailbox it was written in (sender choice, signature defaults)
    if (valid) useUiStore.getState().openCompose({ mode: 'new', draftId, mailbox });
  }, [draftId, valid, mailbox]);

  useEffect(() => {
    document.title = tabTitle(subject, t('compose_new_message'));
  }, [subject, t]);

  const onDone = (o: ComposeOutcome) => {
    if (o.kind === 'closed' && o.draftId) postToOpener(returnedMessage(o.draftId, o.subject, mailbox));
    setDone(o.kind === 'sent' ? 'sending' : 'saved');
    // a window opened by the webmail can close itself; one opened by hand shows the note
    if (o.kind !== 'sent') window.close();
  };

  if (valid && activeKey) {
    return (
      <main className="h-full flex flex-col bg-surface">
        <ComposePane key={activeKey} tabKey={activeKey} variant="window" onDone={onDone} />
      </main>
    );
  }
  return (
    <main className="h-full flex items-center justify-center bg-canvas p-6">
      <div role="status" className="text-center space-y-3 max-w-sm">
        <p className="text-sm text-fg">
          {!valid ? t('compose_window_invalid') : done === 'sending' ? t('compose_window_sending') : done === 'saved' ? t('compose_window_done') : ''}
        </p>
        <Link to="/mail" className="btn-secondary text-xs inline-flex">{t('compose_window_back')}</Link>
      </div>
    </main>
  );
}
