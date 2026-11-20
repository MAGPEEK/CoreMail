/**
 * 10.3: BCP → Infrastruktur → KI-Schnittstelle (MCP). The switch, the endpoint
 * URL, an example client configuration, the optional client IP allowlist, the
 * admin's own MCP tokens (Organization Management: everyone's) and a short
 * security note. Server: api-gateway routes/admin/mcp.ts, docs/mcp.md.
 *
 * Visible to every admin role (own tokens); the switch and the allowlist are
 * editable with write access to the servers area only (`canManage`), the
 * allowlist is shown with read access to it (the server omits it otherwise).
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Copy, KeyRound, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { api } from '../api/client.js';
import { Toggle } from '../components/Toggle.js';
import { useT } from '../i18n/useT.js';
import {
  EXPIRY_CHOICES, TOKEN_PLACEHOLDER, clientConfigJson, expiresSoon, parseAllowlistText, sortTokens, validTokenName,
  type McpSettingsView, type McpTokenMode, type McpTokenView,
} from '../lib/mcp.js';

interface CreatedToken { token: string; id: string; name: string }

const fmt = (iso: string | null): string => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

function CopyButton({ text, label }: { text: string; label: string }) {
  const t = useT();
  return (
    <button
      type="button" aria-label={label} title={label}
      onClick={() => { void navigator.clipboard.writeText(text).then(() => toast.success(t('mcp_copied'))); }}
      className="p-1.5 text-fg-subtle hover:text-accent-fg shrink-0"
    >
      <Copy size={13} />
    </button>
  );
}

export function McpPage() {
  const t = useT();
  const qc = useQueryClient();
  const [showAll, setShowAll] = useState(false);
  const [allowText, setAllowText] = useState('');
  const [name, setName] = useState('');
  const [mode, setMode] = useState<McpTokenMode>('read');
  const [days, setDays] = useState(90);
  const [created, setCreated] = useState<CreatedToken | null>(null);

  const { data: s, refetch: refetchSettings } = useQuery<McpSettingsView>({
    queryKey: ['admin-mcp-settings'],
    queryFn: () => api.get('/admin/mcp/settings'),
  });
  const { data: tokenData, refetch: refetchTokens } = useQuery<{ tokens: McpTokenView[] }>({
    queryKey: ['admin-mcp-tokens', showAll],
    queryFn: () => api.get(`/admin/mcp/tokens${showAll ? '?all=true' : ''}`),
  });

  useEffect(() => {
    if (s?.allowedIps) setAllowText(s.allowedIps.join('\n'));
  }, [s?.allowedIps]);
  useEffect(() => {
    if (s) setDays(s.limits.tokenDefaultDays);
  }, [s]);

  const saveSettings = useMutation({
    mutationFn: (patch: { enabled?: boolean; allowedIps?: string[] }) => api.put('/admin/mcp/settings', patch),
    onSuccess: () => { toast.success(t('mcp_saved')); void qc.invalidateQueries({ queryKey: ['admin-mcp-settings'] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  const createToken = useMutation({
    mutationFn: () => api.post<CreatedToken>('/admin/mcp/tokens', { name: name.trim(), mode, expiresInDays: days }),
    onSuccess: (r) => {
      setCreated({ token: r.token, id: r.id, name: r.name });
      setName('');
      void qc.invalidateQueries({ queryKey: ['admin-mcp-tokens'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const revokeToken = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/mcp/tokens/${encodeURIComponent(id)}`),
    onSuccess: (_r, id) => {
      toast.success(t('mcp_revoked'));
      if (created?.id === id) setCreated(null);
      void qc.invalidateQueries({ queryKey: ['admin-mcp-tokens'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!s) return <div className="p-6 text-sm text-fg-subtle">…</div>;

  const allow = parseAllowlistText(allowText);
  const allowChanged = s.allowedIps !== undefined && allow.entries.join('\n') !== s.allowedIps.join('\n');
  const tokens = sortTokens(tokenData?.tokens ?? []);
  const config = clientConfigJson(s.endpointUrl, created?.token ?? TOKEN_PLACEHOLDER);
  const nameOk = validTokenName(name);
  const statusLabel = (st: McpTokenView['status']) =>
    st === 'active' ? t('mcp_status_active') : st === 'revoked' ? t('mcp_status_revoked') : t('mcp_status_expired');

  return (
    <div className="p-6 max-w-5xl space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-fg">{t('nav_mcp')}</h1>
          <p className="text-sm text-fg-muted mt-1">{t('mcp_page_intro')}</p>
        </div>
        <button
          type="button" aria-label={t('action_refresh')} title={t('action_refresh')}
          onClick={() => { void refetchSettings(); void refetchTokens(); }}
          className="p-2 text-fg-subtle border border-line-strong rounded hover:bg-surface-2"
        >
          <RefreshCw size={13} />
        </button>
      </div>

      {/* Interface: switch + endpoint */}
      <section className="bg-surface border border-line rounded p-5 space-y-4" aria-labelledby="mcp-switch">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 id="mcp-switch" className="text-sm font-semibold text-fg">{t('mcp_switch_title')}</h2>
            <p className="text-xs text-fg-subtle mt-0.5">{t('mcp_switch_hint')}</p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <span className={`text-xs px-2 py-0.5 rounded-full ${s.enabled ? 'bg-success-bg text-success-fg' : 'bg-surface-2 text-fg-subtle'}`}>
              {s.enabled ? t('mcp_status_on') : t('mcp_status_off')}
            </span>
            <Toggle
              active={s.enabled}
              disabled={!s.canManage || saveSettings.isPending}
              label={t('mcp_switch_label')}
              onToggle={() => saveSettings.mutate({ enabled: !s.enabled })}
            />
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-fg-subtle shrink-0">{t('mcp_endpoint')}:</span>
          <code className="font-mono text-fg-muted bg-surface-2 px-2 py-0.5 rounded truncate">{s.endpointUrl}</code>
          <CopyButton text={s.endpointUrl} label={t('mcp_copy')} />
          {s.openSessions !== undefined && (
            <span className="ml-auto text-xs text-fg-subtle shrink-0">{t('mcp_open_sessions')}: {s.openSessions}</span>
          )}
        </div>
      </section>

      {/* Client IP allowlist (servers area) */}
      {s.allowedIps !== undefined && (
        <section className="bg-surface border border-line rounded p-5 space-y-3" aria-labelledby="mcp-allow">
          <div>
            <h2 id="mcp-allow" className="text-sm font-semibold text-fg">{t('mcp_allowlist_title')}</h2>
            <p className="text-xs text-fg-subtle mt-0.5">{t('mcp_allowlist_hint')}</p>
          </div>
          <textarea
            value={allowText}
            onChange={(e) => setAllowText(e.target.value)}
            readOnly={!s.canManage}
            rows={4}
            aria-label={t('mcp_allowlist_title')}
            className="w-full font-mono text-sm bg-surface-2 border border-line-strong rounded px-3 py-2 text-fg"
          />
          {allow.invalid.length > 0 && (
            <p className="text-xs text-danger-fg">{t('mcp_allowlist_invalid')} {allow.invalid.join(', ')}</p>
          )}
          {s.canManage && (
            <div className="flex justify-end">
              <button
                type="button"
                disabled={!allowChanged || allow.invalid.length > 0 || saveSettings.isPending}
                onClick={() => saveSettings.mutate({ allowedIps: allow.entries })}
                className="px-4 py-2 bg-accent text-white rounded text-sm font-medium hover:bg-accent/90 disabled:opacity-40"
              >
                {t('action_save')}
              </button>
            </div>
          )}
        </section>
      )}

      {/* Tokens */}
      <section className="bg-surface border border-line rounded p-5 space-y-4" aria-labelledby="mcp-tokens">
        <div className="flex items-center justify-between gap-4">
          <h2 id="mcp-tokens" className="text-sm font-semibold text-fg">{showAll ? t('mcp_tokens_title') : t('mcp_tokens_mine')}</h2>
          {s.canSeeAllTokens && (
            <label className="flex items-center gap-2 text-xs text-fg-muted">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} aria-label={t('mcp_tokens_all')} />
              {t('mcp_tokens_all')}
            </label>
          )}
        </div>

        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => { e.preventDefault(); if (nameOk) createToken.mutate(); }}
        >
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            {t('mcp_token_name')}
            <input
              value={name} onChange={(e) => setName(e.target.value)} maxLength={64} aria-label={t('mcp_token_name')}
              className="w-56 text-sm bg-surface-2 border border-line-strong rounded px-3 py-1.5 text-fg"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            {t('mcp_token_mode')}
            <select
              value={mode} onChange={(e) => setMode(e.target.value as McpTokenMode)} aria-label={t('mcp_token_mode')}
              className="text-sm bg-surface-2 border border-line-strong rounded px-2 py-1.5 text-fg"
            >
              <option value="read">{t('mcp_mode_read')}</option>
              <option value="write" disabled={!s.canCreateWriteTokens}>{t('mcp_mode_write')}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            {t('mcp_token_expiry')}
            <select
              value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label={t('mcp_token_expiry')}
              className="text-sm bg-surface-2 border border-line-strong rounded px-2 py-1.5 text-fg"
            >
              {EXPIRY_CHOICES.filter((d) => d <= s.limits.tokenMaxDays).map((d) => (
                <option key={d} value={d}>{d} {t('mcp_days')}</option>
              ))}
            </select>
          </label>
          <button
            type="submit" disabled={!nameOk || createToken.isPending}
            className="flex items-center gap-2 px-4 py-2 bg-accent text-white rounded text-sm font-medium hover:bg-accent/90 disabled:opacity-40"
          >
            <Plus size={14} /> {t('mcp_token_create')}
          </button>
          {name !== '' && !nameOk && <span className="text-xs text-danger-fg">{t('mcp_name_invalid')}</span>}
        </form>
        {!s.canCreateWriteTokens && <p className="text-xs text-fg-subtle">{t('mcp_write_not_allowed')}</p>}

        {created && (
          <div className="border border-warning-line bg-warning-bg rounded p-4 space-y-2" role="status">
            <div className="flex items-center gap-2 text-sm font-semibold text-fg">
              <KeyRound size={14} /> {t('mcp_token_created_title')} — {created.name}
            </div>
            <div className="flex items-center gap-2">
              <code className="font-mono text-xs text-fg bg-surface px-2 py-1 rounded break-all">{created.token}</code>
              <CopyButton text={created.token} label={t('mcp_copy')} />
            </div>
            <div className="flex items-center justify-between gap-4">
              <p className="text-xs text-fg-muted">{t('mcp_token_created_hint')}</p>
              <button type="button" onClick={() => setCreated(null)} className="text-xs text-fg-subtle hover:text-fg">{t('mcp_token_dismiss')}</button>
            </div>
          </div>
        )}

        {tokens.length === 0 ? (
          <p className="text-sm text-fg-subtle">{t('mcp_no_tokens')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-fg-subtle border-b border-line">
                  <th className="py-2 pr-3 font-medium">{t('mcp_token_name')}</th>
                  {showAll && <th className="py-2 pr-3 font-medium">{t('mcp_col_owner')}</th>}
                  <th className="py-2 pr-3 font-medium">{t('mcp_token_mode')}</th>
                  <th className="py-2 pr-3 font-medium">{t('mcp_col_status')}</th>
                  <th className="py-2 pr-3 font-medium">{t('mcp_col_expires')}</th>
                  <th className="py-2 pr-3 font-medium">{t('mcp_col_last_used')}</th>
                  <th className="py-2" aria-label={t('mcp_revoke')} />
                </tr>
              </thead>
              <tbody>
                {tokens.map((tok) => (
                  <tr key={tok.id} className="border-b border-line last:border-0 align-top">
                    <td className="py-2 pr-3">
                      <div className="text-fg">{tok.name}</div>
                      <code className="font-mono text-xs text-fg-subtle">{tok.prefix}…</code>
                    </td>
                    {showAll && <td className="py-2 pr-3 text-fg-muted">{tok.owner ?? '—'}</td>}
                    <td className="py-2 pr-3 text-fg-muted">{tok.mode === 'write' ? t('mcp_mode_write') : t('mcp_mode_read')}</td>
                    <td className="py-2 pr-3">
                      <span className={`text-xs px-1.5 py-0.5 rounded-full ${tok.status === 'active' ? 'bg-success-bg text-success-fg' : 'bg-surface-2 text-fg-subtle'}`}>
                        {statusLabel(tok.status)}
                      </span>
                      {expiresSoon(tok) && <span className="ml-2 text-xs text-warning-fg">{t('mcp_expires_soon')}</span>}
                    </td>
                    <td className="py-2 pr-3 text-fg-muted whitespace-nowrap">{fmt(tok.expiresAt)}</td>
                    <td className="py-2 pr-3 text-fg-muted whitespace-nowrap">
                      {tok.lastUsedAt ? <>{fmt(tok.lastUsedAt)}{tok.lastUsedIp ? <span className="block text-xs text-fg-subtle">{tok.lastUsedIp}</span> : null}</> : t('mcp_never_used')}
                    </td>
                    <td className="py-2 text-right">
                      {tok.status === 'active' && (
                        <button
                          type="button" aria-label={`${t('mcp_revoke')}: ${tok.name}`} title={t('mcp_revoke')}
                          disabled={revokeToken.isPending}
                          onClick={() => { if (confirm(t('mcp_revoke_confirm'))) revokeToken.mutate(tok.id); }}
                          className="p-1.5 text-fg-subtle hover:text-danger-fg disabled:opacity-40"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Example client configuration */}
      <section className="bg-surface border border-line rounded p-5 space-y-3" aria-labelledby="mcp-config">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="mcp-config" className="text-sm font-semibold text-fg">{t('mcp_config_title')}</h2>
            <p className="text-xs text-fg-subtle mt-0.5">{t('mcp_config_hint')}</p>
          </div>
          <CopyButton text={config} label={t('mcp_copy')} />
        </div>
        <pre className="font-mono text-xs text-fg bg-surface-2 border border-line rounded p-3 overflow-x-auto">{config}</pre>
      </section>

      {/* Security note */}
      <section className="bg-surface border border-line rounded p-5 space-y-2" aria-labelledby="mcp-security">
        <h2 id="mcp-security" className="text-sm font-semibold text-fg flex items-center gap-2">
          <ShieldCheck size={14} /> {t('mcp_security_title')}
        </h2>
        <ul className="list-disc pl-5 text-xs text-fg-muted space-y-1">
          <li>{t('mcp_security_1')}</li>
          <li>{t('mcp_security_2')}</li>
          <li>{t('mcp_security_3')}</li>
          <li>{t('mcp_security_4')}</li>
          <li>{t('mcp_security_5')}</li>
        </ul>
      </section>
    </div>
  );
}
