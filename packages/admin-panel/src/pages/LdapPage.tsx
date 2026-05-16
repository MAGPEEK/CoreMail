import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Server, Plus, Trash2, RefreshCw, CheckCircle2, XCircle,
  TestTube2, Save, ChevronRight, Network, Settings, RotateCcw, AlertCircle,
  Database,
} from 'lucide-react';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';

// ─── Types ────────────────────────────────────────────────────────────────────

interface LdapSummary {
  domainId:    string;
  domainName:  string;
  host:        string;
  port:        number;
  ssl:         boolean;
  baseDN:      string;
  bindDN:      string;
  syncEnabled: boolean;
  lastSyncAt:  string | null;
}

interface LdapConfig extends LdapSummary {
  userDN:      string;
  userFilter:  string;
  groupFilter: string | null;
  attributeMap: Record<string, string>;
}

interface Domain { id: string; name: string }

type Section = 'list' | 'detail' | 'sync' | 'attributemap';

const SECTIONS: { key: Section; label: string; icon: React.ReactNode }[] = [
  { key: 'list',       label: 'Verbindungen',      icon: <Network size={14} /> },
  { key: 'sync',       label: 'Synchronisation',   icon: <RotateCcw size={14} /> },
  { key: 'attributemap', label: 'Attributzuordnung', icon: <Database size={14} /> },
  { key: 'detail',     label: 'Einstellungen',     icon: <Settings size={14} /> },
];

const DEFAULT_ATTR_MAP: Record<string, string> = {
  mail:        'mail',
  displayName: 'displayName',
  givenName:   'givenName',
  sn:          'sn',
  uid:         'sAMAccountName',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDt(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${value ? 'bg-accent' : 'bg-gray-300'}`}
    >
      <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform mt-0.5 ${value ? 'translate-x-4' : 'translate-x-0.5'}`} />
    </button>
  );
}

// ─── Connection List ──────────────────────────────────────────────────────────

function ConnectionsList({
  configs, onSelect, onDelete, onSync,
}: {
  configs: LdapSummary[];
  onSelect: (domainId: string) => void;
  onDelete: (domainId: string) => void;
  onSync: (domainId: string) => void;
}) {
  return (
    <div className="space-y-3">
      {configs.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 py-16 text-center">
          <Network size={28} className="mx-auto text-gray-300 mb-3" />
          <p className="text-sm font-medium text-gray-500">Keine LDAP-Verbindungen konfiguriert</p>
          <p className="text-xs text-gray-400 mt-1">Klicke auf „Neue Verbindung" um zu beginnen</p>
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                <th className="text-left px-4 py-2.5">Domain</th>
                <th className="text-left px-4 py-2.5">Host</th>
                <th className="text-left px-4 py-2.5">Base DN</th>
                <th className="text-center px-4 py-2.5">Sync</th>
                <th className="text-left px-4 py-2.5">Letzter Sync</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {configs.map(c => (
                <tr key={c.domainId} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-green-400" />
                      <span className="font-medium text-gray-800">{c.domainName}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs font-mono text-gray-700">
                    {c.ssl ? 'ldaps://' : 'ldap://'}{c.host}:{c.port}
                  </td>
                  <td className="px-4 py-3 text-xs font-mono text-gray-600 truncate max-w-[180px]">{c.baseDN}</td>
                  <td className="px-4 py-3 text-center">
                    {c.syncEnabled
                      ? <span className="text-xs px-1.5 py-0.5 bg-green-100 text-green-700 rounded-full">aktiv</span>
                      : <span className="text-xs px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded-full">inaktiv</span>}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">{fmtDt(c.lastSyncAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <button onClick={() => onSync(c.domainId)} title="Jetzt synchronisieren"
                        className="p-1 text-gray-400 hover:text-blue-600 transition-colors"><RotateCcw size={13} /></button>
                      <button onClick={() => onSelect(c.domainId)} title="Konfigurieren"
                        className="p-1 text-gray-400 hover:text-accent transition-colors"><Settings size={13} /></button>
                      <button onClick={() => { if (confirm(`LDAP-Konfiguration für „${c.domainName}" löschen?`)) onDelete(c.domainId); }}
                        className="p-1 text-gray-400 hover:text-red-500 transition-colors"><Trash2 size={13} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Config Form ──────────────────────────────────────────────────────────────

function ConfigForm({ domainId, domains, onSaved }: {
  domainId: string | null; domains: Domain[]; onSaved: () => void;
}) {
  const qc = useQueryClient();

  const { data: existing } = useQuery<LdapConfig>({
    queryKey: ['admin-ldap', domainId],
    queryFn:  () => api.get(`/admin/ldap/${domainId}`),
    enabled:  !!domainId,
  });

  const [form, setForm] = useState({
    domainId:    domainId ?? '',
    host:        '',
    port:        636,
    ssl:         true,
    baseDN:      '',
    bindDN:      '',
    bindPassword: '',
    userDN:      '',
    userFilter:  '(sAMAccountName={{username}})',
    groupFilter: '',
    syncEnabled: true,
  });

  const loaded = useRef(false);
  useEffect(() => {
    if (existing && !loaded.current) {
      loaded.current = true;
      setForm(f => ({ ...f, ...existing, groupFilter: existing.groupFilter ?? '', bindPassword: '••••••••' }));
    }
  }, [existing]);

  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const save = useMutation({
    mutationFn: (data: typeof form) => api.put<LdapConfig>(`/admin/ldap/${data.domainId}`, data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-ldap'] });
      toast.success('LDAP-Konfiguration gespeichert');
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  async function handleTest() {
    if (!form.domainId) return;
    setTesting(true); setTestResult(null);
    try {
      const r = await api.post<{ success: boolean; message: string }>(`/admin/ldap/${form.domainId}/test`, {});
      setTestResult(r);
    } catch (e) {
      setTestResult({ success: false, message: (e as Error).message });
    } finally {
      setTesting(false);
    }
  }

  const set = (k: keyof typeof form, v: unknown) => setForm(f => ({ ...f, [k]: v }));

  return (
    <div className="space-y-5 max-w-2xl">
      <div className="card p-5 space-y-4">
        <p className="text-sm font-semibold text-gray-700">Verbindung</p>

        {!domainId && (
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">Domain *</label>
            <select value={form.domainId} onChange={e => set('domainId', e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent">
              <option value="">Domain wählen…</option>
              {domains.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
        )}

        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <label className="text-xs font-medium text-gray-600 block mb-1">LDAP-Host / IP *</label>
            <input value={form.host} onChange={e => set('host', e.target.value)}
              placeholder="dc.meinefirma.de"
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">Port *</label>
            <input type="number" value={form.port} onChange={e => set('port', parseInt(e.target.value))}
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" />
          </div>
        </div>

        <div className="flex items-center justify-between py-2 border-t border-gray-100">
          <div>
            <p className="text-sm font-medium text-gray-800">LDAPS (SSL/TLS)</p>
            <p className="text-xs text-gray-500">Empfohlen für Produktivumgebungen (Port 636)</p>
          </div>
          <Toggle value={form.ssl} onChange={v => { set('ssl', v); set('port', v ? 636 : 389); }} />
        </div>

        <div>
          <label className="text-xs font-medium text-gray-600 block mb-1">Base DN *</label>
          <input value={form.baseDN} onChange={e => set('baseDN', e.target.value)}
            placeholder="DC=meinefirma,DC=de"
            className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent" />
        </div>

        <div>
          <label className="text-xs font-medium text-gray-600 block mb-1">Bind DN (Service-Account) *</label>
          <input value={form.bindDN} onChange={e => set('bindDN', e.target.value)}
            placeholder="CN=coremail-svc,OU=ServiceAccounts,DC=meinefirma,DC=de"
            className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent" />
        </div>

        <div>
          <label className="text-xs font-medium text-gray-600 block mb-1">Bind-Passwort *</label>
          <input type="password" value={form.bindPassword} onChange={e => set('bindPassword', e.target.value)}
            placeholder="••••••••"
            className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" />
        </div>
      </div>

      <div className="card p-5 space-y-4">
        <p className="text-sm font-semibold text-gray-700">Benutzer-Suche</p>

        <div>
          <label className="text-xs font-medium text-gray-600 block mb-1">User DN</label>
          <input value={form.userDN} onChange={e => set('userDN', e.target.value)}
            placeholder="OU=Users,DC=meinefirma,DC=de"
            className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent" />
        </div>

        <div>
          <label className="text-xs font-medium text-gray-600 block mb-1">Benutzer-Filter</label>
          <input value={form.userFilter} onChange={e => set('userFilter', e.target.value)}
            className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent" />
          <p className="text-xs text-gray-400 mt-1">
            <code className="bg-gray-100 px-1 rounded">{'{{username}}'}</code> wird durch den eingegebenen Benutzernamen ersetzt.
            Für Active Directory: <code className="bg-gray-100 px-1 rounded">(sAMAccountName={'{{username}}'})</code>
          </p>
        </div>

        <div>
          <label className="text-xs font-medium text-gray-600 block mb-1">Gruppen-Filter (optional)</label>
          <input value={form.groupFilter ?? ''} onChange={e => set('groupFilter', e.target.value)}
            placeholder="(objectClass=group)"
            className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent" />
        </div>

        <div className="flex items-center justify-between py-2 border-t border-gray-100">
          <div>
            <p className="text-sm font-medium text-gray-800">Synchronisation aktiviert</p>
            <p className="text-xs text-gray-500">Benutzer und Gruppen automatisch aus LDAP/AD synchronisieren</p>
          </div>
          <Toggle value={form.syncEnabled} onChange={v => set('syncEnabled', v)} />
        </div>
      </div>

      {/* Test result */}
      {testResult && (
        <div className={`flex items-start gap-2 p-3 rounded-lg border text-sm ${
          testResult.success
            ? 'bg-green-50 border-green-200 text-green-800'
            : 'bg-red-50 border-red-200 text-red-800'
        }`}>
          {testResult.success ? <CheckCircle2 size={15} className="shrink-0 mt-0.5" /> : <XCircle size={15} className="shrink-0 mt-0.5" />}
          {testResult.message}
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={handleTest}
          disabled={testing || !form.host}
          className="flex items-center gap-2 px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
        >
          <TestTube2 size={14} />
          {testing ? 'Teste…' : 'Verbindung testen'}
        </button>
        <button
          onClick={() => save.mutate(form)}
          disabled={save.isPending || !form.host || !form.baseDN}
          className="flex items-center gap-2 px-5 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-60"
        >
          <Save size={14} />
          {save.isPending ? 'Speichern…' : 'Konfiguration speichern'}
        </button>
      </div>
    </div>
  );
}

// ─── Sync Section ─────────────────────────────────────────────────────────────

function SyncSection({ configs }: { configs: LdapSummary[] }) {
  const qc = useQueryClient();

  const syncMut = useMutation({
    mutationFn: (domainId: string) => api.post<{ ok: boolean; syncedAt: string }>(`/admin/ldap/${domainId}/sync`, {}),
    onSuccess: (_r, domainId) => {
      void qc.invalidateQueries({ queryKey: ['admin-ldap'] });
      toast.success(`Sync für ${configs.find(c => c.domainId === domainId)?.domainName} gestartet`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-4">
      <div className="flex gap-2 bg-blue-50 border border-blue-100 rounded-lg p-3 text-xs text-blue-700">
        <AlertCircle size={13} className="shrink-0 mt-0.5" />
        <p>Der Sync-Prozess läuft im Hintergrund im <code className="bg-blue-100 px-1 rounded">auth-ldap</code>-Service.
          Der Zeitstempel wird nach dem Triggern sofort aktualisiert; die eigentliche Synchronisation erfolgt asynchron.</p>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide">
              <th className="text-left px-4 py-2.5">Domain</th>
              <th className="text-left px-4 py-2.5">Verbindung</th>
              <th className="text-center px-4 py-2.5">Status</th>
              <th className="text-left px-4 py-2.5">Letzter Sync</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {configs.length === 0 ? (
              <tr><td colSpan={5} className="text-center py-10 text-gray-400 text-xs">Keine Verbindungen konfiguriert</td></tr>
            ) : configs.map(c => (
              <tr key={c.domainId} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-800">{c.domainName}</td>
                <td className="px-4 py-3 text-xs font-mono text-gray-600">{c.ssl ? 'ldaps://' : 'ldap://'}{c.host}:{c.port}</td>
                <td className="px-4 py-3 text-center">
                  {c.syncEnabled
                    ? <span className="text-xs px-1.5 py-0.5 bg-green-100 text-green-700 rounded-full">aktiv</span>
                    : <span className="text-xs px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded-full">deaktiviert</span>}
                </td>
                <td className="px-4 py-3 text-xs text-gray-500">{fmtDt(c.lastSyncAt)}</td>
                <td className="px-4 py-3">
                  <button
                    onClick={() => syncMut.mutate(c.domainId)}
                    disabled={!c.syncEnabled || syncMut.isPending}
                    className="flex items-center gap-1 text-xs px-2.5 py-1 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-40"
                  >
                    <RotateCcw size={11} /> Jetzt synchronisieren
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Attribute Map Section ────────────────────────────────────────────────────

function AttributeMapSection({ configs }: { configs: LdapSummary[] }) {
  const [selectedDomainId, setSelectedDomainId] = useState(configs[0]?.domainId ?? '');
  const qc = useQueryClient();

  const { data: cfg } = useQuery<LdapConfig>({
    queryKey: ['admin-ldap', selectedDomainId],
    queryFn:  () => api.get(`/admin/ldap/${selectedDomainId}`),
    enabled:  !!selectedDomainId,
  });

  const [attrMap, setAttrMap] = useState<Record<string, string>>(DEFAULT_ATTR_MAP);
  const loaded = useRef(false);
  useEffect(() => {
    if (cfg && !loaded.current) {
      loaded.current = true;
      const merged = { ...DEFAULT_ATTR_MAP, ...(cfg.attributeMap as Record<string, string>) };
      setAttrMap(merged);
    }
  }, [cfg]);

  useEffect(() => { loaded.current = false; setAttrMap(DEFAULT_ATTR_MAP); }, [selectedDomainId]);

  const save = useMutation({
    mutationFn: () => cfg ? api.put<LdapConfig>(`/admin/ldap/${selectedDomainId}`, { ...cfg, attributeMap: attrMap, bindPassword: '••••••••' }) : Promise.reject(new Error('Keine Konfiguration')),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-ldap'] }); toast.success('Attributzuordnung gespeichert'); },
    onError:   (e: Error) => toast.error(e.message),
  });

  const COREMAIL_ATTRS = [
    { key: 'mail',        label: 'E-Mail-Adresse',  hint: 'mail' },
    { key: 'displayName', label: 'Anzeigename',      hint: 'displayName' },
    { key: 'givenName',   label: 'Vorname',          hint: 'givenName' },
    { key: 'sn',          label: 'Nachname',          hint: 'sn' },
    { key: 'uid',         label: 'Benutzername',     hint: 'sAMAccountName (AD) / uid (OpenLDAP)' },
  ];

  return (
    <div className="space-y-4 max-w-2xl">
      {configs.length > 1 && (
        <div>
          <label className="text-xs font-medium text-gray-600 block mb-1">Domain</label>
          <select value={selectedDomainId} onChange={e => setSelectedDomainId(e.target.value)}
            className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent">
            {configs.map(c => <option key={c.domainId} value={c.domainId}>{c.domainName}</option>)}
          </select>
        </div>
      )}

      <div className="card p-5">
        <p className="text-sm font-semibold text-gray-700 mb-1">LDAP-Attributzuordnung</p>
        <p className="text-xs text-gray-500 mb-4">
          Ordne LDAP-Attribute den CoreMail-Feldern zu. Linke Spalte: CoreMail-Feld. Rechte Spalte: LDAP-Attributname im Verzeichnis.
        </p>
        <div className="divide-y divide-gray-100">
          {COREMAIL_ATTRS.map(attr => (
            <div key={attr.key} className="flex items-center gap-4 py-3">
              <div className="w-40">
                <p className="text-sm font-medium text-gray-800">{attr.label}</p>
                <p className="text-xs text-gray-400 font-mono">{attr.key}</p>
              </div>
              <ChevronRight size={14} className="text-gray-400 shrink-0" />
              <div className="flex-1">
                <input
                  value={attrMap[attr.key] ?? ''}
                  onChange={e => setAttrMap(m => ({ ...m, [attr.key]: e.target.value }))}
                  placeholder={attr.hint}
                  className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent"
                />
                <p className="text-xs text-gray-400 mt-0.5">{attr.hint}</p>
              </div>
            </div>
          ))}
        </div>

        <button
          onClick={() => save.mutate()}
          disabled={save.isPending || !selectedDomainId}
          className="mt-4 flex items-center gap-2 px-5 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-60"
        >
          <Save size={14} />
          {save.isPending ? 'Speichern…' : 'Zuordnung speichern'}
        </button>
      </div>

      <div className="flex gap-2 bg-amber-50 border border-amber-100 rounded-lg p-3 text-xs text-amber-700">
        <AlertCircle size={13} className="shrink-0 mt-0.5" />
        <p>
          <strong>Active Directory:</strong> Typische Attribute: <code className="bg-amber-100 px-1 rounded">sAMAccountName</code> (Login),
          <code className="bg-amber-100 px-1 rounded mx-1">displayName</code>,
          <code className="bg-amber-100 px-1 rounded">mail</code>,
          <code className="bg-amber-100 px-1 rounded mx-1">givenName</code>,
          <code className="bg-amber-100 px-1 rounded">sn</code>
          (Nachname).
          OpenLDAP verwendet häufig <code className="bg-amber-100 px-1 rounded mx-1">uid</code> statt <code className="bg-amber-100 px-1 rounded">sAMAccountName</code>.
        </p>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function LdapPage() {
  const qc = useQueryClient();
  const [section, setSection] = useState<Section>('list');
  const [editingDomainId, setEditingDomainId] = useState<string | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);

  const { data: configs = [], refetch } = useQuery<LdapSummary[]>({
    queryKey: ['admin-ldap'],
    queryFn:  () => api.get('/admin/ldap'),
  });

  const { data: domains = [] } = useQuery<Domain[]>({
    queryKey: ['admin-sso-domains'],
    queryFn:  () => api.get('/admin/sso/domains'),
  });

  const deleteMut = useMutation({
    mutationFn: (domainId: string) => api.delete(`/admin/ldap/${domainId}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-ldap'] }); toast.success('Konfiguration gelöscht'); },
    onError:   (e: Error) => toast.error(e.message),
  });

  const syncMut = useMutation({
    mutationFn: (domainId: string) => api.post(`/admin/ldap/${domainId}/sync`, {}),
    onSuccess: (_d, domainId) => {
      void qc.invalidateQueries({ queryKey: ['admin-ldap'] });
      toast.success(`Sync gestartet für ${configs.find(c => c.domainId === domainId)?.domainName}`);
    },
  });

  return (
    <div className="h-full flex">
      <nav className="w-44 shrink-0 bg-[#1e2433] flex flex-col py-4 gap-0.5">
        <p className="text-[10px] text-gray-500 uppercase tracking-widest px-4 pb-2">LDAP / Active Directory</p>
        {SECTIONS.map(s => (
          <button key={s.key} onClick={() => { setSection(s.key); setShowNewForm(false); setEditingDomainId(null); }}
            className={`flex items-center gap-2 px-4 py-2 text-sm text-left transition-colors ${
              section === s.key ? 'bg-white/10 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
            }`}>
            {s.icon}<span>{s.label}</span>
          </button>
        ))}
      </nav>

      <div className="flex-1 overflow-y-auto">
        <div className="p-6 max-w-5xl">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <Server size={20} className="text-accent" />
              <div>
                <h1 className="text-xl font-semibold text-gray-900">LDAP / Active Directory</h1>
                <p className="text-xs text-gray-500">{SECTIONS.find(s => s.key === section)?.label}</p>
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => refetch()} className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50">
                <RefreshCw size={13} />
              </button>
              {section === 'list' && !showNewForm && (
                <button onClick={() => setShowNewForm(true)}
                  className="flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90">
                  <Plus size={14} /> Neue Verbindung
                </button>
              )}
            </div>
          </div>

          {section === 'list' && !showNewForm && !editingDomainId && (
            <ConnectionsList
              configs={configs}
              onSelect={id => setEditingDomainId(id)}
              onDelete={id => deleteMut.mutate(id)}
              onSync={id => syncMut.mutate(id)}
            />
          )}
          {(showNewForm || editingDomainId) && (
            <div>
              <button onClick={() => { setShowNewForm(false); setEditingDomainId(null); }}
                className="text-xs text-gray-500 hover:text-gray-800 mb-4 flex items-center gap-1">
                ← Zurück zur Liste
              </button>
              <ConfigForm
                domainId={editingDomainId}
                domains={domains.filter(d => !configs.some(c => c.domainId === d.id) || d.id === editingDomainId)}
                onSaved={() => { setShowNewForm(false); setEditingDomainId(null); setSection('list'); }}
              />
            </div>
          )}
          {section === 'sync'        && <SyncSection configs={configs} />}
          {section === 'attributemap' && <AttributeMapSection configs={configs} />}
          {section === 'detail' && (
            <ConfigForm
              domainId={configs[0]?.domainId ?? null}
              domains={domains}
              onSaved={() => void qc.invalidateQueries({ queryKey: ['admin-ldap'] })}
            />
          )}
        </div>
      </div>
    </div>
  );
}
