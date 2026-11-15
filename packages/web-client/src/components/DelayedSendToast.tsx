/**
 * Undo send (OWA "send delay"): the compose window hands the finished mail to
 * `queueDelayedSend()`, which holds it client-side for the configured delay and
 * shows a countdown toast with "Undo" / "Send now". Undo reopens the compose
 * window with the full content (recipients, subject, body, attachments).
 *
 * While a mail is waiting, closing the tab triggers the browser's "leave page?"
 * warning; if the user leaves anyway, the waiting mails are sent right away on
 * `pagehide` (keepalive request — browsers cap keepalive bodies at 64 KB, so a
 * large mail can still be lost; the warning comes first for that reason).
 */
import { useEffect } from 'react';
import toast from 'react-hot-toast';
import { Send, Undo2 } from 'lucide-react';
import { createSendQueue, type PendingSend } from '../lib/send-delay.js';
import { translate, fmt } from '../i18n/useT.js';
import { useUiStore, type ComposeContext } from '../store/ui.js';
import { toastError } from '../lib/errors.js';

const sendQueue = createSendQueue();
let unloading = false;

/** True while the page is being unloaded (sends then use `keepalive`). */
export function isUnloading(): boolean {
  return unloading;
}

interface DelayedSendOptions<T> {
  delaySec: number;
  /** Performs the real POST /mail/send. */
  send: () => Promise<T>;
  /** Compose context incl. `restore` snapshot to reopen on undo / failure. */
  reopen: ComposeContext;
  onSent?: (r: T) => void;
}

function reopenCompose(ctx: ComposeContext): void {
  const ui = useUiStore.getState();
  if (!ui.composeOpen) { ui.openCompose(ctx); return; }
  // Never overwrite a mail being written — reopen once that window is closed
  toast(translate('send_compose_busy'), { duration: 5000 });
  const unsub = useUiStore.subscribe((s) => {
    if (s.composeOpen) return;
    unsub();
    s.openCompose(ctx);
  });
}

function CountdownToast({ visible, seconds, onUndo, onSendNow }: {
  visible: boolean; seconds: number; onUndo: () => void; onSendNow: () => void;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-center gap-3 px-4 py-2.5 bg-gray-900 text-white rounded-md shadow-lg text-sm ${visible ? '' : 'opacity-0'}`}
      style={{ minWidth: 300 }}
    >
      <Send size={14} className="text-blue-300 shrink-0" aria-hidden="true" />
      <span className="flex-1 tabular-nums">{fmt(translate('send_sending_in'), { n: seconds })}</span>
      <button onClick={onUndo} aria-keyshortcuts="Z" className="font-semibold text-blue-300 hover:text-blue-200 inline-flex items-center gap-1">
        <Undo2 size={13} aria-hidden="true" /> {translate('undo')}
      </button>
      <button onClick={onSendNow} className="text-gray-300 hover:text-white text-xs">
        {translate('send_now')}
      </button>
    </div>
  );
}

/**
 * Sends after `delaySec` seconds unless undone (0 = immediately, no toast).
 * Returns the pending handle.
 */
export function queueDelayedSend<T>(o: DelayedSendOptions<T>): PendingSend {
  const toastId = `delayed-send-${Math.random().toString(36).slice(2)}`;
  let handle: PendingSend | null = null;
  const render = (seconds: number) => toast.custom((t) => (
    <CountdownToast
      visible={t.visible}
      seconds={seconds}
      onUndo={() => { handle?.cancel(); }}
      onSendNow={() => { handle?.flush(); }}
    />
  ), { id: toastId, duration: Infinity });

  handle = sendQueue.schedule({
    delayMs: Math.max(0, o.delaySec) * 1000,
    send: o.send,
    onTick: (s) => { render(s); },
    onSent: (r) => {
      toast.dismiss(toastId);
      toast.success(translate('send_sent'));
      o.onSent?.(r);
    },
    onError: (err) => {
      toast.dismiss(toastId);
      toastError(err);
      // Do not lose the mail: reopen it with everything the user wrote
      toast.error(translate('send_failed_reopened'));
      reopenCompose(o.reopen);
    },
    onCancelled: () => {
      toast.dismiss(toastId);
      toast(translate('send_undone'), { duration: 3000 });
      reopenCompose(o.reopen);
    },
  });
  if (o.delaySec > 0) registerUndo(handle);
  return handle;
}

// Keyboard undo (z) should also cancel the newest waiting send.
const undoableSends: PendingSend[] = [];
function registerUndo(h: PendingSend): void {
  undoableSends.push(h);
}
/** Cancels the newest still-waiting send; false if none. */
export function undoLatestSend(): boolean {
  while (undoableSends.length) {
    const h = undoableSends.pop()!;
    if (h.cancel()) return true;
  }
  return false;
}

/** Layout hook: warn before closing the tab with mails waiting, flush on pagehide. */
export function useSendGuard(): void {
  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (sendQueue.pendingCount() === 0) return;
      e.preventDefault();
      // Legacy browsers need returnValue set to show the dialog
      e.returnValue = '';
    };
    const pageHide = () => {
      if (sendQueue.pendingCount() === 0) return;
      unloading = true;
      sendQueue.flushAll();
    };
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('pagehide', pageHide);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('pagehide', pageHide);
    };
  }, []);
}
