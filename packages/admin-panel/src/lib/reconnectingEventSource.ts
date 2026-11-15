/**
 * EventSource that reconnects itself with exponential backoff and builds the
 * URL anew for every attempt — the access token rotates (refresh), so a URL
 * captured once would keep reconnecting with an expired token. The browser's
 * built-in auto-reconnect reuses the original URL, therefore the connection is
 * closed on error and reopened here. No imports — unit-tested with `node --test`.
 */

export interface EventSourceLike {
  addEventListener(type: string, listener: (ev: { data?: unknown }) => void): void;
  close(): void;
  onerror: ((ev: unknown) => void) | null;
  onopen: ((ev: unknown) => void) | null;
}

export interface ReconnectingOptions {
  /** URL for the next attempt, or null when no credential is available (retry later) */
  url: () => string | null;
  /** Event name → handler */
  handlers: Record<string, (ev: { data?: unknown }) => void>;
  /** Injection seams for tests */
  createEventSource?: (url: string) => EventSourceLike;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/** Backoff for attempt n (0-based): base·2ⁿ, capped at max. */
export function reconnectDelay(attempt: number, baseMs = 1000, maxMs = 30_000): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, Math.min(attempt, 30)));
}

/** Opens the stream; returns a function that closes it for good. */
export function openReconnectingEventSource(opts: ReconnectingOptions): () => void {
  const create = opts.createEventSource ?? ((url: string) => new EventSource(url) as unknown as EventSourceLike);
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const base = opts.baseDelayMs ?? 1000;
  const max = opts.maxDelayMs ?? 30_000;

  let es: EventSourceLike | null = null;
  let timer: unknown = null;
  let attempt = 0;
  let closed = false;

  const schedule = () => {
    if (closed) return;
    timer = setTimer(connect, reconnectDelay(attempt++, base, max));
  };

  function connect() {
    timer = null;
    if (closed) return;
    const url = opts.url();
    if (!url) { schedule(); return; }
    const source = create(url);
    es = source;
    source.onopen = () => { attempt = 0; };
    for (const [type, handler] of Object.entries(opts.handlers)) source.addEventListener(type, handler);
    source.onerror = () => {
      if (es !== source) return;
      source.close();
      es = null;
      schedule();
    };
  }

  connect();
  return () => {
    closed = true;
    if (timer !== null) clearTimer(timer);
    es?.close();
    es = null;
  };
}
