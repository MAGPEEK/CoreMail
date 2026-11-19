/**
 * Memory held by the server objects of a session: property values, recipient
 * rows, attachment content and stream buffers. Messages composed or opened in
 * a session live in memory until they are saved, submitted or released, so the
 * session has a byte budget (MapiSession.memoryLimit) checked before anything
 * grows. Shared state (a message reached through several handles) counts once.
 * Synchronization contexts count their decoded ICS state (ics/state.ts).
 * Pure module.
 */
import { stateBytes } from '../ics/state.js';
import type { MessageState, ServerObject } from './state.js';

/** Approximate bytes of one property value. */
export function valueBytes(v: unknown): number {
  if (typeof v === 'string') return v.length * 2;
  if (Buffer.isBuffer(v)) return v.length;
  if (Array.isArray(v)) return v.reduce((n: number, x: unknown) => n + valueBytes(x), 0);
  return 8;
}

function bagBytes(bag: ReadonlyMap<number, unknown>): number {
  let n = 0;
  for (const v of bag.values()) n += 8 + valueBytes(v);
  return n;
}

export function sessionFootprint(objects: Iterable<ServerObject>): number {
  const seen = new Set<object>();
  let total = 0;
  const buffer = (b: Buffer | null): void => {
    if (!b || seen.has(b)) return;
    seen.add(b);
    total += b.length;
  };
  const message = (m: MessageState): void => {
    if (seen.has(m)) return;
    seen.add(m);
    total += bagBytes(m.props);
    for (const r of m.recipients) total += valueBytes(r.email) + valueBytes(r.displayName) + bagBytes(r.props);
    for (const a of m.attachments) {
      total += bagBytes(a.props);
      buffer(a.data);
    }
  };
  for (const o of objects) {
    if (o.kind === 'message' || o.kind === 'attachment') message(o.message);
    else if (o.kind === 'stream') {
      buffer(o.stream.data);
      if (o.stream.target.kind !== 'readonly') message(o.stream.target.message);
    } else if (o.kind === 'syncDownload' || o.kind === 'syncUpload') {
      // an ICS state being uploaded, and the decoded state of the context
      total += (o.sync.stateUpload?.size ?? 0) + stateBytes(o.sync.state);
    }
  }
  return total;
}
