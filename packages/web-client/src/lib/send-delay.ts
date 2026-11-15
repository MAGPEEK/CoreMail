/**
 * Undo send: outgoing mails are held client-side for N seconds before
 * /mail/send is called (OWA "send delay"). Cancelling within the delay means
 * nothing was sent. Framework-free; uses the global timers so tests can fake them.
 */

export const SEND_DELAY_OPTIONS = [0, 5, 10, 20, 30] as const;
export type SendDelaySec = (typeof SEND_DELAY_OPTIONS)[number];
export const DEFAULT_SEND_DELAY_SEC: SendDelaySec = 10;

export function normalizeSendDelay(v: unknown): SendDelaySec {
  const n = Number(v);
  return (SEND_DELAY_OPTIONS as readonly number[]).includes(n) ? (n as SendDelaySec) : DEFAULT_SEND_DELAY_SEC;
}

export type SendState = 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled';

export interface ScheduleOptions<T> {
  delayMs: number;
  send: () => Promise<T>;
  /** Called once per second with the remaining whole seconds (and at the start). */
  onTick?: (remainingSec: number) => void;
  onSent?: (result: T) => void;
  onError?: (err: unknown) => void;
  onCancelled?: () => void;
}

export interface PendingSend {
  id: string;
  readonly state: SendState;
  /** Cancels while still pending. Returns false when sending already started. */
  cancel(): boolean;
  /** Sends immediately (e.g. the page is being closed). Returns false if not pending. */
  flush(): boolean;
}

export function createSendQueue() {
  const pending = new Map<string, PendingSend>();
  const listeners = new Set<(count: number) => void>();
  let seq = 0;
  const notify = () => { for (const l of listeners) l(pending.size); };

  function schedule<T>(o: ScheduleOptions<T>): PendingSend {
    const id = `send-${++seq}`;
    let state: SendState = 'pending';
    let timer: ReturnType<typeof setTimeout> | null = null;
    let ticker: ReturnType<typeof setInterval> | null = null;
    const totalSec = Math.ceil(Math.max(0, o.delayMs) / 1000);
    let elapsedSec = 0;

    const stopTimers = () => {
      if (timer) clearTimeout(timer);
      if (ticker) clearInterval(ticker);
      timer = null; ticker = null;
    };
    const fire = () => {
      if (state !== 'pending') return;
      stopTimers();
      state = 'sending';
      pending.delete(id);
      notify();
      o.send().then(
        (r) => { state = 'sent'; o.onSent?.(r); },
        (err: unknown) => { state = 'failed'; o.onError?.(err); },
      );
    };

    const handle: PendingSend = {
      id,
      get state() { return state; },
      cancel() {
        if (state !== 'pending') return false;
        stopTimers();
        state = 'cancelled';
        pending.delete(id);
        notify();
        o.onCancelled?.();
        return true;
      },
      flush() {
        if (state !== 'pending') return false;
        fire();
        return true;
      },
    };

    if (o.delayMs <= 0) {
      pending.set(id, handle);
      fire();
      return handle;
    }
    pending.set(id, handle);
    notify();
    o.onTick?.(totalSec);
    ticker = setInterval(() => {
      elapsedSec++;
      const left = totalSec - elapsedSec;
      if (left > 0) o.onTick?.(left);
    }, 1000);
    timer = setTimeout(fire, o.delayMs);
    return handle;
  }

  return {
    schedule,
    pendingCount: () => pending.size,
    /** Sends everything that is still waiting (page unload). */
    flushAll(): number {
      let n = 0;
      for (const p of [...pending.values()]) if (p.flush()) n++;
      return n;
    },
    subscribe(fn: (count: number) => void): () => void {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}

export type SendQueue = ReturnType<typeof createSendQueue>;
