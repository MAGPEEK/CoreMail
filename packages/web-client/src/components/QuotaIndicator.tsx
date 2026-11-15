/** v8.1: mailbox usage bar under the folder tree, coloured by the quota level. */
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useT, fmt } from '../i18n/useT.js';
import { fmtQuotaBytes, quotaColor, quotaPercent, type UserQuota } from '../lib/quota.js';

export function QuotaIndicator() {
  const t = useT();
  const { data } = useQuery({
    queryKey: ['user-quota'],
    queryFn: () => api.get<UserQuota>('/user/quota'),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
  if (!data || data.prohibitSendReceiveBytes <= 0) return null;
  const pct = quotaPercent(data);
  const color = quotaColor(data.level);
  const notice = data.level === 'prohibitSendReceive' ? t('quota_prohibit_receive')
    : data.level === 'prohibitSend' ? t('quota_prohibit_send')
      : data.level === 'warning' ? t('quota_warning') : null;
  return (
    <div className="px-3 py-2 border-t border-gray-200 dark:border-gray-700" title={`${pct.toFixed(1)} %`}>
      <div className="h-1.5 w-full bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden"
        role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div className={`h-full ${color.bar}`} style={{ width: `${pct}%` }} />
      </div>
      <p className={`mt-1 text-[11px] ${color.text}`}>
        {fmt(t('quota_used'), { used: fmtQuotaBytes(data.usedBytes), total: fmtQuotaBytes(data.prohibitSendReceiveBytes) })}
      </p>
      {notice && <p className={`text-[11px] font-medium ${color.text}`}>{notice}</p>}
    </div>
  );
}
