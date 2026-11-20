/**
 * 10.4: dashboard reminder after the setup wizard's certificate step was
 * answered with "Später" (GET /api/v1/admin/setup-state → certificateHint).
 * Disappears by itself once a trusted certificate exists; admins with write
 * access to the servers area can dismiss it for everyone.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ShieldAlert, X } from 'lucide-react';
import { api } from '../api/client.js';
import { usePermissions } from '../hooks/usePermissions.js';
import { useT } from '../i18n/useT.js';

interface SetupState { certificateChoice: string | null; certificateHint: boolean }

const QUERY_KEY = ['admin-setup-state'] as const;

export function SetupCertificateHint() {
  const t = useT();
  const { can } = usePermissions();
  const qc = useQueryClient();
  const { data } = useQuery<SetupState>({
    queryKey: QUERY_KEY,
    queryFn: () => api.get<SetupState>('/admin/setup-state'),
    enabled: can('servers', 'read'),
    refetchInterval: 5 * 60_000,
    retry: false,
  });
  const dismiss = useMutation({
    mutationFn: () => api.post<SetupState>('/admin/setup-state/certificate-hint/dismiss', {}),
    onSuccess: (s) => qc.setQueryData(QUERY_KEY, s),
  });
  if (!data?.certificateHint) return null;
  return (
    <section
      aria-labelledby="setup-cert-hint-title"
      className="px-4 py-3 bg-info-bg border border-info-line rounded-xl flex flex-wrap sm:flex-nowrap items-start gap-3 text-sm text-info-fg"
    >
      <ShieldAlert size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <h2 id="setup-cert-hint-title" className="font-semibold">{t('dash_setup_cert_title')}</h2>
        <p className="text-xs mt-0.5">{t('dash_setup_cert_text')}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Link to="/certificates" className="btn-secondary text-xs">{t('dash_setup_cert_action')}</Link>
        {can('servers', 'write') && (
          <button
            type="button"
            onClick={() => dismiss.mutate()}
            disabled={dismiss.isPending}
            className="btn-secondary text-xs"
          >
            <X size={13} aria-hidden="true" />{t('dash_setup_cert_dismiss')}
          </button>
        )}
      </div>
    </section>
  );
}
