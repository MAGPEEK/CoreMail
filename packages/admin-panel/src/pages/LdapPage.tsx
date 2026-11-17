import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Server, Plus, Trash2, RefreshCw, CheckCircle2, XCircle,
  TestTube2, Save, ChevronRight, Network, Settings, RotateCcw, AlertCircle,
  Database,
} from 'lucide-react';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';
import { Toggle as ToggleSwitch } from '../components/Toggle.js';
import { Can, WriteGuard } from '../components/Can.js';
import { useT } from '../i18n/useT.js';

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
  enabled?:    boolean;
  startTls?:   boolean;
  tlsVerify?:  boolean;
  syncIntervalMinutes?: number;
  lastSyncResult?: SyncResult | null;
}

interface SyncResult {
  ok: boolean;
  error?: string;
  found?: number; created?: number; updated?: number; deactivated?: number; reactivated?: number; skipped?: number;
  conflicts?: string[];
  finishedAt?: string;
}

interface LdapConfig extends LdapSummary {
  userDN:      string;
  userFilter:  string;
  groupFilter: string | null;
  attributeMap: Record<string, string>;
  tlsCaCert?:  string | null;
  allowLocalTakeover?: boolean;
  hasBindPassword?: boolean;
}

interface LdapTestResult {
  success: boolean;
  message: string;
  steps?: { step: string; ok: boolean; detail?: string }[];
  usersFound?: number | string;
  lookup?: { email: string; found: boolean; dn?: string; mailMatches?: boolean; ambiguous?: boolean };
}

function syncSummary(r: SyncResult | null | undefined): string {
  if (!r) return '—';
  if (!r.ok) return `Fehler: ${r.error ?? 'unbekannt'}`;
  return `${r.found ?? 0} gefunden · ${r.created ?? 0} neu · ${r.updated ?? 0} aktualisiert · ${r.deactivated ?? 0} deaktiviert`
    + (r.reactivated ? ` · ${r.reactivated} reaktiviert` : '')
    + (r.conflicts?.length ? ` · ${r.conflicts.length} Konflikt(e)` : '');
}

interface Domain { id: string; name: string }

type Section = 'list' | 'detail' | 'sync' | 'attributemap';

const SECTIONS: { key: Section; label: string; icon: React.ReactNode }[] = [
  { key: 'list',       label: 'Verbindungen',      icon: <Network size={14} /> },
  { key: 'sync',       label: 'Synchronisation',   icon: <RotateCcw size={14} /> },
  { key: 'attributemap', label: 'Attributzuordnung', icon: <Database size={14} /> },
  { key: 'detail',     label: 'Einstellungen',     icon: <Settings size={14} /> },
];

// Keys = what @coremail/auth-ldap reads (email, displayName, uid = stable directory id).
const DEFAULT_ATTR_MAP: Record<string, string> = {
  email:       'mail',
  displayName: 'displayName',
  uid:         'objectGUID',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDt(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return <ToggleSwitch active={value} onToggle={() => onChange(!value)} />;
}

// ─── Connection List ──────────────────────────────────────────────────────────

function ConnectionsList({
  configs, onSelect, onDelete, onSync, syncing,
}: {
  configs: LdapSummary[];
  onSelect: (domainId: string) => void;
  onDelete: (domainId: string) => void;
  onSync: (domainId: string) => void;
  syncing: boolean;
}) {
  return (
    <div className="space-y-3">
      {configs.length === 0 ? (
        <div className="bg-surface rounded-lg border border-line py-16 text-center">
          <Network size={28} className="mx-auto text-fg-subtle mb-3" />
          <p className="text-sm font-medium text-fg-subtle">Keine LDAP-Verbindungen konfiguriert</p>
          <p className="text-xs text-fg-subtle mt-1">Klicke auf „Neue Verbindung" um zu beginnen</p>
        </div>
      ) : (
        <div className="bg-surface rounded-lg border border-line overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-2 border-b border-line text-xs font-semibold text-fg-subtle uppercase tracking-wide">
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
                <tr key={c.domainId} className="border-b border-line hover:bg-surface-2">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className={`w-2 h-2 rounded-full ${c.enabled === false ? 'bg-surface-3' : 'bg-success'}`} title={c.enabled === false ? 'LDAP-Anmeldung deaktiviert' : 'aktiv'} />
                      <span className="font-medium text-fg">{c.domainName}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs font-mono text-fg-muted">
                    {c.ssl ? 'ldaps://' : 'ldap://'}{c.host}:{c.port}
                  </td>
                  <td className="px-4 py-3 text-xs font-mono text-fg-muted truncate max-w-[180px]">{c.baseDN}</td>
                  <td className="px-4 py-3 text-center">
                    {c.syncEnabled
                      ? <span className="text-xs px-1.5 py-0.5 bg-success-bg text-success-fg rounded-full">aktiv</span>
                      : <span className="text-xs px-1.5 py-0.5 bg-surface-2 text-fg-subtle rounded-full">inaktiv</span>}
                  </td>
                  <td className="px-4 py-3 text-xs text-fg-subtle">{fmtDt(c.lastSyncAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <Can area="identity" access="write" mode="hide">
                      <button aria-label="Jetzt synchronisieren" onClick={() => onSync(c.domainId)} title="Jetzt synchronisieren"
                        disabled={syncing || c.enabled === false}
                        className="p-1 text-fg-subtle hover:text-accent-fg transition-colors disabled:opacity-40"><RotateCcw size={13} className={syncing ? 'animate-spin' : ''} /></button>
                      </Can>
                      <button aria-label="Konfigurieren" onClick={() => onSelect(c.domainId)} title="Konfigurieren"
                        className="p-1 text-fg-subtle hover:text-accent-fg transition-colors"><Settings size={13} /></button>
                      <Can area="identity" access="write" mode="hide">
                      <button aria-label="Löschen" onClick={() => { if (confirm(`LDAP-Konfiguration für „${c.domainName}" löschen? LDAP-Benutzer dieser Domain können sich danach nicht mehr mit dem Verzeichnis-Passwort anmelden.`)) onDelete(c.domainId); }}
                        className="p-1 text-fg-subtle hover:text-danger-fg transition-colors"><Trash2 size={13} /></button>
                      </Can>
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
    enabled:     true,
    startTls:    false,
    tlsVerify:   true,
    tlsCaCert:   '',
    allowLocalTakeover: false,
    syncIntervalMinutes: 1440,
  });

  const loaded = useRef(false);
  useEffect(() => {
    if (existing && !loaded.current) {
      loaded.current = true;
      // bindPassword is never returned — empty = keep the stored one
      setForm(f => ({
        ...f, ...existing, groupFilter: existing.groupFilter ?? '', tlsCaCert: existing.tlsCaCert ?? '', bindPassword: '',
      }));
    }
  }, [existing]);

  const [testResult, setTestResult] = useState<LdapTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [testEmail, setTestEmail] = useState('');

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
      const r = await api.post<LdapTestResult>(`/admin/ldap/${form.domainId}/test`, testEmail ? { email: testEmail } : {});
      setTestResult(r);
    } catch (e) {
      setTestResult({ success: false, message: (e as Error).message });
    } finally {
      setTesting(false);
    }
  }

  const set = (k: keyof typeof form, v: unknown) => setForm(f => ({ ...f, [k]: v }));

  const portOk = Number.isInteger(form.port) && form.port >= 1 && form.port <= 65535;
  const canSave = !!form.domainId && !!form.host.trim() && portOk && !!form.baseDN.trim() && !!form.bindDN.trim()
    && !!form.userDN.trim() && form.userFilter.includes('{{') && (!!existing || !!form.bindPassword);

  return (
    <WriteGuard area="identity" className="space-y-5 max-w-2xl">
      <div className="card p-5 space-y-4">
        <p className="text-sm font-semibold text-fg-muted">Verbindung</p>

        {!domainId && (
          <div>
            <label className="text-xs font-medium text-fg-muted block mb-1">Domain *</label>
            <select value={form.domainId} onChange={e => set('domainId', e.target.value)}
              className="w-full border border-line-strong rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-fg">
              <option value="">Domain wählen…</option>
              {domains.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
        )}

        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <label className="text-xs font-medium text-fg-muted block mb-1">LDAP-Host / IP *</label>
            <input value={form.host} onChange={e => set('host', e.target.value)}
              placeholder="dc.meinefirma.de"
              className="w-full border border-line-strong rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-fg" />
          </div>
          <div>
            <label className="text-xs font-medium text-fg-muted block mb-1">Port *</label>
            <input type="number" value={form.port} onChange={e => set('port', e.target.value === '' ? 0 : Number(e.target.value))}
              className="w-full border border-line-strong rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-fg" />
          </div>
        </div>

        <div className="flex items-center justify-between py-2 border-t border-line">
          <div>
            <p className="text-sm font-medium text-fg">LDAPS (SSL/TLS)</p>
            <p className="text-xs text-fg-subtle">Empfohlen für Produktivumgebungen (Port 636)</p>
          </div>
          <Toggle value={form.ssl} onChange={v => { set('ssl', v); set('port', v ? 636 : 389); }} />
        </div>

        {!form.ssl && (
          <div className="flex items-center justify-between py-2 border-t border-line">
            <div>
              <p className="text-sm font-medium text-fg">StartTLS</p>
              <p className="text-xs text-fg-subtle">Verschlüsselung auf Port 389. Ohne LDAPS/StartTLS wird die Verbindung abgelehnt (Ausnahme: localhost oder LDAP_ALLOW_INSECURE=true).</p>
            </div>
            <Toggle value={form.startTls} onChange={v => set('startTls', v)} />
          </div>
        )}

        <div className="flex items-center justify-between py-2 border-t border-line">
          <div>
            <p className="text-sm font-medium text-fg">Zertifikat prüfen</p>
            <p className="text-xs text-fg-subtle">Serverzertifikat gegen vertrauenswürdige CAs prüfen (empfohlen)</p>
          </div>
          <Toggle value={form.tlsVerify} onChange={v => set('tlsVerify', v)} />
        </div>

        <div>
          <label className="text-xs font-medium text-fg-muted block mb-1">Eigene CA (PEM, optional)</label>
          <textarea value={form.tlsCaCert} onChange={e => set('tlsCaCert', e.target.value)} rows={3}
            placeholder="-----BEGIN CERTIFICATE-----"
            className="w-full border border-line-strong rounded px-3 py-1.5 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-accent-fg" />
        </div>

        <div>
          <label className="text-xs font-medium text-fg-muted block mb-1">Base DN *</label>
          <input value={form.baseDN} onChange={e => set('baseDN', e.target.value)}
            placeholder="DC=meinefirma,DC=de"
            className="w-full border border-line-strong rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent-fg" />
        </div>

        <div>
          <label className="text-xs font-medium text-fg-muted block mb-1">Bind DN (Service-Account) *</label>
          <input value={form.bindDN} onChange={e => set('bindDN', e.target.value)}
            placeholder="CN=coremail-svc,OU=ServiceAccounts,DC=meinefirma,DC=de"
            className="w-full border border-line-strong rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent-fg" />
        </div>

        <div>
          <label className="text-xs font-medium text-fg-muted block mb-1">
            Bind-Passwort {existing ? <span className="text-fg-subtle">(leer = unverändert)</span> : '*'}
          </label>
          <input type="password" value={form.bindPassword} onChange={e => set('bindPassword', e.target.value)}
            placeholder={existing?.hasBindPassword ? '••••••••' : ''} autoComplete="new-password"
            className="w-full border border-line-strong rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-fg" />
        </div>
      </div>

      <div className="card p-5 space-y-4">
        <p className="text-sm font-semibold text-fg-muted">Benutzer-Suche</p>

        <div>
          <label className="text-xs font-medium text-fg-muted block mb-1">User DN *</label>
          <input value={form.userDN} onChange={e => set('userDN', e.target.value)}
            placeholder="OU=Users,DC=meinefirma,DC=de"
            className="w-full border border-line-strong rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent-fg" />
        </div>

        <div>
          <label className="text-xs font-medium text-fg-muted block mb-1">Benutzer-Filter</label>
          <input value={form.userFilter} onChange={e => set('userFilter', e.target.value)}
            className="w-full border border-line-strong rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent-fg" />
          <p className="text-xs text-fg-subtle mt-1">
            <code className="bg-surface-2 px-1 rounded">{'{{username}}'}</code> = Teil vor dem @ der Login-Adresse,
            <code className="bg-surface-2 px-1 rounded mx-1">{'{{email}}'}</code> = vollständige Adresse (Sonderzeichen werden maskiert).
            Active Directory: <code className="bg-surface-2 px-1 rounded">(sAMAccountName={'{{username}}'})</code>.
            Das Attribut <code className="bg-surface-2 px-1 rounded">mail</code> des Eintrags muss der Login-Adresse entsprechen.
          </p>
        </div>

        <div>
          <label className="text-xs font-medium text-fg-muted block mb-1">Sync-Filter (optional)</label>
          <input value={form.groupFilter ?? ''} onChange={e => set('groupFilter', e.target.value)}
            placeholder="(memberOf=CN=Mail-Users,OU=Groups,DC=meinefirma,DC=de)"
            className="w-full border border-line-strong rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent-fg" />
          <p className="text-xs text-fg-subtle mt-1">Schränkt die Synchronisation zusätzlich ein (UND-verknüpft mit Personen mit mail-Attribut).</p>
        </div>

        <div className="flex items-center justify-between py-2 border-t border-line">
          <div>
            <p className="text-sm font-medium text-fg">LDAP-Anmeldung aktiv</p>
            <p className="text-xs text-fg-subtle">Benutzer dieser Domain melden sich mit ihrem Verzeichnis-Passwort an</p>
          </div>
          <Toggle value={form.enabled} onChange={v => set('enabled', v)} />
        </div>

        <div className="flex items-center justify-between py-2 border-t border-line">
          <div>
            <p className="text-sm font-medium text-fg">Lokale Konten übernehmen</p>
            <p className="text-xs text-fg-subtle">Ein lokales CoreMail-Konto mit derselben Adresse wird beim LDAP-Login/Sync zum LDAP-Konto (lokales Passwort entfällt). Standard: aus.</p>
          </div>
          <Toggle value={form.allowLocalTakeover} onChange={v => set('allowLocalTakeover', v)} />
        </div>

        <div className="flex items-center justify-between py-2 border-t border-line gap-4">
          <div>
            <p className="text-sm font-medium text-fg">Geplante Synchronisation</p>
            <p className="text-xs text-fg-subtle">Benutzer anlegen, aktualisieren und deaktivieren (nie löschen)</p>
          </div>
          <div className="flex items-center gap-2">
            <select value={form.syncIntervalMinutes} onChange={e => set('syncIntervalMinutes', parseInt(e.target.value))}
              disabled={!form.syncEnabled}
              className="border border-line-strong rounded px-2 py-1 text-xs disabled:opacity-50">
              <option value={60}>stündlich</option>
              <option value={360}>alle 6 h</option>
              <option value={720}>alle 12 h</option>
              <option value={1440}>täglich</option>
              <option value={10080}>wöchentlich</option>
            </select>
            <Toggle value={form.syncEnabled} onChange={v => set('syncEnabled', v)} />
          </div>
        </div>
      </div>

      {/* Test result */}
      {testResult && (
        <div className={`flex items-start gap-2 p-3 rounded-lg border text-sm ${
          testResult.success
            ? 'bg-success-bg border-success-line text-success-fg'
            : 'bg-danger-bg border-danger-line text-danger-fg'
        }`}>
          {testResult.success ? <CheckCircle2 size={15} className="shrink-0 mt-0.5" /> : <XCircle size={15} className="shrink-0 mt-0.5" />}
          <div className="space-y-0.5 min-w-0">
            <p>{testResult.message}</p>
            {testResult.steps?.map(s => (
              <p key={s.step} className="text-xs font-mono break-all">{s.ok ? '✓' : '✗'} {s.step}: {s.detail}</p>
            ))}
            {testResult.lookup && (
              <p className="text-xs">
                {testResult.lookup.email}: {testResult.lookup.found
                  ? `${testResult.lookup.ambiguous ? 'mehrdeutig' : testResult.lookup.dn}${testResult.lookup.mailMatches === false ? ' — mail-Attribut passt NICHT' : ''}`
                  : 'nicht gefunden'}
              </p>
            )}
          </div>
        </div>
      )}

      <div className="flex gap-3">
        <input value={testEmail} onChange={e => setTestEmail(e.target.value)} placeholder="Test-Adresse (optional)"
          className="border border-line-strong rounded px-3 py-1.5 text-sm w-56 focus:outline-none focus:ring-2 focus:ring-accent-fg" />
        <button
          onClick={handleTest}
          disabled={testing || !form.host || !existing}
          title={existing ? 'Testet die gespeicherte Konfiguration — Änderungen vorher speichern' : 'Zuerst speichern'}
          className="flex items-center gap-2 px-4 py-2 text-sm border border-line-strong rounded-lg hover:bg-surface-2 disabled:opacity-50"
        >
          <TestTube2 size={14} />
          {testing ? 'Teste…' : 'Verbindung testen'}
        </button>
        <button
          onClick={() => save.mutate(form)}
          disabled={save.isPending || !canSave}
          className="flex items-center gap-2 px-5 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-60"
        >
          <Save size={14} />
          {save.isPending ? 'Speichern…' : 'Konfiguration speichern'}
        </button>
      </div>
      <p className="text-xs text-fg-subtle">Der Verbindungstest verwendet die gespeicherte Konfiguration.</p>
    </WriteGuard>
  );
}

// ─── Sync Section ─────────────────────────────────────────────────────────────

function SyncSection({ configs }: { configs: LdapSummary[] }) {
  const qc = useQueryClient();

  const syncMut = useMutation({
    mutationFn: (domainId: string) => api.post<{ ok: boolean; syncedAt: string; result: SyncResult }>(`/admin/ldap/${domainId}/sync`, {}),
    onSuccess: (r, domainId) => {
      void qc.invalidateQueries({ queryKey: ['admin-ldap'] });
      toast.success(`${configs.find(c => c.domainId === domainId)?.domainName}: ${syncSummary({ ...r.result, ok: true })}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-4">
      <div className="flex gap-2 bg-info-bg border border-info-line rounded-lg p-3 text-xs text-info-fg">
        <AlertCircle size={13} className="shrink-0 mt-0.5" />
        <p>Die Synchronisation legt Benutzer aus dem Verzeichnis an (inkl. Postfach), aktualisiert Anzeigenamen und
          deaktiviert Konten, die im Verzeichnis fehlen oder dort deaktiviert sind — gelöscht wird nichts.
          Lokale Konten mit derselben Adresse werden nur mit „Lokale Konten übernehmen" angefasst (sonst: Konflikt).
          Geplante Läufe nach dem eingestellten Intervall (Standard: täglich).</p>
      </div>

      <div className="bg-surface rounded-lg border border-line overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface-2 border-b border-line text-xs font-semibold text-fg-subtle uppercase tracking-wide">
              <th className="text-left px-4 py-2.5">Domain</th>
              <th className="text-left px-4 py-2.5">Verbindung</th>
              <th className="text-center px-4 py-2.5">Status</th>
              <th className="text-left px-4 py-2.5">Letzter Sync</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {configs.length === 0 ? (
              <tr><td colSpan={5} className="text-center py-10 text-fg-subtle text-xs">Keine Verbindungen konfiguriert</td></tr>
            ) : configs.map(c => (
              <tr key={c.domainId} className="border-b border-line hover:bg-surface-2">
                <td className="px-4 py-3 font-medium text-fg">{c.domainName}</td>
                <td className="px-4 py-3 text-xs font-mono text-fg-muted">{c.ssl ? 'ldaps://' : 'ldap://'}{c.host}:{c.port}</td>
                <td className="px-4 py-3 text-center">
                  {c.syncEnabled
                    ? <span className="text-xs px-1.5 py-0.5 bg-success-bg text-success-fg rounded-full">aktiv</span>
                    : <span className="text-xs px-1.5 py-0.5 bg-surface-2 text-fg-subtle rounded-full">deaktiviert</span>}
                </td>
                <td className="px-4 py-3 text-xs text-fg-subtle">
                  {fmtDt(c.lastSyncAt)}
                  <div className="text-[11px] text-fg-subtle">{syncSummary(c.lastSyncResult)}</div>
                </td>
                <td className="px-4 py-3">
                  <Can area="identity" access="write">
                  <button
                    onClick={() => syncMut.mutate(c.domainId)}
                    disabled={c.enabled === false || syncMut.isPending}
                    className="flex items-center gap-1 text-xs px-2.5 py-1 border border-line rounded hover:bg-surface-2 disabled:opacity-40"
                  >
                    <RotateCcw size={11} className={syncMut.isPending && syncMut.variables === c.domainId ? 'animate-spin' : ''} /> Jetzt synchronisieren
                  </button>
                  </Can>
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
    // bindPassword '' = keep the stored password
    mutationFn: () => cfg ? api.put<LdapConfig>(`/admin/ldap/${selectedDomainId}`, { ...cfg, attributeMap: attrMap, bindPassword: '' }) : Promise.reject(new Error('Keine Konfiguration')),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-ldap'] }); toast.success('Attributzuordnung gespeichert'); },
    onError:   (e: Error) => toast.error(e.message),
  });

  const COREMAIL_ATTRS = [
    { key: 'email',       label: 'E-Mail-Adresse',  hint: 'mail — muss der Login-Adresse entsprechen' },
    { key: 'displayName', label: 'Anzeigename',      hint: 'displayName' },
    { key: 'uid',         label: 'Eindeutige ID',    hint: 'objectGUID (AD) / entryUUID (OpenLDAP) — bindet das Konto an den Verzeichniseintrag' },
  ];

  return (
    <WriteGuard area="identity" className="space-y-4 max-w-2xl">
      {configs.length > 1 && (
        <div>
          <label className="text-xs font-medium text-fg-muted block mb-1">Domain</label>
          <select value={selectedDomainId} onChange={e => setSelectedDomainId(e.target.value)}
            className="border border-line-strong rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-fg">
            {configs.map(c => <option key={c.domainId} value={c.domainId}>{c.domainName}</option>)}
          </select>
        </div>
      )}

      <div className="card p-5">
        <p className="text-sm font-semibold text-fg-muted mb-1">LDAP-Attributzuordnung</p>
        <p className="text-xs text-fg-subtle mb-4">
          Ordne LDAP-Attribute den CoreMail-Feldern zu. Linke Spalte: CoreMail-Feld. Rechte Spalte: LDAP-Attributname im Verzeichnis.
        </p>
        <div className="divide-y divide-line">
          {COREMAIL_ATTRS.map(attr => (
            <div key={attr.key} className="flex items-center gap-4 py-3">
              <div className="w-40">
                <p className="text-sm font-medium text-fg">{attr.label}</p>
                <p className="text-xs text-fg-subtle font-mono">{attr.key}</p>
              </div>
              <ChevronRight size={14} className="text-fg-subtle shrink-0" />
              <div className="flex-1">
                <input
                  value={attrMap[attr.key] ?? ''}
                  onChange={e => setAttrMap(m => ({ ...m, [attr.key]: e.target.value }))}
                  placeholder={attr.hint}
                  className="w-full border border-line-strong rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent-fg"
                />
                <p className="text-xs text-fg-subtle mt-0.5">{attr.hint}</p>
              </div>
            </div>
          ))}
        </div>

        <button
          onClick={() => save.mutate()}
          disabled={save.isPending || !selectedDomainId || !cfg}
          className="mt-4 flex items-center gap-2 px-5 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 disabled:opacity-60"
        >
          <Save size={14} />
          {save.isPending ? 'Speichern…' : 'Zuordnung speichern'}
        </button>
      </div>

      <div className="flex gap-2 bg-warning-bg border border-warning-line rounded-lg p-3 text-xs text-warning-fg">
        <AlertCircle size={13} className="shrink-0 mt-0.5" />
        <p>
          <strong>Active Directory:</strong> Typische Attribute: <code className="bg-warning-bg px-1 rounded">sAMAccountName</code> (Login),
          <code className="bg-warning-bg px-1 rounded mx-1">displayName</code>,
          <code className="bg-warning-bg px-1 rounded">mail</code>,
          <code className="bg-warning-bg px-1 rounded mx-1">givenName</code>,
          <code className="bg-warning-bg px-1 rounded">sn</code>
          (Nachname).
          OpenLDAP verwendet häufig <code className="bg-warning-bg px-1 rounded mx-1">uid</code> statt <code className="bg-warning-bg px-1 rounded">sAMAccountName</code>.
        </p>
      </div>
    </WriteGuard>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function LdapPage() {
  const t = useT();
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
      toast.success(`Sync abgeschlossen für ${configs.find(c => c.domainId === domainId)?.domainName}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="h-full flex">
      <nav className="w-44 shrink-0 bg-surface-2 border-r border-line flex flex-col py-4 gap-0.5">
        <p className="text-[10px] text-fg-subtle uppercase tracking-widest px-4 pb-2">LDAP / Active Directory</p>
        {SECTIONS.map(s => (
          <button key={s.key} onClick={() => { setSection(s.key); setShowNewForm(false); setEditingDomainId(null); }}
            className={`flex items-center gap-2 px-4 py-2 text-sm text-left transition-colors ${
              section === s.key ? 'bg-surface-3 text-fg' : 'text-fg-muted hover:bg-surface-3 hover:text-fg'
            }`}>
            {s.icon}<span>{s.label}</span>
          </button>
        ))}
      </nav>

      <div className="flex-1 overflow-y-auto">
        <div className="p-6 max-w-5xl">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <Server size={20} className="text-accent-fg" />
              <div>
                <h1 className="text-xl font-semibold text-fg">{t('page_ldap')}</h1>
                <p className="text-xs text-fg-subtle">{SECTIONS.find(s => s.key === section)?.label}</p>
              </div>
            </div>
            <div className="flex gap-2">
              <button aria-label="Aktualisieren" onClick={() => refetch()} className="flex items-center gap-1.5 px-3 py-2 text-sm text-fg-muted border border-line-strong rounded hover:bg-surface-2">
                <RefreshCw size={13} />
              </button>
              {section === 'list' && !showNewForm && !editingDomainId && (
                <Can area="identity" access="write" mode="hide">
                <button onClick={() => setShowNewForm(true)}
                  className="flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90">
                  <Plus size={14} /> Neue Verbindung
                </button>
                </Can>
              )}
            </div>
          </div>

          {section === 'list' && !showNewForm && !editingDomainId && (
            <ConnectionsList
              configs={configs}
              onSelect={id => setEditingDomainId(id)}
              onDelete={id => deleteMut.mutate(id)}
              onSync={id => syncMut.mutate(id)}
              syncing={syncMut.isPending}
            />
          )}
          {(showNewForm || editingDomainId) && (
            <div>
              <button onClick={() => { setShowNewForm(false); setEditingDomainId(null); }}
                className="text-xs text-fg-subtle hover:text-fg mb-4 flex items-center gap-1">
                ← Zurück zur Liste
              </button>
              <ConfigForm
                key={editingDomainId ?? 'new'}
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
              key={configs[0]?.domainId ?? 'new'}
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
