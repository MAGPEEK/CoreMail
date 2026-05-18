import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Fingerprint, Plus, Trash2, RefreshCw, CheckCircle2, XCircle,
  TestTube2, Save, Settings, List, Info, AlertCircle, ExternalLink,
  ShieldCheck, Edit2,
} from 'lucide-react';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';
import { Toggle } from '../components/Toggle.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface OidcProvider {
  id:            string;
  domainId:      string;
  domainName:    string;
  name:          string;
  discoveryUrl:  string;
  clientId:      string;
  claimMap:      Record<string, string>;
  autoProvision: boolean;
  forcedDomains: string[];
  active:        boolean;
  createdAt:     string;
}

interface Domain { id: string; name: string }

type Section = 'providers' | 'saml' | 'settings';

const SECTIONS: { key: Section; label: string; icon: React.ReactNode }[] = [
  { key: 'providers', label: 'OIDC-Anbieter',  icon: <List size={14} /> },
  { key: 'saml',      label: 'SAML 2.0',       icon: <ShieldCheck size={14} /> },
  { key: 'settings',  label: 'Einstellungen',  icon: <Settings size={14} /> },
];

const PRESET_PROVIDERS = [
  { name: 'Azure Active Directory', url: 'https://login.microsoftonline.com/{tenant-id}/v2.0/.well-known/openid-configuration', icon: '🪟' },
  { name: 'Google Workspace',       url: 'https://accounts.google.com/.well-known/openid-configuration',                        icon: '🔵' },
  { name: 'Keycloak',               url: 'https://keycloak.meinserver.de/realms/{realm}/.well-known/openid-configuration',      icon: '🔑' },
  { name: 'Authentik',              url: 'https://authentik.meinserver.de/application/o/{slug}/.well-known/openid-configuration', icon: '🛡️' },
  { name: 'Okta',                   url: 'https://{domain}.okta.com/.well-known/openid-configuration',                          icon: '⭕' },
  { name: 'GitHub',                 url: 'https://token.actions.githubusercontent.com/.well-known/openid-configuration',        icon: '🐙' },
];

// ─── Provider Form ────────────────────────────────────────────────────────────

function ProviderForm({
  provider, domains, onSaved, onCancel,
}: {
  provider?: OidcProvider;
  domains: Domain[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const qc = useQueryClient();
  const isEdit = !!provider;

  const [form, setForm] = useState({
    domainId:      provider?.domainId      ?? '',
    name:          provider?.name          ?? '',
    discoveryUrl:  provider?.discoveryUrl  ?? '',
    clientId:      provider?.clientId      ?? '',
    clientSecret:  '',
    autoProvision: provider?.autoProvision ?? true,
    active:        provider?.active        ?? true,
    forcedDomains: provider?.forcedDomains ?? [],
  });

  const [testResult, setTestResult] = useState<{ success: boolean; message: string; issuer?: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const set = (k: keyof typeof form, v: unknown) => setForm(f => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: (): Promise<{ ok: boolean }> => isEdit
      ? api.put<{ ok: boolean }>(`/admin/sso/providers/${provider!.id}`, form)
      : api.post<{ id: string }>('/admin/sso/providers', form).then(() => ({ ok: true })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-sso-providers'] });
      toast.success(isEdit ? 'Provider aktualisiert' : 'Provider angelegt');
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  async function handleTest() {
    if (!provider?.id && !form.discoveryUrl) return;
    setTesting(true); setTestResult(null);
    try {
      if (provider?.id) {
        const r = await api.post<{ success: boolean; message: string; issuer?: string }>(`/admin/sso/providers/${provider.id}/test`, {});
        setTestResult(r);
      } else {
        // Test by directly fetching the discovery URL
        const resp = await fetch(form.discoveryUrl);
        if (!resp.ok) { setTestResult({ success: false, message: `HTTP ${resp.status}` }); return; }
        const doc = await resp.json() as { issuer?: string };
        setTestResult({ success: true, message: 'Discovery-Dokument abgerufen', issuer: doc.issuer });
      }
    } catch (e) {
      setTestResult({ success: false, message: (e as Error).message });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="space-y-5 max-w-2xl">
      <div className="card p-5 space-y-4">
        <p className="text-sm font-semibold text-gray-700">{isEdit ? `Provider bearbeiten: ${provider!.name}` : 'Neuer OIDC-Provider'}</p>

        {!isEdit && (
          <div>
            <p className="text-xs font-medium text-gray-600 mb-2">Schnellauswahl (Vorlage laden):</p>
            <div className="flex flex-wrap gap-2">
              {PRESET_PROVIDERS.map(p => (
                <button key={p.name} onClick={() => { set('name', p.name); set('discoveryUrl', p.url); }}
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50 hover:border-accent transition-colors">
                  <span>{p.icon}</span>{p.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {!isEdit && (
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">Domain *</label>
            <select value={form.domainId} onChange={e => set('domainId', e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent">
              <option value="">Domain wählen…</option>
              {domains.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
        )}

        <div>
          <label className="text-xs font-medium text-gray-600 block mb-1">Anbieter-Name *</label>
          <input value={form.name} onChange={e => set('name', e.target.value)}
            placeholder="z. B. Azure AD, Google Workspace, Keycloak"
            className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" />
        </div>

        <div>
          <label className="text-xs font-medium text-gray-600 block mb-1">Discovery-URL (OIDC) *</label>
          <input value={form.discoveryUrl} onChange={e => set('discoveryUrl', e.target.value)}
            placeholder="https://login.microsoftonline.com/{tenant-id}/v2.0/.well-known/openid-configuration"
            className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent" />
          <p className="text-xs text-gray-400 mt-1">
            OIDC-Konfigurationsendpunkt des Identitätsanbieters (Pfad endet auf <code className="bg-gray-100 px-1 rounded">/.well-known/openid-configuration</code>)
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">Client ID *</label>
            <input value={form.clientId} onChange={e => set('clientId', e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent" />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">
              Client Secret {isEdit && <span className="text-gray-400">(leer = unverändert)</span>}
            </label>
            <input type="password" value={form.clientSecret} onChange={e => set('clientSecret', e.target.value)}
              placeholder={isEdit ? '••••••••' : ''}
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-6 pt-2 border-t border-gray-100">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-800">Auto-Provisionierung</p>
              <p className="text-xs text-gray-500">Postfach beim ersten Login anlegen</p>
            </div>
            <Toggle active={form.autoProvision} onToggle={() => set('autoProvision', !form.autoProvision)} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-800">Aktiv</p>
              <p className="text-xs text-gray-500">Provider für Anmeldung verfügbar</p>
            </div>
            <Toggle active={form.active} onToggle={() => set('active', !form.active)} />
          </div>
        </div>
      </div>

      {testResult && (
        <div className={`flex items-start gap-2 p-3 rounded-lg border text-sm ${
          testResult.success ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-800'
        }`}>
          {testResult.success ? <CheckCircle2 size={15} className="shrink-0 mt-0.5" /> : <XCircle size={15} className="shrink-0 mt-0.5" />}
          <div>
            <p>{testResult.message}</p>
            {testResult.issuer && <p className="text-xs mt-0.5 font-mono opacity-75">Issuer: {testResult.issuer}</p>}
          </div>
        </div>
      )}

      <div className="flex gap-3">
        <button onClick={onCancel}
          className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50">
          Abbrechen
        </button>
        <button onClick={handleTest} disabled={testing || !form.discoveryUrl}
          className="flex items-center gap-2 px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50">
          <TestTube2 size={14} />
          {testing ? 'Teste…' : 'Discovery-URL testen'}
        </button>
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending || !form.name || !form.discoveryUrl || !form.clientId || (!isEdit && !form.domainId)}
          className="flex items-center gap-2 px-5 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-60"
        >
          <Save size={14} />
          {save.isPending ? 'Speichern…' : isEdit ? 'Aktualisieren' : 'Provider anlegen'}
        </button>
      </div>
    </div>
  );
}

// ─── Providers List ───────────────────────────────────────────────────────────

function ProvidersSection() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editingProvider, setEditingProvider] = useState<OidcProvider | undefined>();

  const { data: providers = [], refetch } = useQuery<OidcProvider[]>({
    queryKey: ['admin-sso-providers'],
    queryFn:  () => api.get('/admin/sso/providers'),
  });

  const { data: domains = [] } = useQuery<Domain[]>({
    queryKey: ['admin-sso-domains'],
    queryFn:  () => api.get('/admin/sso/domains'),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/sso/providers/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-sso-providers'] }); toast.success('Provider gelöscht'); },
    onError: (e: Error) => toast.error(e.message),
  });

  if (showForm || editingProvider) {
    return (
      <ProviderForm
        provider={editingProvider}
        domains={domains}
        onSaved={() => { setShowForm(false); setEditingProvider(undefined); }}
        onCancel={() => { setShowForm(false); setEditingProvider(undefined); }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end gap-2">
        <button onClick={() => refetch()} className="p-2 text-gray-500 border border-gray-300 rounded hover:bg-gray-50"><RefreshCw size={13} /></button>
        <button onClick={() => setShowForm(true)}
          className="flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90">
          <Plus size={14} /> Provider hinzufügen
        </button>
      </div>

      {providers.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 py-16 text-center">
          <Fingerprint size={28} className="mx-auto text-gray-300 mb-3" />
          <p className="text-sm font-medium text-gray-500">Keine SSO-Provider konfiguriert</p>
          <p className="text-xs text-gray-400 mt-1">Füge Azure AD, Google, Keycloak oder einen beliebigen OIDC-Provider hinzu</p>
        </div>
      ) : (
        <div className="space-y-3">
          {providers.map(p => (
            <div key={p.id} className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-3">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm ${
                    p.active ? 'bg-green-100' : 'bg-gray-100'
                  }`}>
                    <Fingerprint size={16} className={p.active ? 'text-green-600' : 'text-gray-400'} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-gray-900">{p.name}</p>
                      {p.active
                        ? <span className="text-xs px-1.5 py-0.5 bg-green-100 text-green-700 rounded-full">aktiv</span>
                        : <span className="text-xs px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded-full">inaktiv</span>}
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">Domain: <span className="font-medium">{p.domainName}</span></p>
                    <p className="text-xs font-mono text-gray-400 mt-0.5 truncate max-w-[400px]">{p.discoveryUrl}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <a href={p.discoveryUrl} target="_blank" rel="noopener noreferrer"
                    className="p-1.5 text-gray-400 hover:text-blue-600" title="Discovery-URL öffnen">
                    <ExternalLink size={13} />
                  </a>
                  <button onClick={() => setEditingProvider(p)} className="p-1.5 text-gray-400 hover:text-accent" title="Bearbeiten">
                    <Edit2 size={13} />
                  </button>
                  <button onClick={() => { if (confirm(`Provider „${p.name}" löschen?`)) deleteMut.mutate(p.id); }}
                    className="p-1.5 text-gray-400 hover:text-red-500" title="Löschen">
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
              <div className="mt-3 pt-3 border-t border-gray-100 flex gap-4 text-xs text-gray-500">
                <span>Client ID: <code className="font-mono text-gray-700">{p.clientId}</code></span>
                <span>{p.autoProvision ? '✓ Auto-Provisionierung' : '✗ Kein Auto-Provisioning'}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── SAML Section ─────────────────────────────────────────────────────────────

function SamlSection() {
  return (
    <div className="space-y-4 max-w-2xl">
      <div className="card p-5 space-y-3">
        <div className="flex items-center gap-2">
          <ShieldCheck size={18} className="text-accent" />
          <p className="text-sm font-semibold text-gray-700">SAML 2.0</p>
        </div>
        <p className="text-sm text-gray-600 leading-relaxed">
          SAML 2.0 wird über das <strong>auth-sso</strong>-Paket unterstützt. Die Konfiguration erfolgt
          über Umgebungsvariablen im Container oder direkt im <code className="bg-gray-100 px-1 rounded text-xs">auth-sso</code>-Service.
        </p>
        <div className="space-y-2">
          {[
            { label: 'Service Provider Entity ID', value: 'https://mail.domain.de/auth/saml/metadata' },
            { label: 'Assertion Consumer Service URL', value: 'https://mail.domain.de/auth/saml/callback' },
            { label: 'Single Logout URL', value: 'https://mail.domain.de/auth/saml/logout' },
            { label: 'Metadata', value: 'https://mail.domain.de/auth/saml/metadata.xml' },
          ].map(row => (
            <div key={row.label} className="flex items-start gap-3 py-2 border-b border-gray-100 last:border-0">
              <span className="text-xs text-gray-500 w-48 shrink-0">{row.label}</span>
              <code className="text-xs font-mono text-gray-700 break-all">{row.value}</code>
            </div>
          ))}
        </div>
      </div>

      <div className="card p-5 space-y-3">
        <p className="text-sm font-semibold text-gray-700">Unterstützte Identity Provider</p>
        <div className="grid grid-cols-2 gap-2">
          {[
            { name: 'Azure Active Directory / Entra ID', status: '✅' },
            { name: 'Okta',                              status: '✅' },
            { name: 'OneLogin',                          status: '✅' },
            { name: 'ADFS (Active Directory Federation Services)', status: '✅' },
            { name: 'Shibboleth',                        status: '✅' },
            { name: 'G Suite / Google Workspace',        status: '✅' },
          ].map(idp => (
            <div key={idp.name} className="flex items-center gap-2 text-sm text-gray-700 py-1">
              <span>{idp.status}</span>{idp.name}
            </div>
          ))}
        </div>
      </div>

      <div className="flex gap-2 bg-blue-50 border border-blue-100 rounded-lg p-3 text-xs text-blue-700">
        <Info size={13} className="shrink-0 mt-0.5" />
        <p>
          Die SAML-Konfiguration für einen spezifischen Identity Provider erfolgt über die Umgebungsvariablen
          <code className="bg-blue-100 px-1 rounded mx-1">SAML_IDP_METADATA_URL</code> oder
          <code className="bg-blue-100 px-1 rounded mx-1">SAML_IDP_ENTRY_POINT</code>
          in der <code className="bg-blue-100 px-1 rounded">.env</code>-Datei.
          Ein GUI-Editor wird in einer zukünftigen Version ergänzt.
        </p>
      </div>
    </div>
  );
}

// ─── Settings Section ─────────────────────────────────────────────────────────

function SettingsSection() {
  return (
    <div className="space-y-4 max-w-2xl">
      <div className="card p-5 space-y-4">
        <p className="text-sm font-semibold text-gray-700">Allgemeine SSO-Einstellungen</p>
        <p className="text-xs text-gray-500">
          Diese Einstellungen gelten global für alle konfigurierten SSO-Provider.
          Providerspezifische Optionen wie Auto-Provisionierung können pro Provider konfiguriert werden.
        </p>

        <div className="divide-y divide-gray-100">
          {[
            { label: 'Lokale Anmeldung als Fallback', desc: 'Benutzer können sich auch mit lokalem Passwort anmelden, wenn SSO nicht verfügbar ist', default: true },
            { label: 'SSO-Login auf Login-Seite anzeigen', desc: 'Schaltfläche für SSO-Anmeldung auf der OWA/BCP-Loginseite einblenden', default: true },
            { label: 'Automatische Weiterleitung', desc: 'Für Domains mit genau einem aktiven Provider automatisch zum IdP weiterleiten', default: false },
          ].map(s => (
            <div key={s.label} className="flex items-start justify-between py-3">
              <div>
                <p className="text-sm font-medium text-gray-800">{s.label}</p>
                <p className="text-xs text-gray-500 mt-0.5">{s.desc}</p>
              </div>
              <Toggle active={s.default} onToggle={() => {}} disabled />
            </div>
          ))}
        </div>
      </div>

      <div className="card p-5 space-y-3">
        <p className="text-sm font-semibold text-gray-700">Redirect-URIs</p>
        <p className="text-xs text-gray-500">Diese URIs müssen beim Identity Provider als erlaubte Weiterleitungs-URLs eingetragen werden.</p>
        <div className="space-y-2">
          {[
            { label: 'OIDC Callback',       uri: '/auth/oidc/callback' },
            { label: 'SAML ACS',            uri: '/auth/saml/callback' },
            { label: 'Logout Redirect',     uri: '/auth/logout' },
          ].map(r => (
            <div key={r.label} className="flex items-center gap-3 py-1.5 border-b border-gray-100 last:border-0">
              <span className="text-xs text-gray-500 w-32">{r.label}</span>
              <code className="text-xs font-mono text-gray-700 bg-gray-50 px-2 py-1 rounded flex-1">
                https://mail.domain.de{r.uri}
              </code>
            </div>
          ))}
        </div>
      </div>

      <div className="flex gap-2 bg-amber-50 border border-amber-100 rounded-lg p-3 text-xs text-amber-700">
        <AlertCircle size={13} className="shrink-0 mt-0.5" />
        <p>
          Die globalen SSO-Einstellungen werden in einer zukünftigen Version in der Datenbank gespeichert.
          Aktuell werden die Standardwerte verwendet; verwende Umgebungsvariablen für Änderungen.
        </p>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function SsoPage() {
  const [section, setSection] = useState<Section>('providers');

  return (
    <div className="h-full flex">
      <nav className="w-44 shrink-0 bg-[#1e2433] flex flex-col py-4 gap-0.5">
        <p className="text-[10px] text-gray-500 uppercase tracking-widest px-4 pb-2">Single Sign-On</p>
        {SECTIONS.map(s => (
          <button key={s.key} onClick={() => setSection(s.key)}
            className={`flex items-center gap-2 px-4 py-2 text-sm text-left transition-colors ${
              section === s.key ? 'bg-white/10 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
            }`}>
            {s.icon}<span>{s.label}</span>
          </button>
        ))}
      </nav>

      <div className="flex-1 overflow-y-auto">
        <div className="p-6 max-w-5xl">
          <div className="flex items-center gap-3 mb-6">
            <Fingerprint size={20} className="text-accent" />
            <div>
              <h1 className="text-xl font-semibold text-gray-900">Single Sign-On (SSO)</h1>
              <p className="text-xs text-gray-500">{SECTIONS.find(s => s.key === section)?.label} · OIDC / OAuth2 / SAML 2.0</p>
            </div>
          </div>

          {section === 'providers' && <ProvidersSection />}
          {section === 'saml'      && <SamlSection />}
          {section === 'settings'  && <SettingsSection />}
        </div>
      </div>
    </div>
  );
}
