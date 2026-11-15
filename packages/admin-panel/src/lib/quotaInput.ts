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
