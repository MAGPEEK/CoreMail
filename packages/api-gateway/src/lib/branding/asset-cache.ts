/**
 * Small in-memory LRU for public branding assets (9.3). Keys are the
 * content-addressed file names (`<sha256>.<ext>`), so a cached body can never
 * be stale; it only saves object-store reads when a client floods
 * `/branding/assets/<file>?<cache-buster>`. Bounded by entry count and total
 * bytes; an object larger than the byte budget is not cached. Cleared on every
 * branding change (state.ts), so a removed asset stops being served here too.
 */
export class AssetLru {
  private readonly map = new Map<string, Buffer>();
  private total = 0;

  constructor(readonly maxEntries = 16, readonly maxBytes = 8 * 1024 * 1024) {}

  get(key: string): Buffer | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v); // most recently used last
    return v;
  }

  set(key: string, value: Buffer): void {
    this.delete(key);
    if (value.length > this.maxBytes) return;
    this.map.set(key, value);
    this.total += value.length;
    while (this.map.size > this.maxEntries || this.total > this.maxBytes) {
      const oldest = this.map.keys().next().value as string;
      this.delete(oldest);
    }
  }

  delete(key: string): void {
    const v = this.map.get(key);
    if (v === undefined) return;
    this.map.delete(key);
    this.total -= v.length;
  }

  clear(): void {
    this.map.clear();
    this.total = 0;
  }

  get size(): number { return this.map.size; }
  get bytes(): number { return this.total; }
}

/** The process-wide cache used by GET /branding/assets/:file. */
export const brandingAssetCache = new AssetLru();
