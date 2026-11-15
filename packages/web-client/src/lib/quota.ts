/** v8.1: mailbox quota display helpers (GET /api/v1/user/quota). */
export type QuotaLevel = 'ok' | 'warning' | 'prohibitSend' | 'prohibitSendReceive';

export interface UserQuota {
  usedBytes: number;
  level: QuotaLevel;
  warningBytes: number;
  prohibitSendBytes: number;
  prohibitSendReceiveBytes: number;
}

/** Pure: percent of the quota (prohibit-send-receive) in use, 0 when unlimited. */
export function quotaPercent(q: Pick<UserQuota, 'usedBytes' | 'prohibitSendReceiveBytes'>): number {
  if (q.prohibitSendReceiveBytes <= 0) return 0;
  return Math.min(100, (q.usedBytes / q.prohibitSendReceiveBytes) * 100);
}

/** Pure: bar / text colour class per level (warning amber, blocked red). */
export function quotaColor(level: QuotaLevel): { bar: string; text: string } {
  switch (level) {
    case 'prohibitSendReceive':
    case 'prohibitSend':
      return { bar: 'bg-red-500', text: 'text-red-600 dark:text-red-400' };
    case 'warning':
      return { bar: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400' };
    default:
      return { bar: 'bg-accent', text: 'text-gray-500 dark:text-gray-400' };
  }
}

/**
 * 9.1: API path (relative to /api/v1) of a mailbox's quota — the user's own, or
 * a shared mailbox the user may read (GET /user/shared-mailboxes/:id/quota).
 */
export function quotaPath(sharedMailboxId?: string | null): string {
  return sharedMailboxId ? `/user/shared-mailboxes/${encodeURIComponent(sharedMailboxId)}/quota` : '/user/quota';
}

/** Query key matching quotaPath() (the own quota keeps the existing 'user-quota' key). */
export function quotaQueryKey(sharedMailboxId?: string | null): readonly unknown[] {
  return sharedMailboxId ? ['shared-mailbox-quota', sharedMailboxId] : ['user-quota'];
}

export function fmtQuotaBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}
