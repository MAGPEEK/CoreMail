/**
 * Undo send (OWA "send delay") with a server-side hold (v8.x).
 *
 * Sending saves the draft and asks the server to send it after N seconds
 * (POST /mail/drafts/:id/send { undoDelaySec }); the server keeps it as a
 * delayed outbound job, so the mail goes out even when the tab is closed or the
 * user signs out. "Undo" within the delay withdraws the job
 * (POST /mail/drafts/:id/unsend) and the draft is reopened; once the server has
 * started sending, undo reports "too late".
 *
 * State machine per send:
 *   starting ──start() ok──▶ held ──delay over──▶ sent
 *      │  └─start() fails──▶ failed
 *      └─cancel()─▶ (undo requested; runs as soon as start() resolved)
 *   held ──cancel()──▶ undoing ──undo() true──▶ undone
 *                               └─undo() false / error──▶ sent (too late)
 * Framework-free; uses the global timers so tests can fake them.
 */

export const SEND_DELAY_OPTIONS = [0, 5, 10, 20, 30] as const;
export type SendDelaySec = (typeof SEND_DELAY_OPTIONS)[number];
export const DEFAULT_SEND_DELAY_SEC: SendDelaySec = 10;

export function normalizeSendDelay(v: unknown): SendDelaySec {
  const n = Number(v);
  return (SEND_DELAY_OPTIONS as readonly number[]).includes(n) ? (n as SendDelaySec) : DEFAULT_SEND_DELAY_SEC;
}

export type SendState = 'starting' | 'held' | 'undoing' | 'sent' | 'failed' | 'undone';

export interface ScheduleOptions<T> {
  delayMs: number;
  /** Saves the draft and hands it to the server with the hold (resolves when accepted). */
  start: () => Promise<T>;
  /** Withdraws the held send on the server; false (or a rejection) = too late. */
  undo: (started: T) => Promise<boolean>;
  /** Called once per second with the remaining whole seconds (and at the start). */
  onTick?: (remainingSec: number) => void;
  /** The hold is over (or delay 0 and the server accepted): the server sends. */
  onSent?: (started: T) => void;
  onError?: (err: unknown) => void;
  onUndone?: (started: T) => void;
  onTooLate?: (started: T) => void;
}

export interface PendingSend {
  id: string;
  readonly state: SendState;
  /** Requests undo while starting/held. Returns false when the delay is already over. */
  cancel(): boolean;
}

export function createSendQueue() {
  const pending = new Map<string, PendingSend>();
  const listeners = new Set<(count: number) => void>();
  let seq = 0;
  const notify = () => { for (const l of listeners) l(pending.size); };

  function schedule<T>(o: ScheduleOptions<T>): PendingSend {
    const id = `send-${++seq}`;
    let state: SendState = 'starting';
    let started: { value: T } | null = null;
    let undoRequested = false;
    let delayOver = o.delayMs <= 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let ticker: ReturnType<typeof setInterval> | null = null;
    const totalSec = Math.ceil(Math.max(0, o.delayMs) / 1000);
    let elapsedSec = 0;

    const stopTimers = () => {
      if (timer) clearTimeout(timer);
      if (ticker) clearInterval(ticker);
      timer = null; ticker = null;
    };
    const finish = (next: SendState) => {
      stopTimers();
      state = next;
      if (pending.delete(id)) notify();
    };
    const markSent = () => {
      if (!started || (state !== 'held')) return;
      finish('sent');
      o.onSent?.(started.value);
    };
    const runUndo = () => {
      if (!started) return;
      state = 'undoing';
      stopTimers();
      const s = started.value;
      o.undo(s).then(
        (ok) => {
          if (ok) { finish('undone'); o.onUndone?.(s); } else { finish('sent'); o.onTooLate?.(s); }
        },
        () => { finish('sent'); o.onTooLate?.(s); },
      );
    };

    const handle: PendingSend = {
      id,
      get state() { return state; },
      cancel() {
        if (state === 'starting' && !delayOver) { undoRequested = true; return true; }
        if (state === 'held' && !delayOver) { runUndo(); return true; }
        return false;
      },
    };

    pending.set(id, handle);
    notify();
    if (o.delayMs > 0) {
      o.onTick?.(totalSec);
      ticker = setInterval(() => {
        elapsedSec++;
        const left = totalSec - elapsedSec;
        if (left > 0) o.onTick?.(left);
      }, 1000);
      timer = setTimeout(() => {
        delayOver = true;
        if (ticker) clearInterval(ticker);
        ticker = null;
        markSent();          // when start() is still running, it completes the send
      }, o.delayMs);
    }

    o.start().then(
      (value) => {
        started = { value };
        if (undoRequested) { runUndo(); return; }
        state = 'held';
        if (delayOver) markSent();
      },
      (err: unknown) => {
        finish('failed');
        o.onError?.(err);
      },
    );
    return handle;
  }

  return {
    schedule,
    /** Sends still starting or held (beforeunload warning: undo would be lost). */
    pendingCount: () => pending.size,
    subscribe(fn: (count: number) => void): () => void {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}

export type SendQueue = ReturnType<typeof createSendQueue>;
