/**
 * The notifications waiting for one session (MS-OXCNOTIF 3.2.5): queued by
 * the change bus, announced by NotificationWait (EventPending), delivered as
 * RopNotify responses at the end of the next Execute response; what does not
 * fit stays queued and a RopPending tells the client to ask again.
 *
 * Entries are keyed (handle + event + object): a newer event with the same
 * key replaces the older one (folder counts, "table changed"), so a burst of
 * changes costs one entry per folder / table. The queue is bounded; beyond the
 * bound the oldest entries go — a TableChanged for the client's views is
 * queued with every change, so a dropped NewMail never leaves a stale view.
 */
import { NOTIFY_HEADER_SIZE, PENDING_SIZE, ropNotify, ropPending } from './data.js';

export const MAX_QUEUED_NOTIFICATIONS = 512;

export interface QueuedNotification {
  /** Coalescing key (same key → replaced). */
  key: string;
  /** Server object handle of the subscription or table the client registered. */
  handle: number;
  logonId: number;
  data: Buffer;
}

export class NotificationQueue {
  private readonly items = new Map<string, QueuedNotification>();
  private readonly waiters = new Set<() => void>();

  get size(): number { return this.items.size; }
  get pending(): boolean { return this.items.size > 0; }

  push(list: readonly QueuedNotification[]): void {
    if (list.length === 0) return;
    for (const n of list) {
      this.items.delete(n.key);
      this.items.set(n.key, n);
      if (this.items.size > MAX_QUEUED_NOTIFICATIONS) this.items.delete(this.items.keys().next().value!);
    }
    for (const wake of [...this.waiters]) wake();
  }

  /** Calls `wake` once when something is queued; returns the cancel function. */
  onPending(wake: () => void): () => void {
    const once = (): void => { this.waiters.delete(once); wake(); };
    this.waiters.add(once);
    return () => { this.waiters.delete(once); };
  }

  /** Drops what was queued for a released handle or logon. */
  drop(match: { handle?: number; logonId?: number }): void {
    for (const [k, n] of this.items) {
      if (n.handle === match.handle || n.logonId === match.logonId) this.items.delete(k);
    }
  }

  /**
   * Removes and encodes the notifications that fit into `room` bytes, in
   * queue order; RopPending follows when some are left (and fits).
   */
  take(room: number): Buffer {
    const parts: Buffer[] = [];
    let used = 0;
    for (const [k, n] of this.items) {
      const size = NOTIFY_HEADER_SIZE + n.data.length;
      if (used + size + PENDING_SIZE > room) break;
      parts.push(ropNotify(n.handle, n.logonId, n.data));
      used += size;
      this.items.delete(k);
    }
    if (this.items.size > 0 && used + PENDING_SIZE <= room) parts.push(ropPending());
    return Buffer.concat(parts);
  }
}
