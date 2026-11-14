/**
 * Conversions between `<input type="datetime-local">` values (local wall time,
 * "YYYY-MM-DDTHH:mm") and ISO timestamps (UTC). Pure, no imports — unit-tested.
 *
 * `new Date().toISOString().slice(0, 16)` is NOT a datetime-local value: it is UTC
 * and shows a shifted time in every zone except UTC.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** Date → "YYYY-MM-DDTHH:mm" in the browser's local time zone. */
export function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** ISO timestamp (any offset) → datetime-local value; '' for invalid input. */
export function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : toLocalInput(d);
}

/** datetime-local value (local wall time) → ISO timestamp in UTC; '' for invalid input. */
export function localInputToIso(local: string): string {
  // "YYYY-MM-DDTHH:mm" without offset is parsed as local time by the Date constructor
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}
