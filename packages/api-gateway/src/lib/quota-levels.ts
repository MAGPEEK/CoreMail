/**
 * v8.1: pure validation of explicit mailbox quota levels (admin API) —
 * warning ≤ prohibit-send ≤ quota (0 = unlimited quota). Only values given in
 * the request are compared; null/undefined = server default.
 */
export function quotaLevelError(
  warning: number | null | undefined,
  prohibitSend: number | null | undefined,
  quota: number | undefined,
): string | null {
  if (typeof warning === 'number' && typeof prohibitSend === 'number' && warning > prohibitSend) {
    return 'quotaWarningBytes must not exceed quotaProhibitSendBytes';
  }
  if (typeof quota === 'number' && quota > 0) {
    if (typeof prohibitSend === 'number' && prohibitSend > quota) return 'quotaProhibitSendBytes must not exceed quotaBytes';
    if (typeof warning === 'number' && warning > quota) return 'quotaWarningBytes must not exceed quotaBytes';
  }
  return null;
}

export interface QuotaLevelPatch {
  quotaBytes?: number | undefined;
  quotaWarningBytes?: number | null | undefined;
  quotaProhibitSendBytes?: number | null | undefined;
}
export interface StoredQuotaLevels {
  quotaBytes?: bigint | number | null | undefined;
  quotaWarningBytes?: bigint | number | null | undefined;
  quotaProhibitSendBytes?: bigint | number | null | undefined;
}

const num = (v: bigint | number | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * Validation of a (partial) update: values not in the request are taken from
 * the stored row, so e.g. `{ quotaWarningBytes }` alone cannot end up above the
 * stored prohibit-send level or quota. Requests without any quota field are
 * not validated (an inconsistent stored row must not block a rename).
 */
export function quotaLevelPatchError(patch: QuotaLevelPatch, stored: StoredQuotaLevels): string | null {
  if (patch.quotaBytes === undefined && patch.quotaWarningBytes === undefined && patch.quotaProhibitSendBytes === undefined) return null;
  const quota = patch.quotaBytes ?? num(stored.quotaBytes);
  return quotaLevelError(
    patch.quotaWarningBytes !== undefined ? patch.quotaWarningBytes : num(stored.quotaWarningBytes),
    patch.quotaProhibitSendBytes !== undefined ? patch.quotaProhibitSendBytes : num(stored.quotaProhibitSendBytes),
    quota ?? undefined,
  );
}
