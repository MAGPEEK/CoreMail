/**
 * 10.6: BCP → Authentifizierung → Passkeys. The server-wide switches
 * (passkeys, sign-in without a password), the Relying Party (RP ID, allowed
 * origins — read-only, from the configuration), the HTTPS readiness, a warning
 * after a host-name change, the related origins (/.well-known/webauthn) and
 * adoption numbers. Server: api-gateway routes/admin/passkeys.ts,
 * docs/passkeys.md. Area organisation: ORGANIZATION_MANAGEMENT writes,
 * SERVER_MANAGEMENT / VIEW_ONLY_ORG read (organisation-wide admins only).
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { AlertTriangle, CheckCircle2, KeyRound } from 'lucide-react';
import { api } from '../api/client.js';
import { Toggle } from '../components/Toggle.js';
import { WriteGuard } from '../components/Can.js';
import { useT } from '../i18n/useT.js';
import type { TranslationKey } from '../i18n/translations.js';
import { errorMessage } from '../lib/errors.js';
import { parseOriginList, readinessProblemKey, type ReadinessProblem } from '../lib/passkeys.js';

interface PasskeyPolicyView {
  enabled: boolean;
  passwordless: boolean;
  relatedOrigins: string[];
  rp: {
    rpId: string; frozen: boolean; source: 'env' | 'frozen' | 'host'; hostRpId: string;
    primaryOrigin: string; origins: string[]; envOverride: { rpId: boolean; origin: boolean };
  };
  readiness: { ready: boolean; problems: ReadinessProblem[] };
  hostNameChanged: boolean;
  adoption: { usersWithPasskeys: number; passkeys: number; syncedPasskeys: number; securityKeys: number; legacyKeys: number };
  overrides: { domains: number; users: number };
}

const fill = (text: string, vars: Record<string, string | number>): string =>
  text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-surface-2 border border-line rounded p-3">
      <p className="text-lg font-semibold text-fg">{value}</p>
      <p className="text-xs text-fg-subtle">{label}</p>
    </div>
  );
}

export function PasskeysPage() {
  const t = useT();
  const qc = useQueryClient();
  const { data: v, isLoading, isError, error } = useQuery<PasskeyPolicyView>({
    queryKey: ['admin-passkey-policy'],
    queryFn: () => api.get('/admin/authentication/passkeys'),
  });
  const [originsText, setOriginsText] = useState('');
  useEffect(() => { if (v) setOriginsText(v.relatedOrigins.join('\n')); }, [v]);

  const save = useMutation({
    mutationFn: (patch: Partial<Pick<PasskeyPolicyView, 'enabled' | 'passwordless' | 'relatedOrigins'>>) =>
      api.put<PasskeyPolicyView>('/admin/authentication/passkeys', patch),
    onSuccess: (next) => { qc.setQueryData(['admin-passkey-policy'], next); toast.success(t('pkp_saved')); },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (isLoading) return <div className="p-6 text-sm text-fg-muted">…</div>;
  if (isError || !v) return <div className="p-6 text-sm text-danger-fg" role="alert">{errorMessage(error)}</div>;

  const parsed = parseOriginList(originsText);
  const originsChanged = parsed.origins.join('\n') !== v.relatedOrigins.join('\n');

  return (
    <div className="p-6 max-w-4xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-fg flex items-center gap-2"><KeyRound size={18} aria-hidden="true" />{t('pkp_title')}</h1>
        <p className="text-sm text-fg-muted mt-1">{t('pkp_intro')}</p>
      </div>

      <WriteGuard area="organisation">
        <section className="bg-surface border border-line rounded p-5 space-y-4" aria-labelledby="pkp-switches">
          <h2 id="pkp-switches" className="sr-only">{t('pkp_enabled')}</h2>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-fg">{t('pkp_enabled')}</p>
              <p className="text-xs text-fg-subtle mt-0.5">{t('pkp_enabled_hint')}</p>
              <p className="text-xs text-fg-subtle mt-0.5">{fill(t('pkp_overrides'), { domains: v.overrides.domains, users: v.overrides.users })}</p>
            </div>
            <Toggle active={v.enabled} label={t('pkp_enabled')} disabled={save.isPending} onToggle={() => save.mutate({ enabled: !v.enabled })} />
          </div>
          <div className="flex items-center justify-between gap-4 border-t border-line pt-4">
            <div>
              <p className="text-sm font-semibold text-fg">{t('pkp_passwordless')}</p>
              <p className="text-xs text-fg-subtle mt-0.5">{t('pkp_passwordless_hint')}</p>
            </div>
            <Toggle active={v.passwordless} label={t('pkp_passwordless')} disabled={save.isPending} onToggle={() => save.mutate({ passwordless: !v.passwordless })} />
          </div>
        </section>
      </WriteGuard>

      <section className="bg-surface border border-line rounded p-5 space-y-3" aria-labelledby="pkp-rp">
        <h2 id="pkp-rp" className="text-sm font-semibold text-fg">{t('pkp_rp_title')}</h2>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-fg-subtle">{t('pkp_rp_id')}</dt>
          <dd className="text-fg">
            <code className="font-mono">{v.rp.rpId}</code>{' '}
            <span className="text-xs text-fg-subtle">
              ({v.rp.source === 'env' ? t('pkp_rp_env') : v.rp.frozen ? t('pkp_rp_frozen') : t('pkp_rp_not_frozen')})
            </span>
          </dd>
          <dt className="text-fg-subtle">{t('pkp_origins')}</dt>
          <dd className="text-fg font-mono text-xs space-y-0.5">{v.rp.origins.map((o) => <div key={o}>{o}</div>)}</dd>
          <dt className="text-fg-subtle">{t('pkp_readiness')}</dt>
          <dd>
            {v.readiness.ready ? (
              <span className="inline-flex items-center gap-1 text-xs text-success-fg"><CheckCircle2 size={13} aria-hidden="true" />{t('pkp_ready')}</span>
            ) : (
              <ul className="text-xs text-warning-fg space-y-0.5" role="status">
                {v.readiness.problems.map((p) => (
                  <li key={p} className="flex items-start gap-1"><AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />{t(readinessProblemKey(p) as TranslationKey)}</li>
                ))}
              </ul>
            )}
          </dd>
        </dl>
        {v.hostNameChanged && (
          <p role="alert" className="text-xs rounded border border-warning-line bg-warning-bg text-warning-fg px-3 py-2 flex items-start gap-1.5">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
            {fill(t('pkp_host_changed'), { rpId: v.rp.rpId, host: v.rp.hostRpId })}
          </p>
        )}
      </section>

      <WriteGuard area="organisation">
        <section className="bg-surface border border-line rounded p-5 space-y-3" aria-labelledby="pkp-related">
          <div>
            <h2 id="pkp-related" className="text-sm font-semibold text-fg">{t('pkp_related')}</h2>
            <p className="text-xs text-fg-subtle mt-0.5">{t('pkp_related_hint')}</p>
          </div>
          <textarea
            value={originsText}
            onChange={(e) => setOriginsText(e.target.value)}
            rows={3}
            aria-label={t('pkp_related')}
            placeholder="https://webmail.example.org"
            className="w-full font-mono text-sm bg-surface-2 border border-line-strong rounded px-3 py-2 text-fg"
          />
          {parsed.invalid.length > 0 && (
            <p className="text-xs text-danger-fg" role="alert">{fill(t('pkp_related_invalid'), { list: parsed.invalid.join(', ') })}</p>
          )}
          <div className="flex justify-end">
            <button
              type="button"
              disabled={!originsChanged || parsed.invalid.length > 0 || save.isPending}
              onClick={() => save.mutate({ relatedOrigins: parsed.origins })}
              className="px-4 py-2 bg-accent text-white rounded text-sm font-medium hover:bg-accent/90 disabled:opacity-40"
            >
              {t('pkp_save')}
            </button>
          </div>
        </section>
      </WriteGuard>

      <section className="bg-surface border border-line rounded p-5 space-y-3" aria-labelledby="pkp-adoption">
        <h2 id="pkp-adoption" className="text-sm font-semibold text-fg">{t('pkp_adoption')}</h2>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <Stat label={t('pkp_adoption_users')} value={v.adoption.usersWithPasskeys} />
          <Stat label={t('pkp_adoption_passkeys')} value={v.adoption.passkeys} />
          <Stat label={t('pkp_adoption_synced')} value={v.adoption.syncedPasskeys} />
          <Stat label={t('pkp_adoption_keys')} value={v.adoption.securityKeys} />
          <Stat label={t('pkp_adoption_legacy')} value={v.adoption.legacyKeys} />
        </div>
      </section>
    </div>
  );
}
