/**
 * The Server Object Map of a session (MS-OXCROPS 3.2.5.1): handle → object.
 * Handles are session-wide, never 0xFFFFFFFF (the "unused" marker of handle
 * tables) and not reused while the session lives, so a stale handle is
 * recognised (ecInvalidObject) instead of silently hitting a new object.
 * The number of open objects is capped (memory bound per session).
 */
import { Ec, RopError } from './codes.js';
import type { ServerObject } from '../objects/state.js';

export const HANDLE_UNUSED = 0xffffffff;
export const MAX_OPEN_OBJECTS = 4096;

interface Entry { object: ServerObject; logonId: number }

export class ServerObjectTable {
  private readonly entries = new Map<number, Entry>();
  private next = 1;

  get size(): number { return this.entries.size; }

  add(object: ServerObject, logonId: number): number {
    if (this.entries.size >= MAX_OPEN_OBJECTS) throw new RopError(Ec.OutOfMemory, 'too many open objects in this session');
    if (this.next >= HANDLE_UNUSED) throw new RopError(Ec.OutOfMemory, 'handle space exhausted');
    const handle = this.next++;
    this.entries.set(handle, { object, logonId });
    return handle;
  }

  /** The object of a handle; RopError ecNullObject / ecInvalidObject otherwise. */
  get(handle: number): ServerObject {
    const e = this.entries.get(handle);
    if (e) return e.object;
    throw new RopError(handle > 0 && handle < this.next ? Ec.InvalidObject : Ec.NullObject);
  }

  /** Releases one handle; returns the object (undefined if unknown). */
  release(handle: number): ServerObject | undefined {
    const e = this.entries.get(handle);
    this.entries.delete(handle);
    return e?.object;
  }

  /** Releases every object of a logon (the logon itself included). */
  releaseLogon(logonId: number): ServerObject[] {
    const out: ServerObject[] = [];
    for (const [h, e] of this.entries) {
      if (e.logonId !== logonId) continue;
      this.entries.delete(h);
      out.push(e.object);
    }
    return out;
  }

  /** All open objects (for cleanup when the session ends). */
  all(): ServerObject[] {
    return [...this.entries.values()].map((e) => e.object);
  }
}
