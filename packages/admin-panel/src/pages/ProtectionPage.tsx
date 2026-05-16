import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  LayoutDashboard, Zap, Bug, Database, Clock, Globe, Paperclip,
  CheckCircle, XCircle, RefreshCw, Plus, Trash2, AlertTriangle,
} from 'lucide-react';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SecuritySettings {
  greylistEnabled:      boolean;
  greylistWaitSec:      number;
  greylistTtlHours:     number;
  dnsblEnabled:         boolean;
  dnsblZones:           string[];
  geoipMode:            'DISABLED' | 'WHITELIST' | 'BLACKLIST';
  geoipCountries:       string[];
  attachmentEnabled:    boolean;
  attachmentMaxSizeMb:  number;
  attachmentBlockedExt: string[];
  rspamdEnabled:        boolean;
  rspamdGreylistScore:  number;
  rspamdSpamScore:      number;
  rspamdRejectScore:    number;
  clamavEnabled:        boolean;
}

interface RspamdStat {
  version?:     string;
  uptime?:      number;
  scanned?:     number;
  spam_count?:  number;
  ham_count?:   number;
  connections?: number;
  actions?: {
    reject?:       number;
    'add header'?: number;
    greylist?:     number;
  };
}

interface ContainerStatus {
  rspamd: { online: boolean; stat?: RspamdStat; error?: string };
  clamav: { online: boolean; version?: string; error?: string };
}

// ── Sub-navigation ────────────────────────────────────────────────────────────

type Section = 'overview' | 'rspamd' | 'antivirus' | 'dnsbl' | 'greylisting' | 'geoip' | 'attachments';

const SUB_NAV: { id: Section; label: string; icon: React.ElementType }[] = [
  { id: 'overview',    label: 'Übersicht',    icon: LayoutDashboard },
  { id: 'rspamd',      label: 'Rspamd 4.0',   icon: Zap },
  { id: 'antivirus',   label: 'Antivirus',    icon: Bug },
  { id: 'dnsbl',       label: 'DNSBL',        icon: Database },
  { id: 'greylisting', label: 'Greylisting',  icon: Clock },
  { id: 'geoip',       label: 'Länderfilter', icon: Globe },
  { id: 'attachments', label: 'Anhänge',      icon: Paperclip },
];

// ── Helper: online badge ───────────────────────────────────────────────────────

function OnlineBadge({ online }: { online: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full ${
      online ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full ${online ? 'bg-green-500' : 'bg-red-500'}`} />
      {online ? 'Online' : 'Offline'}
    </span>
  );
}

// ── Helper: section save button ───────────────────────────────────────────────

function SaveBtn({ onClick, pending }: { onClick: () => void; pending: boolean }) {
  return (
    <button onClick={onClick} disabled={pending} className="btn-primary text-sm disabled:opacity-50">
      {pending ? 'Speichern...' : 'Speichern'}
    </button>
  );
}

// ── Helper: number input ──────────────────────────────────────────────────────

function NumInput({ label, value, onChange, min, max, step = 1, unit }:
  { label: string; value: number; onChange: (v: number) => void; min: number; max: number; step?: number; unit?: string }) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-gray-100 last:border-0">
      <span className="text-sm text-gray-700">{label}</span>
      <div className="flex items-center gap-1.5">
        <input
          type="number" min={min} max={max} step={step} value={value}
          onChange={e => onChange(parseFloat(e.target.value) || min)}
          className="w-24 border border-gray-300 rounded px-2 py-1 text-sm text-right focus:outline-none focus:ring-1 focus:ring-accent"
        />
        {unit && <span className="text-xs text-gray-400 w-8">{unit}</span>}
      </div>
    </div>
  );
}

// ── Helper: toggle row ────────────────────────────────────────────────────────

function ToggleRow({ label, desc, value, onChange }:
  { label: string; desc?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-gray-100 last:border-0">
      <div>
        <p className="text-sm text-gray-800 font-medium">{label}</p>
        {desc && <p className="text-xs text-gray-400 mt-0.5">{desc}</p>}
      </div>
      <button
        onClick={() => onChange(!value)}
        className={`relative w-10 h-5.5 rounded-full transition-colors ${value ? 'bg-accent' : 'bg-gray-300'}`}
        style={{ height: 22, width: 40 }}
      >
        <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${value ? 'translate-x-5' : 'translate-x-0.5'}`} />
      </button>
    </div>
  );
}

// ── COUNTRIES list (ISO 3166-1 alpha-2 + German names) ────────────────────────

const COUNTRIES: [string, string][] = [
  ['AF','Afghanistan'],['AL','Albanien'],['DZ','Algerien'],['AD','Andorra'],['AO','Angola'],
  ['AR','Argentinien'],['AM','Armenien'],['AU','Australien'],['AT','Österreich'],['AZ','Aserbaidschan'],
  ['BD','Bangladesch'],['BY','Belarus'],['BE','Belgien'],['BO','Bolivien'],['BA','Bosnien und Herzegowina'],
  ['BR','Brasilien'],['BG','Bulgarien'],['CN','China'],['CL','Chile'],['CO','Kolumbien'],
  ['HR','Kroatien'],['CY','Zypern'],['CZ','Tschechien'],['DK','Dänemark'],['EG','Ägypten'],
  ['EE','Estland'],['FI','Finnland'],['FR','Frankreich'],['GE','Georgien'],['DE','Deutschland'],
  ['GH','Ghana'],['GR','Griechenland'],['GT','Guatemala'],['HU','Ungarn'],['IN','Indien'],
  ['ID','Indonesien'],['IR','Iran'],['IQ','Irak'],['IE','Irland'],['IL','Israel'],
  ['IT','Italien'],['JP','Japan'],['KZ','Kasachstan'],['KE','Kenia'],['KR','Südkorea'],
  ['XK','Kosovo'],['KW','Kuwait'],['KG','Kirgisistan'],['LV','Lettland'],['LB','Libanon'],
  ['LT','Litauen'],['LU','Luxemburg'],['MK','Nordmazedonien'],['MY','Malaysia'],['ML','Mali'],
  ['MT','Malta'],['MX','Mexiko'],['MD','Moldau'],['ME','Montenegro'],['MA','Marokko'],
  ['NL','Niederlande'],['NZ','Neuseeland'],['NG','Nigeria'],['NO','Norwegen'],['PK','Pakistan'],
  ['PE','Peru'],['PH','Philippinen'],['PL','Polen'],['PT','Portugal'],['RO','Rumänien'],
  ['RU','Russland'],['SA','Saudi-Arabien'],['RS','Serbien'],['SK','Slowakei'],['SI','Slowenien'],
  ['ZA','Südafrika'],['ES','Spanien'],['SE','Schweden'],['CH','Schweiz'],['TW','Taiwan'],
  ['TJ','Tadschikistan'],['TH','Thailand'],['TR','Türkei'],['TM','Turkmenistan'],['UA','Ukraine'],
  ['AE','Vereinigte Arabische Emirate'],['GB','Vereinigtes Königreich'],['US','USA'],
  ['UZ','Usbekistan'],['VN','Vietnam'],['YE','Jemen'],['ZW','Simbabwe'],
];

// ═════════════════════════════════════════════════════════════════════════════
// OverviewSection
// ═════════════════════════════════════════════════════════════════════════════

function OverviewSection() {
  const qc = useQueryClient();
  const { data: status, isLoading, dataUpdatedAt } = useQuery({
    queryKey: ['admin', 'security', 'status'],
    queryFn: () => api.get<ContainerStatus>('/admin/security/status'),
    refetchInterval: 30_000,
  });

  const r = status?.rspamd;
  const c = status?.clamav;
  const stat = r?.stat as RspamdStat | undefined;

  function fmtUptime(sec?: number) {
    if (!sec) return '—';
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-900">Container-Status</h2>
        <button onClick={() => qc.invalidateQueries({ queryKey: ['admin', 'security', 'status'] })}
          className="btn-ghost text-xs gap-1">
          <RefreshCw size={13} className={isLoading ? 'animate-spin' : ''} />
          Aktualisieren
        </button>
      </div>

      {dataUpdatedAt > 0 && (
        <p className="text-xs text-gray-400">
          Zuletzt aktualisiert: {new Date(dataUpdatedAt).toLocaleTimeString('de-DE')}
        </p>
      )}

      <div className="grid grid-cols-2 gap-4">
        {/* Rspamd card */}
        <div className="card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-purple-100 flex items-center justify-center">
                <Zap size={16} className="text-purple-600" />
              </div>
              <div>
                <p className="text-sm font-semibold text-gray-900">Rspamd</p>
                <p className="text-xs text-gray-400">{stat?.version ?? 'v4.0'} · Anti-Spam</p>
              </div>
            </div>
            {isLoading ? <span className="text-xs text-gray-400">…</span> : <OnlineBadge online={!!r?.online} />}
          </div>

          {r?.online && stat && (
            <div className="grid grid-cols-3 gap-2 pt-1 border-t border-gray-100">
              <div className="text-center">
                <p className="text-lg font-bold text-gray-900">{(stat.scanned ?? 0).toLocaleString()}</p>
                <p className="text-[10px] text-gray-400">Gescannt</p>
              </div>
              <div className="text-center">
                <p className="text-lg font-bold text-red-600">{(stat.spam_count ?? 0).toLocaleString()}</p>
                <p className="text-[10px] text-gray-400">Spam</p>
              </div>
              <div className="text-center">
                <p className="text-lg font-bold text-green-600">{(stat.ham_count ?? 0).toLocaleString()}</p>
                <p className="text-[10px] text-gray-400">Ham</p>
              </div>
            </div>
          )}
          {r?.online && stat?.uptime !== undefined && (
            <p className="text-xs text-gray-400 border-t border-gray-100 pt-2">
              Uptime: {fmtUptime(stat.uptime)}
            </p>
          )}
          {!r?.online && r?.error && (
            <p className="text-xs text-red-500 flex items-center gap-1">
              <AlertTriangle size={11} /> {r.error}
            </p>
          )}
        </div>

        {/* ClamAV card */}
        <div className="card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-emerald-100 flex items-center justify-center">
                <Bug size={16} className="text-emerald-600" />
              </div>
              <div>
                <p className="text-sm font-semibold text-gray-900">ClamAV</p>
                <p className="text-xs text-gray-400">Open-Source Antivirus</p>
              </div>
            </div>
            {isLoading ? <span className="text-xs text-gray-400">…</span> : <OnlineBadge online={!!c?.online} />}
          </div>

          {c?.online && c.version && (
            <div className="pt-1 border-t border-gray-100">
              <p className="text-xs text-gray-600 font-mono bg-gray-50 rounded px-2 py-1 break-all">
                {c.version}
              </p>
            </div>
          )}
          {!c?.online && c?.error && (
            <p className="text-xs text-red-500 flex items-center gap-1">
              <AlertTriangle size={11} /> {c.error}
            </p>
          )}
          {c?.online && (
            <p className="text-xs text-gray-400 border-t border-gray-100 pt-2">
              Signaturdatenbank wird täglich aktualisiert (freshclam)
            </p>
          )}
        </div>
      </div>

      {/* Feature matrix */}
      <div className="card overflow-hidden">
        <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Aktive Schutzmaßnahmen</p>
        </div>
        <table className="w-full text-sm">
          <tbody className="divide-y divide-gray-100">
            {[
              { label: 'SPF-Prüfung',          ok: true,  note: 'Sender Policy Framework' },
              { label: 'DKIM-Validierung',      ok: true,  note: 'DomainKeys Identified Mail' },
              { label: 'DMARC-Auswertung',      ok: true,  note: 'Domain-based Message Authentication' },
              { label: 'ARC-Validierung',       ok: true,  note: 'Authenticated Received Chain' },
              { label: 'Anti-Spam (Rspamd)',     ok: !!r?.online, note: r?.online ? `v${stat?.version ?? '4.0'} aktiv` : 'Container nicht erreichbar' },
              { label: 'Antivirus (ClamAV)',     ok: !!c?.online, note: c?.online ? 'Signaturen aktuell' : 'Container nicht erreichbar' },
              { label: 'Greylisting',           ok: true,  note: '5 min Wartezeit für Erstverbindungen' },
              { label: 'DNSBL (Spamhaus ZEN)',  ok: true,  note: 'zen.spamhaus.org' },
              { label: 'DNSBL (SpamCop)',       ok: true,  note: 'bl.spamcop.net' },
              { label: 'Attachment-Filter',     ok: true,  note: 'Gefährliche Dateitypen blockiert' },
            ].map(f => (
              <tr key={f.label} className="hover:bg-gray-50 transition-colors">
                <td className="px-4 py-2.5 font-medium text-gray-800 w-48">{f.label}</td>
                <td className="px-4 py-2.5 text-gray-400 text-xs">{f.note}</td>
                <td className="px-4 py-2.5 text-right pr-5">
                  {f.ok
                    ? <CheckCircle size={16} className="text-green-500 ml-auto" />
                    : <XCircle    size={16} className="text-red-400  ml-auto" />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// RspamdSection
// ═════════════════════════════════════════════════════════════════════════════

function RspamdSection({ settings, onSave }: { settings: SecuritySettings; onSave: (d: Partial<SecuritySettings>) => void }) {
  const [greylist, setGreylist] = useState(settings.rspamdGreylistScore);
  const [spam,     setSpam]     = useState(settings.rspamdSpamScore);
  const [reject,   setReject]   = useState(settings.rspamdRejectScore);
  const [enabled,  setEnabled]  = useState(settings.rspamdEnabled);

  const { data: stat, isLoading } = useQuery({
    queryKey: ['admin', 'security', 'rspamd', 'stat'],
    queryFn:  () => api.get<RspamdStat>('/admin/security/rspamd/stat'),
    retry: false,
  });

  const learnMut = useMutation({
    mutationFn: (type: 'spam' | 'ham') =>
      api.post<{ ok: boolean }>(`/admin/security/rspamd/learn/${type}`, {}),
    onSuccess: (_, type) => toast.success(`Rspamd Bayes: ${type === 'spam' ? 'Spam' : 'Ham'} gelernt`),
    onError:   () => toast.error('Rspamd nicht erreichbar'),
  });

  function save() {
    if (greylist >= spam) { toast.error('Greylisting-Score muss kleiner als Spam-Score sein'); return; }
    if (spam >= reject)   { toast.error('Spam-Score muss kleiner als Reject-Score sein'); return; }
    onSave({ rspamdEnabled: enabled, rspamdGreylistScore: greylist, rspamdSpamScore: spam, rspamdRejectScore: reject });
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-900">Rspamd 4.0 Konfiguration</h2>
        <SaveBtn onClick={save} pending={false} />
      </div>

      {/* Live stats */}
      {isLoading && <p className="text-xs text-gray-400">Lade Rspamd-Statistiken…</p>}
      {stat && (
        <div className="grid grid-cols-4 gap-3">
          {[
            { label: 'Version',     value: stat.version ?? '—' },
            { label: 'Gescannt',    value: (stat.scanned ?? 0).toLocaleString() },
            { label: 'Spam',        value: (stat.spam_count ?? 0).toLocaleString() },
            { label: 'Uptime',      value: stat.uptime ? `${Math.floor(stat.uptime / 3600)}h` : '—' },
          ].map(s => (
            <div key={s.label} className="card p-3 text-center">
              <p className="text-lg font-bold text-gray-900">{s.value}</p>
              <p className="text-xs text-gray-400">{s.label}</p>
            </div>
          ))}
        </div>
      )}

      {/* Thresholds */}
      <div className="card p-4 space-y-1">
        <p className="text-sm font-semibold text-gray-700 mb-3">Aktions-Schwellwerte</p>
        <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-xs text-blue-700 mb-3">
          Score ≥ Greylist → Greylisting · Score ≥ Spam → Header hinzufügen · Score ≥ Reject → Ablehnen
        </div>
        <ToggleRow label="Rspamd aktiviert" value={enabled} onChange={setEnabled} />
        <NumInput label="Greylisting-Score" value={greylist} onChange={setGreylist} min={0} max={20} step={0.5} />
        <NumInput label="Spam-Score (Add Header)" value={spam} onChange={setSpam} min={0} max={30} step={0.5} />
        <NumInput label="Reject-Score" value={reject} onChange={setReject} min={0} max={100} step={0.5} />
      </div>

      {/* Bayes training */}
      <div className="card p-4">
        <p className="text-sm font-semibold text-gray-700 mb-2">Bayes-Klassifikator trainieren</p>
        <p className="text-xs text-gray-400 mb-3">
          Trainiert den Rspamd Bayes-Filter manuell. Im Normalbetrieb lernt Rspamd automatisch über autolearn.
        </p>
        <div className="flex gap-2">
          <button onClick={() => learnMut.mutate('spam')} disabled={learnMut.isPending}
            className="btn-secondary text-sm text-red-600 border-red-200 hover:bg-red-50">
            Als Spam markieren
          </button>
          <button onClick={() => learnMut.mutate('ham')} disabled={learnMut.isPending}
            className="btn-secondary text-sm text-green-600 border-green-200 hover:bg-green-50">
            Als Ham markieren
          </button>
        </div>
      </div>

      {/* Symbol actions info */}
      <div className="card p-4">
        <p className="text-sm font-semibold text-gray-700 mb-2">Aktive Module</p>
        <div className="grid grid-cols-2 gap-2">
          {[
            ['SPF',    'Sender Policy Framework Prüfung'],
            ['DKIM',   'DKIM-Signatur Validierung'],
            ['DMARC',  'DMARC Policy Auswertung'],
            ['ARC',    'Authenticated Received Chain'],
            ['Bayes',  'Bayes-Spam-Klassifikator'],
            ['Fuzzy',  'Fuzzy-Hash-Matching'],
            ['DNSBL',  'DNS Blacklisten'],
            ['Mime',   'MIME-Struktur-Analyse'],
            ['URL',    'URL-Reputationsprüfung'],
            ['Headers','E-Mail-Header-Analyse'],
          ].map(([name, desc]) => (
            <div key={name} className="flex items-center gap-2 text-xs bg-gray-50 rounded px-2.5 py-1.5">
              <CheckCircle size={12} className="text-green-500 shrink-0" />
              <span className="font-medium text-gray-700">{name}</span>
              <span className="text-gray-400 truncate">{desc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// AntivirusSection
// ═════════════════════════════════════════════════════════════════════════════

function AntivirusSection({ settings, onSave }: { settings: SecuritySettings; onSave: (d: Partial<SecuritySettings>) => void }) {
  const [enabled, setEnabled] = useState(settings.clamavEnabled);

  const { data: status } = useQuery({
    queryKey: ['admin', 'security', 'status'],
    queryFn:  () => api.get<ContainerStatus>('/admin/security/status'),
    refetchInterval: 30_000,
  });

  const c = status?.clamav;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-900">Antivirus — ClamAV</h2>
        <SaveBtn onClick={() => onSave({ clamavEnabled: enabled })} pending={false} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="card p-4 space-y-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-emerald-100 rounded-lg flex items-center justify-center">
              <Bug size={16} className="text-emerald-600" />
            </div>
            <div>
              <p className="text-sm font-semibold">ClamAV</p>
              <p className="text-xs text-gray-400">Open-Source Antivirus Engine</p>
            </div>
          </div>
          <div className="flex items-center justify-between py-1">
            <span className="text-sm text-gray-600">Status</span>
            <OnlineBadge online={!!c?.online} />
          </div>
          {c?.version && (
            <div className="flex items-start justify-between py-1">
              <span className="text-sm text-gray-600">Version</span>
              <span className="text-xs font-mono text-gray-700 text-right max-w-[200px]">{c.version}</span>
            </div>
          )}
          <div className="flex items-center justify-between py-1">
            <span className="text-sm text-gray-600">Signaturen</span>
            <span className="text-xs text-gray-500">Täglich via freshclam</span>
          </div>
        </div>

        <div className="card p-4 space-y-2">
          <p className="text-sm font-semibold text-gray-700">Über ClamAV</p>
          <p className="text-xs text-gray-500 leading-relaxed">
            ClamAV ist eine freie, plattformübergreifende Anti-Malware Engine.
            Sie erkennt Viren, Trojaner, Malware und andere schädliche Bedrohungen
            in E-Mail-Anhängen und Nachrichten.
          </p>
          <div className="flex flex-wrap gap-1.5 pt-1">
            {['Open-Source (GPL)', 'ClamDB Signaturen', 'INSTREAM-Protokoll', 'freshclam Updates'].map(t => (
              <span key={t} className="text-[10px] bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-full border border-emerald-200">
                {t}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="card p-4">
        <ToggleRow
          label="ClamAV aktiviert"
          desc="Scannt alle eingehenden E-Mail-Anhänge auf Viren und Malware"
          value={enabled}
          onChange={setEnabled}
        />
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-700 flex items-start gap-2">
        <AlertTriangle size={13} className="shrink-0 mt-0.5" />
        <span>
          ClamAV läuft als separater Docker-Container (<code className="bg-blue-100 px-1 rounded">clamav/clamav:stable</code>).
          Der Container startet den freshclam-Daemon automatisch für tägliche Signatur-Updates.
          Verbindung: <code className="bg-blue-100 px-1 rounded">clamav:3310</code> (INSTREAM-Protokoll).
        </span>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// DnsblSection
// ═════════════════════════════════════════════════════════════════════════════

function DnsblSection({ settings, onSave }: { settings: SecuritySettings; onSave: (d: Partial<SecuritySettings>) => void }) {
  const [enabled, setEnabled] = useState(settings.dnsblEnabled);
  const [zones,   setZones]   = useState<string[]>(settings.dnsblZones);
  const [newZone, setNewZone] = useState('');

  function addZone() {
    const z = newZone.trim().toLowerCase();
    if (!z || zones.includes(z)) { setNewZone(''); return; }
    setZones(prev => [...prev, z]);
    setNewZone('');
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-900">DNSBL-Konfiguration</h2>
        <SaveBtn onClick={() => onSave({ dnsblEnabled: enabled, dnsblZones: zones })} pending={false} />
      </div>

      <div className="card p-4 space-y-1">
        <ToggleRow
          label="DNSBL aktiviert"
          desc="Prüft Absender-IPs gegen DNS-Blacklisten"
          value={enabled}
          onChange={setEnabled}
        />
      </div>

      <div className="card p-4 space-y-3">
        <p className="text-sm font-semibold text-gray-700">Aktive Blacklist-Zonen</p>
        <div className="space-y-1.5">
          {zones.map(z => (
            <div key={z} className="flex items-center justify-between bg-gray-50 rounded px-3 py-2">
              <span className="text-sm font-mono text-gray-700">{z}</span>
              <button onClick={() => setZones(prev => prev.filter(x => x !== z))}
                className="text-gray-400 hover:text-red-500 transition-colors">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        <div className="flex gap-2 mt-2">
          <input
            value={newZone}
            onChange={e => setNewZone(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addZone()}
            placeholder="z.B. zen.spamhaus.org"
            className="flex-1 border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button onClick={addZone} className="btn-secondary text-sm gap-1">
            <Plus size={13} /> Hinzufügen
          </button>
        </div>

        <div className="pt-2 border-t border-gray-100">
          <p className="text-xs text-gray-400 mb-2">Bekannte Blacklisten (klicken zum Hinzufügen):</p>
          <div className="flex flex-wrap gap-1.5">
            {['zen.spamhaus.org','bl.spamcop.net','b.barracudacentral.org','dnsbl.sorbs.net',
              'ix.dnsbl.manitu.net','0spam.fusionzero.com'].filter(z => !zones.includes(z)).map(z => (
              <button key={z} onClick={() => setZones(prev => [...prev, z])}
                className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 px-2 py-0.5 rounded transition-colors font-mono">
                + {z}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// GreylistingSection
// ═════════════════════════════════════════════════════════════════════════════

function GreylistingSection({ settings, onSave }: { settings: SecuritySettings; onSave: (d: Partial<SecuritySettings>) => void }) {
  const [enabled, setEnabled] = useState(settings.greylistEnabled);
  const [wait,    setWait]    = useState(settings.greylistWaitSec);
  const [ttl,     setTtl]     = useState(settings.greylistTtlHours);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-900">Greylisting</h2>
        <SaveBtn onClick={() => onSave({ greylistEnabled: enabled, greylistWaitSec: wait, greylistTtlHours: ttl })} pending={false} />
      </div>

      <div className="card p-4 space-y-1">
        <ToggleRow
          label="Greylisting aktiviert"
          desc="Unbekannte Absender werden beim ersten Versuch temporär abgewiesen (SMTP 451)"
          value={enabled}
          onChange={setEnabled}
        />
        <NumInput label="Wartezeit" value={wait} onChange={setWait} min={60} max={3600} step={60} unit="Sek" />
        <NumInput label="Whitelist-TTL (nach Passieren)" value={ttl} onChange={setTtl} min={1} max={168} unit="Std" />
      </div>

      <div className="card p-4 text-sm text-gray-600 space-y-2">
        <p className="font-medium text-gray-800">Wie Greylisting funktioniert</p>
        <ol className="list-decimal list-inside space-y-1 text-xs text-gray-500">
          <li>Erstkontakt: Verbindung wird mit SMTP 451 (Temp. Fehler) abgelehnt</li>
          <li>Legitime Server versuchen es nach {Math.round(wait / 60)} min erneut → wird akzeptiert</li>
          <li>Das Triplet (IP + Absender + Empfänger) wird {ttl}h lang in die Whitelist aufgenommen</li>
          <li>Spam-Bots wiederholen meist nicht → effektive Blockierung</li>
        </ol>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// GeoipSection
// ═════════════════════════════════════════════════════════════════════════════

function GeoipSection({ settings, onSave }: { settings: SecuritySettings; onSave: (d: Partial<SecuritySettings>) => void }) {
  const [mode,      setMode]      = useState<'DISABLED' | 'WHITELIST' | 'BLACKLIST'>(settings.geoipMode);
  const [countries, setCountries] = useState<string[]>(settings.geoipCountries);
  const [search,    setSearch]    = useState('');

  const filtered = COUNTRIES.filter(([code, name]) =>
    name.toLowerCase().includes(search.toLowerCase()) || code.toLowerCase().includes(search.toLowerCase())
  );

  function toggle(code: string) {
    setCountries(prev => prev.includes(code) ? prev.filter(c => c !== code) : [...prev, code]);
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-900">GeoIP-Länderfilter</h2>
        <SaveBtn onClick={() => onSave({ geoipMode: mode, geoipCountries: countries })} pending={false} />
      </div>

      <div className="card p-4 space-y-3">
        <p className="text-sm font-semibold text-gray-700">Filtermodus</p>
        <div className="grid grid-cols-3 gap-2">
          {(['DISABLED', 'WHITELIST', 'BLACKLIST'] as const).map(m => (
            <button key={m} onClick={() => setMode(m)}
              className={`rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors text-left ${
                mode === m ? 'border-accent bg-accent/10 text-accent' : 'border-gray-200 text-gray-600 hover:border-gray-300'
              }`}>
              <p className="font-semibold">
                {m === 'DISABLED' ? 'Deaktiviert' : m === 'WHITELIST' ? 'Whitelist' : 'Blacklist'}
              </p>
              <p className="text-[10px] mt-0.5 opacity-70">
                {m === 'DISABLED' ? 'Kein Länderfilter' :
                 m === 'WHITELIST' ? 'Nur ausgewählte Länder' : 'Ausgewählte Länder blockieren'}
              </p>
            </button>
          ))}
        </div>
      </div>

      {mode !== 'DISABLED' && (
        <div className="card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-gray-700">
              {mode === 'WHITELIST' ? 'Erlaubte Länder' : 'Blockierte Länder'}
              <span className="ml-2 text-xs font-normal text-gray-400">({countries.length} ausgewählt)</span>
            </p>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Suchen…"
              className="border border-gray-200 rounded px-2 py-1 text-xs w-36 focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
          <div className="grid grid-cols-3 gap-1 max-h-64 overflow-y-auto">
            {filtered.map(([code, name]) => (
              <label key={code} className="flex items-center gap-1.5 px-2 py-1.5 rounded hover:bg-gray-50 cursor-pointer">
                <input type="checkbox" checked={countries.includes(code)} onChange={() => toggle(code)}
                  className="rounded border-gray-300 text-accent focus:ring-accent" />
                <span className="text-xs text-gray-700 truncate" title={name}>
                  <span className="font-mono text-gray-400 mr-1">{code}</span>{name}
                </span>
              </label>
            ))}
          </div>
          {countries.length > 0 && (
            <button onClick={() => setCountries([])} className="text-xs text-gray-400 hover:text-red-500">
              Auswahl zurücksetzen
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// AttachmentsSection
// ═════════════════════════════════════════════════════════════════════════════

function AttachmentsSection({ settings, onSave }: { settings: SecuritySettings; onSave: (d: Partial<SecuritySettings>) => void }) {
  const [enabled, setEnabled]  = useState(settings.attachmentEnabled);
  const [maxSize, setMaxSize]  = useState(settings.attachmentMaxSizeMb);
  const [exts,    setExts]     = useState<string[]>(settings.attachmentBlockedExt);
  const [newExt,  setNewExt]   = useState('');

  function addExt() {
    const e = newExt.trim().toLowerCase().replace(/^\./, '');
    if (!e || exts.includes(e)) { setNewExt(''); return; }
    setExts(prev => [...prev, e]);
    setNewExt('');
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-900">Anhänge-Filter</h2>
        <SaveBtn onClick={() => onSave({ attachmentEnabled: enabled, attachmentMaxSizeMb: maxSize, attachmentBlockedExt: exts })} pending={false} />
      </div>

      <div className="card p-4 space-y-1">
        <ToggleRow label="Anhänge-Filter aktiviert" desc="Blockiert gefährliche Dateitypen in E-Mail-Anhängen" value={enabled} onChange={setEnabled} />
        <NumInput label="Maximale Anhangsgröße" value={maxSize} onChange={setMaxSize} min={1} max={500} unit="MB" />
      </div>

      <div className="card p-4 space-y-3">
        <p className="text-sm font-semibold text-gray-700">Blockierte Dateiendungen</p>
        <div className="flex flex-wrap gap-1.5">
          {exts.map(ext => (
            <span key={ext} className="flex items-center gap-1 bg-red-50 border border-red-200 text-red-700 text-xs px-2 py-0.5 rounded-full">
              .{ext}
              <button onClick={() => setExts(prev => prev.filter(e => e !== ext))}
                className="hover:text-red-900 ml-0.5">
                <XCircle size={11} />
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            value={newExt}
            onChange={e => setNewExt(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addExt()}
            placeholder="z.B. exe"
            className="flex-1 border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button onClick={addExt} className="btn-secondary text-sm gap-1">
            <Plus size={13} /> Hinzufügen
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5 pt-1 border-t border-gray-100">
          <p className="w-full text-xs text-gray-400 mb-1">Schnell hinzufügen:</p>
          {['ps1','vba','jar','msp','reg','inf','lnk','url','xls','doc'].filter(e => !exts.includes(e)).map(e => (
            <button key={e} onClick={() => setExts(prev => [...prev, e])}
              className="text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 px-2 py-0.5 rounded transition-colors">
              +.{e}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// ProtectionPage (root)
// ═════════════════════════════════════════════════════════════════════════════

export function ProtectionPage() {
  const [section, setSection] = useState<Section>('overview');
  const qc = useQueryClient();

  const { data: settings } = useQuery({
    queryKey: ['admin', 'security', 'settings'],
    queryFn:  () => api.get<SecuritySettings>('/admin/security/settings'),
  });

  const saveMut = useMutation({
    mutationFn: (data: Partial<SecuritySettings>) =>
      api.put<SecuritySettings>('/admin/security/settings', data),
    onSuccess: () => {
      toast.success('Einstellungen gespeichert');
      qc.invalidateQueries({ queryKey: ['admin', 'security', 'settings'] });
    },
    onError: () => toast.error('Fehler beim Speichern'),
  });

  function handleSave(data: Partial<SecuritySettings>) {
    saveMut.mutate(data);
  }

  return (
    <div className="flex h-full">
      {/* ── Left sub-nav ────────────────────────────────────────────────── */}
      <aside className="w-44 shrink-0 bg-[#1e2433] flex flex-col h-full">
        <div className="px-3 py-3 border-b border-white/10">
          <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Schutzfilter</p>
        </div>
        <nav className="flex-1 py-2 space-y-0.5">
          {SUB_NAV.map(({ id, label, icon: Icon }) => (
            <button key={id} onClick={() => setSection(id)}
              className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${
                section === id
                  ? 'bg-white/10 text-white border-l-2 border-accent'
                  : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'
              }`}>
              <Icon size={13} className="shrink-0" />
              {label}
            </button>
          ))}
        </nav>
      </aside>

      {/* ── Main content ────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto p-6">
        {!settings && (
          <div className="text-sm text-gray-400">Lade Einstellungen…</div>
        )}
        {settings && (
          <>
            {section === 'overview'    && <OverviewSection />}
            {section === 'rspamd'      && <RspamdSection    settings={settings} onSave={handleSave} />}
            {section === 'antivirus'   && <AntivirusSection  settings={settings} onSave={handleSave} />}
            {section === 'dnsbl'       && <DnsblSection       settings={settings} onSave={handleSave} />}
            {section === 'greylisting' && <GreylistingSection settings={settings} onSave={handleSave} />}
            {section === 'geoip'       && <GeoipSection       settings={settings} onSave={handleSave} />}
            {section === 'attachments' && <AttachmentsSection settings={settings} onSave={handleSave} />}
          </>
        )}
      </div>
    </div>
  );
}
