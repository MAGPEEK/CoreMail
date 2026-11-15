import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Fingerprint, Plus, Trash2, RefreshCw, CheckCircle2, XCircle,
  TestTube2, Save, List, Info, ExternalLink, Edit2, AlertTriangle, Copy,
} from 'lucide-react';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';
import { Toggle } from '../components/Toggle.js';

// v6.1: OIDC / OAuth2 single sign-on (authorization code + PKCE). SAML is not supported.

// ─── Types ────────────────────────────────────────────────────────────────────

interface OidcProvider {
  id:            string;
  domainId:      string;
  domainName:    string;
  name:          string;
  discoveryUrl:  string;
  clientId:      string;
  hasClientSecret: boolean;
  claimMap:      Record<string, string>;
  autoProvision: boolean;
  forcedDomains: string[];
  scopes:        string;
  requireEmailVerified: boolean;
  allowLinking:  boolean;
  requireMfa:    boolean;
  active:        boolean;
  createdAt:     string;
  redirectUri:   string;
}

interface Domain { id: string; name: string }

interface DiscoveryResult {
  success: boolean;
  message: string;
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  jwksUri?: string;
  pkceS256?: boolean;
  scopesSupported?: string[];
  idTokenAlgs?: string[];
  warnings?: string[];
  redirectUri?: string;
}

type Section = 'providers' | 'info';

const SECTIONS: { key: Section; label: string; icon: React.ReactNode }[] = [
  { key: 'providers', label: 'OIDC-Anbieter', icon: <List size={14} /> },
  { key: 'info',      label: 'Hinweise',      icon: <Info size={14} /> },
];

const PRESET_PROVIDERS: { name: string; url: string; hint?: string; requireEmailVerified?: boolean; claimMap?: Record<string, string> }[] = [
  { name: 'Microsoft Entra ID', url: 'https://login.microsoftonline.com/{tenant-id}/v2.0/.well-known/openid-configuration',
    hint: 'Entra sendet kein email_verified — Prüfung deaktiviert, E-Mail aus dem Claim „email“ (optionaler Claim in der App-Registrierung).',
    requireEmailVerified: false },
  { name: 'Keycloak',  url: 'https://keycloak.example.com/realms/{realm}/.well-known/openid-configuration' },
  { name: 'Authentik', url: 'https://authentik.example.com/application/o/{slug}/.well-known/openid-configuration' },
  { name: 'Google Workspace', url: 'https://accounts.google.com/.well-known/openid-configuration' },
  { name: 'Okta',      url: 'https://{domain}.okta.com/.well-known/openid-configuration' },
];

const input = 'w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent';

function DiscoveryBox({ r }: { r: DiscoveryResult }) {
  return (
    <div className={`flex items-start gap-2 p-3 rounded-lg border text-sm ${
      r.success ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-800'
    }`}>
      {r.success ? <CheckCircle2 size={15} className="shrink-0 mt-0.5" /> : <XCircle size={15} className="shrink-0 mt-0.5" />}
      <div className="space-y-0.5 min-w-0">
        <p>{r.message}</p>
        {r.success && (
          <dl className="text-xs font-mono opacity-80 grid grid-cols-[9rem_1fr] gap-x-2">
            <dt>Issuer</dt><dd className="break-all">{r.issuer}</dd>
            <dt>Authorization</dt><dd className="break-all">{r.authorizationEndpoint}</dd>
            <dt>Token</dt><dd className="break-all">{r.tokenEndpoint}</dd>
            <dt>JWKS</dt><dd className="break-all">{r.jwksUri}</dd>
            <dt>PKCE S256</dt><dd>{r.pkceS256 ? 'ja' : 'nicht angegeben'}</dd>
            <dt>ID-Token-Alg.</dt><dd>{r.idTokenAlgs?.join(', ') || '—'}</dd>
            {r.redirectUri && (<><dt>Redirect-URI</dt><dd className="break-all">{r.redirectUri}</dd></>)}
          </dl>
        )}
        {r.warnings?.map(w => (
          <p key={w} className="text-xs text-amber-700 flex items-center gap-1"><AlertTriangle size={12} />{w}</p>
        ))}
      </div>
    </div>
  );
}

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
    scopes:        provider?.scopes        ?? 'openid email profile',
    emailClaim:    provider?.claimMap?.['email'] ?? '',
    autoProvision: provider?.autoProvision ?? true,
    requireEmailVerified: provider?.requireEmailVerified ?? true,
    allowLinking:  provider?.allowLinking  ?? false,
    requireMfa:    provider?.requireMfa    ?? false,
    active:        provider?.active        ?? true,
    forcedDomains: (provider?.forcedDomains ?? []).join(', '),
  });
  const [hint, setHint] = useState<string | undefined>();
  const [testResult, setTestResult] = useState<DiscoveryResult | null>(null);
  const [testing, setTesting] = useState(false);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm(f => ({ ...f, [k]: v }));

  const payload = () => {
    const { emailClaim, forcedDomains, domainId, clientSecret, ...rest } = form;
    return {
      ...rest,
      ...(isEdit ? {} : { domainId }),
      ...(clientSecret ? { clientSecret } : {}),
      claimMap: { ...(provider?.claimMap ?? {}), ...(emailClaim.trim() ? { email: emailClaim.trim() } : {}) },
      forcedDomains: forcedDomains.split(/[\s,;]+/).map(d => d.trim().toLowerCase()).filter(Boolean),
    };
  };

  const save = useMutation({
    mutationFn: (): Promise<unknown> => isEdit
      ? api.put(`/admin/sso/providers/${provider!.id}`, payload())
      : api.post('/admin/sso/providers', payload()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-sso-providers'] });
      toast.success(isEdit ? 'Provider aktualisiert' : 'Provider angelegt');
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  async function handleTest() {
    setTesting(true); setTestResult(null);
    try {
      const r = isEdit && form.discoveryUrl === provider!.discoveryUrl
        ? await api.post<DiscoveryResult>(`/admin/sso/providers/${provider!.id}/test`, {})
        : await api.post<DiscoveryResult>('/admin/sso/test-discovery', { discoveryUrl: form.discoveryUrl });
      setTestResult(r);
    } catch (e) {
      setTestResult({ success: false, message: (e as Error).message });
    } finally {
      setTesting(false);
    }
  }

  const row = (label: string, desc: string, k: 'autoProvision' | 'requireEmailVerified' | 'allowLinking' | 'requireMfa' | 'active') => (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-sm font-medium text-gray-800">{label}</p>
        <p className="text-xs text-gray-500">{desc}</p>
      </div>
      <Toggle active={form[k]} onToggle={() => set(k, !form[k])} />
    </div>
  );

  return (
    <div className="space-y-5 max-w-2xl">
      <div className="card p-5 space-y-4">
        <p className="text-sm font-semibold text-gray-700">{isEdit ? `Provider bearbeiten: ${provider!.name}` : 'Neuer OIDC-Provider'}</p>

        {!isEdit && (
          <div>
            <p className="text-xs font-medium text-gray-600 mb-2">Vorlage laden:</p>
            <div className="flex flex-wrap gap-2">
              {PRESET_PROVIDERS.map(p => (
                <button key={p.name} type="button" onClick={() => {
                  setForm(f => ({ ...f, name: p.name, discoveryUrl: p.url, requireEmailVerified: p.requireEmailVerified ?? true }));
                  setHint(p.hint);
                }}
                  className="text-xs px-2.5 py-1.5 border border-gray-200 rounded-lg hover:bg-gray-50 hover:border-accent transition-colors">
                  {p.name}
                </button>
              ))}
            </div>
            {hint && <p className="text-xs text-amber-700 mt-2">{hint}</p>}
          </div>
        )}

        {!isEdit && (
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">Domain *</label>
            <select value={form.domainId} onChange={e => set('domainId', e.target.value)} className={input}>
              <option value="">Domain wählen…</option>
              {domains.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
        )}

        <div>
          <label className="text-xs font-medium text-gray-600 block mb-1">Anzeigename (Login-Button) *</label>
          <input value={form.name} onChange={e => set('name', e.target.value)} placeholder="z. B. Firmen-Login" className={input} />
        </div>

        <div>
          <label className="text-xs font-medium text-gray-600 block mb-1">Discovery-URL (OIDC) *</label>
          <input value={form.discoveryUrl} onChange={e => set('discoveryUrl', e.target.value)} className={`${input} font-mono`} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">Client ID *</label>
            <input value={form.clientId} onChange={e => set('clientId', e.target.value)} className={`${input} font-mono`} />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">
              Client Secret {isEdit ? <span className="text-gray-400">(leer = unverändert)</span> : '*'}
            </label>
            <input type="password" value={form.clientSecret} onChange={e => set('clientSecret', e.target.value)}
              placeholder={isEdit && provider!.hasClientSecret ? '••••••••' : ''} autoComplete="new-password" className={input} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">Scopes</label>
            <input value={form.scopes} onChange={e => set('scopes', e.target.value)} className={`${input} font-mono`} />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">E-Mail-Claim</label>
            <input value={form.emailClaim} onChange={e => set('emailClaim', e.target.value)} placeholder="email" className={`${input} font-mono`} />
          </div>
        </div>

        <div>
          <label className="text-xs font-medium text-gray-600 block mb-1">Erlaubte E-Mail-Domains</label>
          <input value={form.forcedDomains} onChange={e => set('forcedDomains', e.target.value)}
            placeholder="leer = nur die Domain dieses Providers" className={input} />
          <p className="text-xs text-gray-400 mt-1">Kommagetrennt. Jede Domain muss zusätzlich in CoreMail angelegt sein.</p>
        </div>

        <div className="space-y-3 pt-3 border-t border-gray-100">
          {row('Aktiv', 'Provider erscheint auf den Login-Seiten', 'active')}
          {row('Auto-Provisionierung', 'Unbekannte Benutzer beim ersten Login anlegen (inkl. Postfach)', 'autoProvision')}
          {row('E-Mail-Verifizierung verlangen', 'email_verified=true erforderlich — nur für IdPs abschalten, die den Claim nie senden', 'requireEmailVerified')}
          {row('Bestehende Konten verknüpfen', 'Lokale/LDAP-Konten mit derselben verifizierten Adresse dürfen sich per SSO anmelden', 'allowLinking')}
          {row('CoreMail-MFA zusätzlich verlangen', 'Benutzer mit eingerichteter MFA müssen nach dem IdP noch den Code eingeben', 'requireMfa')}
        </div>
      </div>

      {testResult && <DiscoveryBox r={testResult} />}

      <div className="flex gap-3">
        <button onClick={onCancel} className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50">
          Abbrechen
        </button>
        <button onClick={handleTest} disabled={testing || !form.discoveryUrl}
          className="flex items-center gap-2 px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50">
          <TestTube2 size={14} />
          {testing ? 'Teste…' : 'Discovery testen'}
        </button>
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending || !form.name || !form.discoveryUrl || !form.clientId || (!isEdit && (!form.domainId || !form.clientSecret))}
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
  const [results, setResults] = useState<Record<string, DiscoveryResult>>({});

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

  const test = async (id: string) => {
    try {
      const r = await api.post<DiscoveryResult>(`/admin/sso/providers/${id}/test`, {});
      setResults(x => ({ ...x, [id]: r }));
    } catch (e) {
      setResults(x => ({ ...x, [id]: { success: false, message: (e as Error).message } }));
    }
  };

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
        <button aria-label="Aktualisieren" onClick={() => refetch()} className="p-2 text-gray-500 border border-gray-300 rounded hover:bg-gray-50"><RefreshCw size={13} /></button>
        <button onClick={() => setShowForm(true)}
          className="flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90">
          <Plus size={14} /> Provider hinzufügen
        </button>
      </div>

      {providers.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 py-16 text-center">
          <Fingerprint size={28} className="mx-auto text-gray-300 mb-3" />
          <p className="text-sm font-medium text-gray-500">Keine SSO-Provider konfiguriert</p>
          <p className="text-xs text-gray-400 mt-1">Entra ID, Keycloak, Authentik, Google, Okta oder ein beliebiger OIDC-Provider</p>
        </div>
      ) : (
        <div className="space-y-3">
          {providers.map(p => (
            <div key={p.id} className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-3 min-w-0">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${p.active ? 'bg-green-100' : 'bg-gray-100'}`}>
                    <Fingerprint size={16} className={p.active ? 'text-green-600' : 'text-gray-400'} />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-gray-900">{p.name}</p>
                      {p.active
                        ? <span className="text-xs px-1.5 py-0.5 bg-green-100 text-green-700 rounded-full">aktiv</span>
                        : <span className="text-xs px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded-full">inaktiv</span>}
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">Domain: <span className="font-medium">{p.domainName}</span>
                      {p.forcedDomains.length > 0 && <> · erlaubt: {p.forcedDomains.join(', ')}</>}</p>
                    <p className="text-xs font-mono text-gray-400 mt-0.5 truncate max-w-[480px]">{p.discoveryUrl}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button aria-label="Discovery testen" onClick={() => void test(p.id)} className="p-1.5 text-gray-400 hover:text-accent" title="Discovery testen">
                    <TestTube2 size={13} />
                  </button>
                  <a href={p.discoveryUrl} target="_blank" rel="noopener noreferrer" className="p-1.5 text-gray-400 hover:text-blue-600" title="Discovery-URL öffnen">
                    <ExternalLink size={13} />
                  </a>
                  <button aria-label="Bearbeiten" onClick={() => setEditingProvider(p)} className="p-1.5 text-gray-400 hover:text-accent" title="Bearbeiten">
                    <Edit2 size={13} />
                  </button>
                  <button aria-label="Löschen" onClick={() => { if (confirm(`Provider „${p.name}" löschen?`)) deleteMut.mutate(p.id); }}
                    className="p-1.5 text-gray-400 hover:text-red-500" title="Löschen">
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
              <div className="pt-3 border-t border-gray-100 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                <span>Client ID: <code className="font-mono text-gray-700">{p.clientId}</code></span>
                <span>{p.autoProvision ? '✓ Auto-Provisionierung' : '✗ keine Auto-Provisionierung'}</span>
                <span>{p.requireEmailVerified ? '✓ email_verified Pflicht' : '⚠ email_verified nicht geprüft'}</span>
                {p.allowLinking && <span>✓ Kontoverknüpfung</span>}
                {p.requireMfa && <span>✓ CoreMail-MFA</span>}
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span className="text-gray-500 shrink-0">Redirect-URI:</span>
                <code className="font-mono text-gray-700 bg-gray-50 px-2 py-0.5 rounded truncate">{p.redirectUri}</code>
                <button aria-label="Kopieren" onClick={() => { void navigator.clipboard.writeText(p.redirectUri); toast.success('Kopiert'); }}
                  className="p-1 text-gray-400 hover:text-accent" title="Kopieren"><Copy size={12} /></button>
              </div>
              {results[p.id] && <DiscoveryBox r={results[p.id]!} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Info Section ─────────────────────────────────────────────────────────────

function InfoSection() {
  return (
    <div className="space-y-4 max-w-2xl text-sm text-gray-600">
      <div className="card p-5 space-y-2">
        <p className="font-semibold text-gray-700">Ablauf</p>
        <p>CoreMail ist OIDC-Client (Authorization Code + PKCE S256, state und nonce). Das ID-Token wird über das
          JWKS des Anbieters geprüft (Signatur, Issuer, Audience, Ablauf, nonce). SAML wird nicht unterstützt.</p>
        <p>Beim IdP als Redirect-URI eintragen: <code className="bg-gray-100 px-1 rounded text-xs">https://&lt;Ihr Host&gt;/auth/sso/&lt;Provider-ID&gt;/callback</code> —
          die genaue URI steht bei jedem Provider in der Liste.</p>
      </div>
      <div className="card p-5 space-y-2">
        <p className="font-semibold text-gray-700">Konten und MFA</p>
        <ul className="list-disc pl-5 space-y-1">
          <li>Die Adresse muss vom IdP verifiziert sein und zu einer erlaubten CoreMail-Domain gehören.</li>
          <li>Ein SSO-Konto wird beim ersten Login an die IdP-Identität (sub) gebunden.</li>
          <li>Bestehende lokale/LDAP-Konten werden nur mit „Bestehende Konten verknüpfen“ zugelassen.</li>
          <li>Standard: Der IdP gilt als zweiter Faktor. Die Admin-MFA-Pflicht ist erfüllt, wenn das ID-Token eine
            MFA-Methode im Claim <code className="bg-gray-100 px-1 rounded text-xs">amr</code> meldet oder „CoreMail-MFA zusätzlich verlangen“ aktiv ist.</li>
          <li>Mail-Clients (IMAP/SMTP/POP3) melden sich mit App-Passwörtern an — SSO-Konten haben kein CoreMail-Passwort.</li>
        </ul>
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
              <p className="text-xs text-gray-500">{SECTIONS.find(s => s.key === section)?.label} · OpenID Connect</p>
            </div>
          </div>

          {section === 'providers' && <ProvidersSection />}
          {section === 'info'      && <InfoSection />}
        </div>
      </div>
    </div>
  );
}
