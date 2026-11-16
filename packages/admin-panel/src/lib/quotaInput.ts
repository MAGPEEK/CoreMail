/** v8.1: GB text input ↔ bytes for the mailbox quota levels (empty = server default). */
const GB = 1024 ** 3;

export function gbInputToBytes(v: string): number | null {
  const s = v.trim().replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * GB) : null;
}

export function bytesToGbInput(b: number | null | undefined): string {
  return b === null || b === undefined ? '' : String(Math.round((b / GB) * 100) / 100);
}

/** True for an empty field (= server default) or a non-negative number; false for a typo. */
export function gbInputValid(v: string): boolean {
  return v.trim() === '' || gbInputToBytes(v) !== null;
}

/** Mailbox size presets; 0 = unlimited (the server's convention for quotaBytes). */
export const QUOTA_PRESETS: readonly number[] = [
  1 * GB, 2 * GB, 5 * GB, 10 * GB, 25 * GB, 50 * GB, 100 * GB, 0,
];

/**
 * Options for the quota select: the presets plus the mailbox's current value when it
 * is not a preset (e.g. set via CLI), so the select shows — and keeps — the real value.
 */
export function quotaOptions(current?: number | null): number[] {
  const opts = [...QUOTA_PRESETS];
  if (typeof current === 'number' && current >= 0 && !opts.includes(current)) {
    const unlimited = opts.pop()!;
    opts.push(current);
    opts.sort((a, b) => a - b);
    opts.push(unlimited);
  }
  return opts;
}

/** "5 GB", "1.5 GB" — the label of a quota option; 0 → null (caller shows "Unlimited"). */
export function quotaLabel(bytes: number): string | null {
  if (bytes <= 0) return null;
  return `${Math.round((bytes / GB) * 100) / 100} GB`;
}
