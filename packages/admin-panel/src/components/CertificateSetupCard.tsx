/**
 * 10.4.2: dashboard card "Zertifikat einrichten" (replaces the setup wizard's
 * certificate step). GET /api/v1/admin/setup-state → certificateCard: shown
 * while no trusted certificate covers the public host name, only to roles that
 * may manage certificates (area servers, write). One button runs the
 * certificates page's Let's Encrypt flow and assigns the new certificate to
 * HTTPS as well (lib/certificateCard.ts); "Später" hides the card for everyone.
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CheckCircle2, Loader2, ShieldAlert } from 'lucide-react';
import { api } from '../api/client.js';
import { usePermissions } from '../hooks/usePermissions.js';
import { useT } from '../i18n/useT.js';
import type { TranslationKey } from '../i18n/translations.js';
import { SERVED_CERT_QUERY_KEY } from './ServedCert.js';
import { runCertificateCard, type CardPhase, type CardResult } from '../lib/certificateCard.js';

interface SetupState { certificateCard: boolean; publicHostname: string | null; acmeEmail: string | null }

const QUERY_KEY = ['admin-setup-state'] as const;

const PHASE_TEXT: Partial<Record<CardPhase, TranslationKey>> = {
  preflight: 'dash_setup_cert_phase_preflight',
  ordering: 'dash_setup_cert_phase_ordering',
  waiting: 'dash_setup_cert_phase_waiting',
  activating: 'dash_setup_cert_phase_activating',
};

function CardFailure({ result }: { result: CardResult }) {
  const t = useT();
  if (result.kind === 'done') return null;
  return (
    <div role="alert" className="mt-2 rounded-lg border border-danger-line bg-danger-bg px-3 py-2 text-xs text-danger-fg">
      {result.kind === 'preflight-failed' ? (
        <>
          <p className="font-medium">{t('dash_setup_cert_preflight_failed')}</p>
          <ul className="list-disc pl-5 mt-1 space-y-0.5">{result.problems.map((m) => <li key={m} className="break-words">{m}</li>)}</ul>
        </>
      ) : result.kind === 'timeout' ? (
        <p>{t('dash_setup_cert_timeout')}</p>
      ) : (
        <>
          <p className="font-medium">{t('dash_setup_cert_failed')}</p>
          {result.message && <p className="mt-1 break-words">{result.message}</p>}
        </>
      )}
      <Link to="/certificates" className="inline-block mt-1.5 underline underline-offset-2 font-medium">{t('dash_setup_cert_details')}</Link>
    </div>
  );
}

export function CertificateSetupCard() {
  const t = useT();
  const { can } = usePermissions();
  const qc = useQueryClient();
  const allowed = can('servers', 'write');
  const [phase, setPhase] = useState<CardPhase>('idle');
  const [result, setResult] = useState<CardResult | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const { data } = useQuery<SetupState>({
    queryKey: QUERY_KEY,
    queryFn: () => api.get<SetupState>('/admin/setup-state'),
    enabled: allowed,
    refetchInterval: 5 * 60_000,
    retry: false,
  });
  const dismiss = useMutation({
    mutationFn: () => api.post<SetupState>('/admin/setup-state/certificate-hint/dismiss', {}),
    onSuccess: (s) => { setPhase('idle'); setResult(null); qc.setQueryData(QUERY_KEY, s); },
  });

  const busy = phase === 'preflight' || phase === 'ordering' || phase === 'waiting' || phase === 'activating';
  // keep the card while a run is going or its outcome is shown
  if (!allowed || (!data?.certificateCard && phase === 'idle')) return null;
  const host = data?.publicHostname ?? '';

  const start = async () => {
    setResult(null);
    const r = await runCertificateCard(api, {
      email: data?.acmeEmail ?? '',
      onPhase: (p) => { if (alive.current) setPhase(p); },
      alive: () => alive.current,
    });
    if (!alive.current) return;
    setResult(r);
    if (r.kind === 'done') {
      void qc.invalidateQueries({ queryKey: ['admin-certificates'] });
      setTimeout(() => void qc.invalidateQueries({ queryKey: SERVED_CERT_QUERY_KEY }), 2_000);
    }
  };

  const phaseKey = PHASE_TEXT[phase];
  return (
    <section
      aria-labelledby="setup-cert-card-title"
      className="px-4 py-3 bg-info-bg border border-info-line rounded-xl flex flex-wrap sm:flex-nowrap items-start gap-3 text-sm text-info-fg"
    >
      {phase === 'done'
        ? <CheckCircle2 size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
        : <ShieldAlert size={16} className="shrink-0 mt-0.5" aria-hidden="true" />}
      <div className="flex-1 min-w-0">
        <h2 id="setup-cert-card-title" className="font-semibold">{t('dash_setup_cert_title')}</h2>
        <div aria-live="polite">
          {phase === 'done' ? (
            <p className="text-xs mt-0.5">{t('dash_setup_cert_done')}</p>
          ) : busy && phaseKey ? (
            <p className="text-xs mt-0.5 flex items-center gap-1.5">
              <Loader2 size={13} className="animate-spin" aria-hidden="true" />{t(phaseKey)}
            </p>
          ) : (
            <p className="text-xs mt-0.5">{t('dash_setup_cert_text').replace('{host}', host)}</p>
          )}
        </div>
        {phase === 'failed' && result && <CardFailure result={result} />}
      </div>
      {phase !== 'done' && (
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button type="button" onClick={() => void start()} disabled={busy || !host} className="btn-primary text-xs">
            {phase === 'failed' ? t('dash_setup_cert_retry') : t('dash_setup_cert_request').replace('{host}', host)}
          </button>
          <button
            type="button"
            onClick={() => dismiss.mutate()}
            disabled={busy || dismiss.isPending}
            className="btn-secondary text-xs"
          >
            {t('dash_setup_cert_later')}
          </button>
        </div>
      )}
    </section>
  );
}
