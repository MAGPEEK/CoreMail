/**
 * 9.4: debounced writer for preference changes. Changes are merged and sent as
 * one PATCH after `delayMs` of quiet; a failed send keeps its changes (merged
 * under newer ones) and is retried after `retryMs`. `flush()` sends at once
 * (page hidden / logout). Until `isReady()` (the server copy was loaded once)
 * nothing is sent — changes wait and are retried. Framework-free; uses the
 * global timers so tests can fake them.
 */
import { isEmptyPatch, mergePatches, type PreferencesPatch } from './preferences.ts';

export interface PatchQueueOptions {
  delayMs: number;
  retryMs: number;
  send: (patch: PreferencesPatch) => Promise<void>;
  /** false → keep the changes and try again after `retryMs` (default: always ready). */
  isReady?: () => boolean;
}

export class PatchQueue {
  private pending: PreferencesPatch = {};
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private readonly opts: PatchQueueOptions;

  constructor(opts: PatchQueueOptions) {
    this.opts = opts;
  }

  /** Changes waiting to be sent (also while a send is running). */
  get hasPending(): boolean {
    return !isEmptyPatch(this.pending) || this.inFlight !== null;
  }

  /** Changes not handed to `send` yet. */
  get pendingPatch(): PreferencesPatch {
    return this.pending;
  }

  push(patch: PreferencesPatch): void {
    if (isEmptyPatch(patch)) return;
    this.pending = mergePatches(this.pending, patch);
    this.schedule(this.opts.delayMs);
  }

  /** Sends what is pending now; resolves when that send finished (or failed). */
  async flush(): Promise<void> {
    this.clearTimer();
    if (this.inFlight) await this.inFlight;
    if (isEmptyPatch(this.pending)) return;
    if (this.opts.isReady && !this.opts.isReady()) {
      this.schedule(this.opts.retryMs);
      return;
    }
    const batch = this.pending;
    this.pending = {};
    this.inFlight = this.opts.send(batch)
      .catch(() => {
        // keep the failed changes; newer ones (already in `pending`) win
        this.pending = mergePatches(batch, this.pending);
        this.schedule(this.opts.retryMs);
      })
      .finally(() => { this.inFlight = null; });
    await this.inFlight;
  }

  stop(): void {
    this.clearTimer();
    this.pending = {};
  }

  private schedule(ms: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, ms);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
