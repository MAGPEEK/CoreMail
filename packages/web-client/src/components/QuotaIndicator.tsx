/**
 * v8.1: mailbox usage bar under the folder tree, coloured by the quota level.
 * 9.1: `sharedMailboxId` shows the quota of that shared mailbox instead of the
 * user's own (GET /user/shared-mailboxes/:id/quota); `label` adds a caption.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useT, fmt } from '../i18n/useT.js';
import { fmtQuotaBytes, quotaColor, quotaPath, quotaPercent, quotaQueryKey, type UserQuota } from '../lib/quota.js';

export function QuotaIndicator({ sharedMailboxId, label, className }: { sharedMailboxId?: string; label?: string; className?: string } = {}) {
  const t = useT();
  const { data } = useQuery({
    queryKey: quotaQueryKey(sharedMailboxId),
    queryFn: () => api.get<UserQuota>(quotaPath(sharedMailboxId)),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: sharedMailboxId ? false : 3, // a 403 (no read access) is final
  });
  if (!data || data.prohibitSendReceiveBytes <= 0) return null;
  const pct = quotaPercent(data);
  const color = quotaColor(data.level);
  const notice = data.level === 'prohibitSendReceive' ? t('quota_prohibit_receive')
    : data.level === 'prohibitSend' ? t('quota_prohibit_send')
      : data.level === 'warning' ? t('quota_warning') : null;
  return (
    <div className={className ?? 'px-3 py-2 border-t border-line'} title={`${pct.toFixed(1)} %`}>
      {label && <p className="mb-1 text-[11px] font-medium text-fg-muted truncate">{label}</p>}
      <div className="h-1.5 w-full bg-surface-3 rounded-full overflow-hidden"
        role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}
        {...(label ? { 'aria-label': label } : {})}>
        <div className={`h-full ${color.bar}`} style={{ width: `${pct}%` }} />
      </div>
      <p className={`mt-1 text-[11px] ${color.text}`}>
        {fmt(t('quota_used'), { used: fmtQuotaBytes(data.usedBytes), total: fmtQuotaBytes(data.prohibitSendReceiveBytes) })}
      </p>
      {notice && <p className={`text-[11px] font-medium ${color.text}`}>{notice}</p>}
    </div>
  );
}
