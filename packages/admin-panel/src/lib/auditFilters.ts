/**
 * Date filters of the audit log (BCP). An `<input type="date">` value is a
 * day in the admin's local time zone: "from" starts at local 00:00, "to" ends
 * at local 23:59:59.999 — both sent as ISO (UTC) instants. Invalid input → null.
 * Pure, unit-tested.
 */
function localDay(d: string, end: boolean): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return null;
  const date = end
    ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999)
    : new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export const dayStartIso = (d: string): string | null => localDay(d, false);
export const dayEndIso = (d: string): string | null => localDay(d, true);

/** `hmac-sha256=<hex>` → the value to show / copy (the verify route accepts both forms). */
export function signatureFromHeader(h: string | null): string | null {
  const v = (h ?? '').trim();
  return /^(hmac-sha256=)?[0-9a-f]{64}$/i.test(v) ? v : null;
}
