/**
 * UID ranges for QRESYNC (RFC 7162): parsing client UID sets into ranges,
 * subtracting known UIDs and formatting (chunked) VANISHED responses.
 * Everything works on ranges, so a set like "1:4294967295" never expands into
 * individual numbers.
 */

/** Inclusive UID range [lo, hi]. */
export type UidRange = [number, number];

/** Largest UID value (RFC 9051 §9 nz-number fits in 32 bits). */
export const MAX_UID = 4_294_967_295;

/**
 * Parses a UID set ("1:5,9,12:*") into sorted, merged ranges. `star` is the
 * value of "*". Returns null when the text is not a sequence set.
 */
export function parseUidRanges(set: string, star: number): UidRange[] | null {
  if (!/^(?:[1-9]\d*|\*)(?::(?:[1-9]\d*|\*))?(?:,(?:[1-9]\d*|\*)(?::(?:[1-9]\d*|\*))?)*$/.test(set)) return null;
  const ranges: UidRange[] = [];
  for (const part of set.split(',')) {
    const [a, b] = part.split(':') as [string, string | undefined];
    const first = a === '*' ? star : Number(a);
    const second = b === undefined ? first : b === '*' ? star : Number(b);
    if (first > MAX_UID || second > MAX_UID) return null;
    ranges.push([Math.min(first, second), Math.max(first, second)]);
  }
  return mergeRanges(ranges);
}

/** Sorts and merges overlapping / adjacent ranges. */
export function mergeRanges(ranges: UidRange[]): UidRange[] {
  const sorted = ranges.filter(([lo, hi]) => lo <= hi).sort((x, y) => x[0] - y[0]);
  const out: UidRange[] = [];
  for (const [lo, hi] of sorted) {
    const last = out[out.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}

/** Restricts ranges to [lo, hi]. */
export function clampRanges(ranges: UidRange[], lo: number, hi: number): UidRange[] {
  const out: UidRange[] = [];
  for (const [a, b] of ranges) {
    const x = Math.max(a, lo);
    const y = Math.min(b, hi);
    if (x <= y) out.push([x, y]);
  }
  return out;
}

/**
 * Removes the UIDs of `exclude` (ascending, unique) from `ranges` (merged).
 * Work and output size are O(ranges + exclude).
 */
export function subtractUids(ranges: UidRange[], exclude: number[]): UidRange[] {
  const out: UidRange[] = [];
  let i = 0;
  for (const [lo, hi] of ranges) {
    let start = lo;
    while (i < exclude.length && (exclude[i] as number) < lo) i++;
    while (i < exclude.length && (exclude[i] as number) <= hi) {
      const u = exclude[i] as number;
      if (u > start) out.push([start, u - 1]);
      start = u + 1;
      i++;
    }
    if (start <= hi) out.push([start, hi]);
  }
  return out;
}

/** Ranges of an ascending list of UIDs. */
export function rangesOf(uids: number[]): UidRange[] {
  return mergeRanges(uids.map((u) => [u, u] as UidRange));
}

/** "1:3,7,9:10" */
export function formatRanges(ranges: UidRange[]): string {
  return ranges.map(([lo, hi]) => (lo === hi ? `${lo}` : `${lo}:${hi}`)).join(',');
}

/** Longest UID set text per VANISHED response line (well below the 8 KiB clients must accept). */
const MAX_SET_TEXT = 4000;

/**
 * Formats ranges as one or more UID set strings of bounded length, so a huge
 * VANISHED (EARLIER) result is split over several responses (RFC 7162 §3.2.10
 * allows any number of VANISHED responses).
 */
export function chunkRanges(ranges: UidRange[], maxText = MAX_SET_TEXT): string[] {
  const out: string[] = [];
  let current = '';
  for (const r of ranges) {
    const part = formatRanges([r]);
    if (current && current.length + 1 + part.length > maxText) {
      out.push(current);
      current = '';
    }
    current = current ? `${current},${part}` : part;
  }
  if (current) out.push(current);
  return out;
}
