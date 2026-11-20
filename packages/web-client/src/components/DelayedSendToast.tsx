/**
 * Undo send ("send delay") with a server-side hold: the compose window
 * saves the draft and hands it to `queueHeldSend()`, which asks the server to
 * send it after the configured delay and shows a countdown toast with "Undo".
 * The server keeps the mail as a delayed job, so it is sent even when the tab
 * is closed or the user signs out (the toast says so). Undo withdraws the job
 * and reopens the draft; a failed send reopens the mail with everything the
 * user wrote.
 *
 * While a send is still starting or held, closing the tab shows the browser's
 * "leave page?" warning (the Undo option would be lost — the mail is not).
 */
import { useEffect } from 'react';
import toast from 'react-hot-toast';
import { Send, Undo2 } from 'lucide-react';
import { createSendQueue, type PendingSend } from '../lib/send-delay.js';
import { translate, fmt } from '../i18n/useT.js';
import { useUiStore, type ComposeContext } from '../store/ui.js';
import { toastError } from '../lib/errors.js';

const sendQueue = createSendQueue();

interface HeldSendOptions<T> {
  delaySec: number;
  /** Saves the draft and asks the server to send it after the delay. */
  start: () => Promise<T>;
  /** Withdraws the held send; false = too late. */
  undo: (started: T) => Promise<boolean>;
  /** Compose context to reopen after an undo. */
  reopenAfterUndo: (started: T) => ComposeContext;
  /** Compose context to reopen when the send failed (incl. `restore` snapshot). */
  reopenOnError: () => ComposeContext;
  onSent?: (started: T) => void;
}

/** 9.4: a mail being written is never replaced — the reopened one waits in the draft tab strip. */
function reopenCompose(ctx: ComposeContext): void {
  const ui = useUiStore.getState();
  const background = ui.compose.activeKey !== null;
  ui.openCompose(ctx, { background });
  if (background) toast(translate('send_reopened_in_strip'), { duration: 5000 });
}

function CountdownToast({ visible, seconds, onUndo }: {
  visible: boolean; seconds: number; onUndo: () => void;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-center gap-3 px-4 py-2.5 bg-surface text-fg border border-line rounded-md shadow-lg text-sm ${visible ? '' : 'opacity-0'}`}
      style={{ minWidth: 300, maxWidth: 420 }}
    >
      <Send size={14} className="text-accent-fg shrink-0" aria-hidden="true" />
      <span className="flex-1">
        <span className="tabular-nums block">{fmt(translate('send_sending_in'), { n: seconds })}</span>
        <span className="block text-[11px] text-fg-subtle">{translate('send_server_hold_hint')}</span>
      </span>
      <button onClick={onUndo} aria-keyshortcuts="Z" className="font-semibold text-accent-fg hover:underline inline-flex items-center gap-1 shrink-0">
        <Undo2 size={13} aria-hidden="true" /> {translate('undo')}
      </button>
    </div>
  );
}

/**
 * Hands the saved draft to the server with an undo hold of `delaySec` seconds
 * (0 = immediately, no toast). Returns the pending handle.
 */
export function queueHeldSend<T>(o: HeldSendOptions<T>): PendingSend {
  const toastId = `delayed-send-${Math.random().toString(36).slice(2)}`;
  let handle: PendingSend | null = null;
  const render = (seconds: number) => toast.custom((t) => (
    <CountdownToast visible={t.visible} seconds={seconds} onUndo={() => { handle?.cancel(); }} />
  ), { id: toastId, duration: Infinity });

  handle = sendQueue.schedule({
    delayMs: Math.max(0, o.delaySec) * 1000,
    start: o.start,
    undo: o.undo,
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
      reopenCompose(o.reopenOnError());
    },
    onUndone: (r) => {
      toast.dismiss(toastId);
      toast(translate('send_undone'), { duration: 3000 });
      reopenCompose(o.reopenAfterUndo(r));
    },
    onTooLate: (r) => {
      toast.dismiss(toastId);
      toast(translate('send_too_late'), { duration: 4000 });
      o.onSent?.(r);
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

/** Layout hook: warn before closing the tab while a send can still be undone. */
export function useSendGuard(): void {
  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (sendQueue.pendingCount() === 0) return;
      e.preventDefault();
      // Legacy browsers need returnValue set to show the dialog
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { window.removeEventListener('beforeunload', beforeUnload); };
  }, []);
}
