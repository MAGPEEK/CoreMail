/**
 * 9.4: main-window side of the compose windows this tab opened
 * (lib/composePopout.ts): `send` → answered with `accepted`, then the saved
 * draft is sent here with the undo hold (toast with "Rückgängig"; undo reopens
 * it inline); `returned` → the window was closed without sending, the draft
 * goes back into the tab strip. Windows opened before a reload of this window
 * are recognised by their opener. Both reopen the draft in the mailbox it was
 * written in (shared / delegated: sender choice and signature as before).
 */
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUiPrefs, useUiStore } from '../store/ui.js';
import { acceptedMessage, acceptsMessage, messageMailbox, parsePopoutMessage } from '../lib/composePopout.js';
import { sendDraft, unsendDraft } from '../lib/draft-api.js';
import { queueHeldSend } from '../components/DelayedSendToast.js';
import { forgetPopout, isOwnPopout } from '../components/compose/popoutChannel.js';

export function usePopoutBridge(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const invalidate = () => {
      void qc.invalidateQueries({ queryKey: ['messages'] });
      void qc.invalidateQueries({ queryKey: ['folders'] });
    };
    const onMessage = (e: MessageEvent) => {
      if (!acceptsMessage(e.origin, window.location.origin, isOwnPopout(e.source))) return;
      const source = e.source as Window;
      const msg = parsePopoutMessage(e.data);
      if (!msg || msg.type === 'accepted') return;
      const mailbox = messageMailbox(msg);
      if (msg.type === 'returned') {
        forgetPopout(source);
        useUiStore.getState().openCompose({ mode: 'new', draftId: msg.draftId, subject: msg.subject, mailbox }, { background: true });
        return;
      }
      forgetPopout(source);
      source.postMessage(acceptedMessage(msg.draftId), window.location.origin);
      const delaySec = useUiPrefs.getState().sendDelaySec;
      queueHeldSend({
        delaySec,
        start: async () => {
          await sendDraft(msg.draftId, {
            undoDelaySec: delaySec,
            ...(msg.requestReceipt ? { requestReceipt: true } : {}),
            ...(msg.requestDeliveryReceipt ? { requestDeliveryReceipt: true } : {}),
          });
          return msg.draftId;
        },
        undo: (id) => unsendDraft(id),
        reopenAfterUndo: (id) => ({ mode: 'new', draftId: id, mailbox }),
        reopenOnError: () => ({ mode: 'new', draftId: msg.draftId, mailbox }),
        onSent: invalidate,
      });
      setTimeout(invalidate, 1500);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [qc]);
}
