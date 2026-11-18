/**
 * 9.4: per-draft state that must outlive the compose component — a draft in the
 * tab strip is not mounted, but its autosave (and the draft id it holds) keeps
 * running, and logout still has to save it. One entry per open draft tab,
 * created on first use, released when the tab closes. Pure — unit-tested with
 * `node --test`.
 */

export interface RuntimeRegistry<R> {
  get(key: string): R | undefined;
  /** The entry of `key`, created with `make` on first use. */
  ensure(key: string, make: () => R): R;
  /** Removes the entry and runs its release hook; returns it (undefined when unknown). */
  release(key: string): R | undefined;
  keys(): string[];
}

export function createRuntimeRegistry<R>(onRelease: (entry: R, key: string) => void = () => undefined): RuntimeRegistry<R> {
  const entries = new Map<string, R>();
  return {
    get: (key) => entries.get(key),
    ensure(key, make) {
      let entry = entries.get(key);
      if (!entry) {
        entry = make();
        entries.set(key, entry);
      }
      return entry;
    },
    release(key) {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      entries.delete(key);
      onRelease(entry, key);
      return entry;
    },
    keys: () => [...entries.keys()],
  };
}
