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
