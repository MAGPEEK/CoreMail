/**
 * Setup wizard, step "DNS" (10.4): the records of the new domain with their
 * live status. The data comes from the BCP domain DNS check
 * (GET /api/v1/admin/domains/:id/dns-check, loaded by the page with the admin
 * session created after /setup/complete).
 */
import { RefreshCw } from 'lucide-react';
import { useT, fmt } from '../../i18n/useT.js';
import type { TranslationKey } from '../../i18n/translations.js';
import {
  REQUIRED_DNS_KEYS, RECOMMENDED_DNS_KEYS, requiredDnsOk, type DnsRecordResult,
} from '../../lib/setupWizard.js';
import { Alert, CopyValue, RecordStatus } from './WizardParts.js';

export interface DnsReport {
  domain: string;
  hostname: string;
  serverIp: string;
  records: Partial<Record<string, DnsRecordResult>>;
}

const RECORD_LABEL: Record<string, TranslationKey> = {
  a: 'wiz_dns_rec_a', mx: 'wiz_dns_rec_mx', spf: 'wiz_dns_rec_spf', dkim: 'wiz_dns_rec_dkim',
  dmarc: 'wiz_dns_rec_dmarc', ptr: 'wiz_dns_rec_ptr',
};

function RecordCard({ id, rec }: { id: string; rec: DnsRecordResult }) {
  const t = useT();
  const label = t(RECORD_LABEL[id] ?? 'wiz_dns_value');
  const expected = rec.expected;
  const mismatch = !rec.ok && !!rec.found;
  return (
    <li className="rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <h4 className="text-sm font-semibold text-fg">{label}</h4>
        <RecordStatus ok={rec.ok} mismatch={mismatch} />
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
        <dt className="text-fg-subtle">{t('wiz_dns_type')}</dt>
        <dd className="font-mono text-fg">{rec.type}</dd>
        <dt className="text-fg-subtle">{t('wiz_dns_name')}</dt>
        <dd className="min-w-0"><CopyValue value={rec.name} label={`${label} – ${t('wiz_dns_name')}`} /></dd>
        <dt className="text-fg-subtle">{t('wiz_dns_value')}</dt>
        <dd className="min-w-0">
          {expected
            ? <CopyValue value={expected} label={`${label} – ${t('wiz_dns_value')}`} />
            : <span className="text-fg-muted">{id === 'a' ? t('wiz_dns_a_value') : '—'}</span>}
        </dd>
      </dl>
      {mismatch && rec.found && (
        <p className="text-xs text-fg-muted mt-2 break-all">{fmt(t('wiz_dns_found'), { value: rec.found })}</p>
      )}
      {(rec.error ?? rec.warning) && (
        <p className="text-xs text-warning-fg mt-1">{rec.error ?? rec.warning}</p>
      )}
    </li>
  );
}

export function DnsStep({ domain, hostname, report, loading, error, onRecheck }: {
  domain: string;
  hostname: string;
  report: DnsReport | null;
  loading: boolean;
  error: string | null;
  onRecheck: () => void;
}) {
  const t = useT();
  const records = report?.records ?? null;
  const allOk = requiredDnsOk(records);
  return (
    <div className="space-y-4">
      <p className="text-sm text-fg-muted">{fmt(t('wiz_dns_intro'), { domain })}</p>

      {error && <Alert tone="danger">{t('wiz_dns_failed')} {error}</Alert>}
      {records && (allOk
        ? <Alert tone="success">{t('wiz_dns_all_ok')}</Alert>
        : <Alert tone="warning">{t('wiz_dns_some_missing')}</Alert>)}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={onRecheck}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded border border-line-strong px-3 py-1.5 text-sm text-fg-muted hover:bg-surface-2 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-fg"
        >
          <RefreshCw size={14} aria-hidden="true" className={loading ? 'animate-spin' : ''} />
          {loading ? t('wiz_dns_checking') : t('wiz_dns_recheck')}
        </button>
      </div>

      <div aria-busy={loading}>
        {records && (
          <>
            <h3 className="text-sm font-semibold text-fg mb-2">{t('wiz_dns_required')}</h3>
            <ul className="space-y-3 mb-4">
              {REQUIRED_DNS_KEYS.map((k) => records[k] ? <RecordCard key={k} id={k} rec={records[k]!} /> : null)}
            </ul>
            <p className="text-xs text-fg-subtle mb-4">{fmt(t('wiz_dns_aaaa_note'), { host: hostname })}</p>
            <h3 className="text-sm font-semibold text-fg mb-2">{t('wiz_dns_recommended')}</h3>
            <ul className="space-y-3">
              {RECOMMENDED_DNS_KEYS.map((k) => records[k] ? <RecordCard key={k} id={k} rec={records[k]!} /> : null)}
            </ul>
          </>
        )}
        {!records && loading && <p className="text-sm text-fg-muted">{t('wiz_dns_checking')}</p>}
      </div>
    </div>
  );
}
