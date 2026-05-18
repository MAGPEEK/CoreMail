import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  LayoutDashboard, Zap, Bug, Database, Clock, Globe, Paperclip,
  CheckCircle, XCircle, RefreshCw, Plus, Trash2, AlertTriangle,
} from 'lucide-react';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';
import { Toggle } from '../components/Toggle.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SecuritySettings {
  greylistEnabled:           boolean;
  greylistWaitSec:           number;
  greylistTtlHours:          number;
  dnsblEnabled:              boolean;
  dnsblZones:                string[];
  geoipMode:                 'DISABLED' | 'WHITELIST' | 'BLACKLIST';
  geoipCountries:            string[];
  attachmentEnabled:         boolean;
  attachmentMaxSizeMb:       number;
  attachmentBlockedExt:      string[];
  // Rspamd
  rspamdEnabled:             boolean;
  rspamdGreylistScore:       number;
  rspamdSpamScore:           number;
  rspamdRejectScore:         number;
  rspamdAutolearn:           boolean;
  rspamdAutolearnSpam:       number;
  rspamdAutolearnHam:        number;
  rspamdAddSpamHeader:       boolean;
  rspamdExtendedHeaders:     boolean;
  rspamdRewriteSubject:      boolean;
  rspamdSubjectTag:          string;
  rspamdPhishingEnabled:     boolean;
  rspamdFuzzyEnabled:        boolean;
  rspamdUrlEnabled:          boolean;
  rspamdMxCheckEnabled:      boolean;
  // ClamAV
  clamavEnabled:             boolean;
  clamavAction:              'quarantine' | 'reject' | 'pass';
  clamavBlockOnFailure:      boolean;
  clamavScanArchives:        boolean;
  clamavScanHtml:            boolean;
  clamavBlockEncryptedArch:  boolean;
  clamavMaxFileSizeMb:       number;
  clamavMaxScanSizeMb:       number;
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
      <Toggle active={value} onToggle={() => onChange(!value)} />
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
  // Thresholds
  const [enabled,  setEnabled]  = useState(settings.rspamdEnabled);
  const [greylist, setGreylist] = useState(settings.rspamdGreylistScore);
  const [spam,     setSpam]     = useState(settings.rspamdSpamScore);
  const [reject,   setReject]   = useState(settings.rspamdRejectScore);
  // Autolearn
  const [autolearn,        setAutolearn]        = useState(settings.rspamdAutolearn);
  const [autolearnSpam,    setAutolearnSpam]    = useState(settings.rspamdAutolearnSpam);
  const [autolearnHam,     setAutolearnHam]     = useState(settings.rspamdAutolearnHam);
  // Header
  const [addSpamHeader,    setAddSpamHeader]    = useState(settings.rspamdAddSpamHeader);
  const [extendedHeaders,  setExtendedHeaders]  = useState(settings.rspamdExtendedHeaders);
  const [rewriteSubject,   setRewriteSubject]   = useState(settings.rspamdRewriteSubject);
  const [subjectTag,       setSubjectTag]       = useState(settings.rspamdSubjectTag);
  // Module
  const [phishing, setPhishing] = useState(settings.rspamdPhishingEnabled);
  const [fuzzy,    setFuzzy]    = useState(settings.rspamdFuzzyEnabled);
  const [url,      setUrl]      = useState(settings.rspamdUrlEnabled);
  const [mxCheck,  setMxCheck]  = useState(settings.rspamdMxCheckEnabled);

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
    onSave({
      rspamdEnabled:         enabled,
      rspamdGreylistScore:   greylist,
      rspamdSpamScore:       spam,
      rspamdRejectScore:     reject,
      rspamdAutolearn:       autolearn,
      rspamdAutolearnSpam:   autolearnSpam,
      rspamdAutolearnHam:    autolearnHam,
      rspamdAddSpamHeader:   addSpamHeader,
      rspamdExtendedHeaders: extendedHeaders,
      rspamdRewriteSubject:  rewriteSubject,
      rspamdSubjectTag:      subjectTag,
      rspamdPhishingEnabled: phishing,
      rspamdFuzzyEnabled:    fuzzy,
      rspamdUrlEnabled:      url,
      rspamdMxCheckEnabled:  mxCheck,
    });
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
            { label: 'Version',  value: stat.version ?? '—' },
            { label: 'Gescannt', value: (stat.scanned ?? 0).toLocaleString() },
            { label: 'Spam',     value: (stat.spam_count ?? 0).toLocaleString() },
            { label: 'Uptime',   value: stat.uptime ? `${Math.floor(stat.uptime / 3600)}h` : '—' },
          ].map(s => (
            <div key={s.label} className="card p-3 text-center">
              <p className="text-lg font-bold text-gray-900">{s.value}</p>
              <p className="text-xs text-gray-400">{s.label}</p>
            </div>
          ))}
        </div>
      )}

      {/* ── Aktions-Schwellwerte ───────────────────────────────────────── */}
      <div className="card p-4 space-y-1">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide pb-2 border-b border-gray-100">
          Aktions-Schwellwerte
        </p>
        <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-xs text-blue-700 my-2">
          Score ≥ Greylist → Greylisting &nbsp;·&nbsp; Score ≥ Spam → Header hinzufügen &nbsp;·&nbsp; Score ≥ Reject → Ablehnen
        </div>
        <ToggleRow label="Rspamd aktiviert" value={enabled} onChange={setEnabled} />
        <NumInput label="Greylisting-Score"       value={greylist} onChange={setGreylist} min={0}  max={20}  step={0.5} />
        <NumInput label="Spam-Score (Add Header)" value={spam}     onChange={setSpam}     min={0}  max={30}  step={0.5} />
        <NumInput label="Reject-Score"            value={reject}   onChange={setReject}   min={0}  max={100} step={0.5} />
      </div>

      {/* ── Autolearn ─────────────────────────────────────────────────── */}
      <div className="card p-4 space-y-1">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide pb-2 border-b border-gray-100">
          Bayes Autolearn
        </p>
        <p className="text-xs text-gray-400 py-1">
          Rspamd lernt automatisch aus eindeutigen Mails. Nachrichten mit Score über dem Spam-Schwellwert
          werden als Spam trainiert, unter dem Ham-Schwellwert als Ham.
        </p>
        <ToggleRow
          label="Autolearn aktiviert"
          desc="Bayes-Klassifikator lernt automatisch ohne manuelles Training"
          value={autolearn}
          onChange={setAutolearn}
        />
        <NumInput label="Autolearn Spam-Schwellwert" value={autolearnSpam} onChange={setAutolearnSpam} min={6}    max={100} step={0.5} />
        <NumInput label="Autolearn Ham-Schwellwert"  value={autolearnHam}  onChange={setAutolearnHam}  min={-10}  max={0}   step={0.5} />
      </div>

      {/* ── E-Mail-Header ─────────────────────────────────────────────── */}
      <div className="card p-4 space-y-1">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide pb-2 border-b border-gray-100">
          E-Mail-Header Modifikation
        </p>
        <ToggleRow
          label="X-Spam-Header hinzufügen"
          desc="Fügt X-Spam-Flag, X-Spam-Score und X-Spam-Status zu verdächtigen Mails hinzu"
          value={addSpamHeader}
          onChange={setAddSpamHeader}
        />
        <ToggleRow
          label="Erweiterte Rspamd-Header"
          desc="X-Rspamd-Score, X-Rspamd-Action und X-Rspamd-Pre-Result bei allen Mails"
          value={extendedHeaders}
          onChange={setExtendedHeaders}
        />
        <ToggleRow
          label="Betreff umschreiben"
          desc="Spam-Mails erhalten einen Präfix im Betreff (z.B. [SPAM])"
          value={rewriteSubject}
          onChange={setRewriteSubject}
        />
        {rewriteSubject && (
          <div className="flex items-center justify-between py-2.5 border-b border-gray-100">
            <span className="text-sm text-gray-700">Betreff-Präfix</span>
            <input
              type="text"
              value={subjectTag}
              onChange={e => setSubjectTag(e.target.value)}
              maxLength={32}
              className="w-32 border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
        )}
      </div>

      {/* ── Module ────────────────────────────────────────────────────── */}
      <div className="card p-4 space-y-1">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide pb-2 border-b border-gray-100">
          Rspamd-Module
        </p>
        <p className="text-xs text-gray-400 py-1">
          SPF, DKIM, DMARC und ARC sind immer aktiv. Die folgenden Module können einzeln gesteuert werden:
        </p>
        <ToggleRow
          label="Phishing-Erkennung"
          desc="Analysiert URLs und Header auf Phishing-Merkmale (phishing_detection)"
          value={phishing}
          onChange={setPhishing}
        />
        <ToggleRow
          label="Fuzzy-Hash-Matching"
          desc="Erkennt bekannte Spam-Muster anhand von Fuzzy-Hashes (Rspamd-Fuzzy-Storage)"
          value={fuzzy}
          onChange={setFuzzy}
        />
        <ToggleRow
          label="URL-Reputationsprüfung"
          desc="Prüft Links gegen URIBL und SURBL Blacklisten (rbl-Modul)"
          value={url}
          onChange={setUrl}
        />
        <ToggleRow
          label="MX-DNS-Prüfung"
          desc="Verifiziert ob die Absender-Domain gültige MX-Einträge hat"
          value={mxCheck}
          onChange={setMxCheck}
        />
        {/* Immer aktive Module */}
        <div className="pt-2 mt-1 border-t border-gray-100">
          <p className="text-xs text-gray-400 mb-2">Immer aktiv (nicht deaktivierbar):</p>
          <div className="grid grid-cols-2 gap-1.5">
            {[
              ['SPF',     'Sender Policy Framework'],
              ['DKIM',    'DKIM-Signatur Validierung'],
              ['DMARC',   'DMARC Policy Auswertung'],
              ['ARC',     'Authenticated Received Chain'],
              ['Bayes',   'Bayes-Klassifikator'],
              ['MIME',    'MIME-Struktur-Analyse'],
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

      {/* ── Bayes manuell trainieren ───────────────────────────────────── */}
      <div className="card p-4">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide pb-2 border-b border-gray-100 mb-3">
          Bayes manuell trainieren
        </p>
        <p className="text-xs text-gray-400 mb-3">
          Manuelle Trainingsimpulse für den Bayes-Klassifikator. Im Normalbetrieb übernimmt Autolearn diese Aufgabe automatisch.
        </p>
        <div className="flex gap-2">
          <button onClick={() => learnMut.mutate('spam')} disabled={learnMut.isPending}
            className="btn-secondary text-sm text-red-600 border-red-200 hover:bg-red-50">
            Als Spam trainieren
          </button>
          <button onClick={() => learnMut.mutate('ham')} disabled={learnMut.isPending}
            className="btn-secondary text-sm text-green-600 border-green-200 hover:bg-green-50">
            Als Ham trainieren
          </button>
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// AntivirusSection
// ═════════════════════════════════════════════════════════════════════════════

function AntivirusSection({ settings, onSave }: { settings: SecuritySettings; onSave: (d: Partial<SecuritySettings>) => void }) {
  const [enabled,          setEnabled]          = useState(settings.clamavEnabled);
  const [action,           setAction]           = useState<'quarantine' | 'reject' | 'pass'>(settings.clamavAction ?? 'quarantine');
  const [blockOnFailure,   setBlockOnFailure]   = useState(settings.clamavBlockOnFailure ?? false);
  const [scanArchives,     setScanArchives]     = useState(settings.clamavScanArchives ?? true);
  const [scanHtml,         setScanHtml]         = useState(settings.clamavScanHtml ?? true);
  const [blockEncrypted,   setBlockEncrypted]   = useState(settings.clamavBlockEncryptedArch ?? false);
  const [maxFileSize,      setMaxFileSize]      = useState(settings.clamavMaxFileSizeMb ?? 25);
  const [maxScanSize,      setMaxScanSize]      = useState(settings.clamavMaxScanSizeMb ?? 100);

  const { data: status } = useQuery({
    queryKey: ['admin', 'security', 'status'],
    queryFn:  () => api.get<ContainerStatus>('/admin/security/status'),
    refetchInterval: 30_000,
  });

  const c = status?.clamav;

  function save() {
    onSave({
      clamavEnabled:           enabled,
      clamavAction:            action,
      clamavBlockOnFailure:    blockOnFailure,
      clamavScanArchives:      scanArchives,
      clamavScanHtml:          scanHtml,
      clamavBlockEncryptedArch: blockEncrypted,
      clamavMaxFileSizeMb:     maxFileSize,
      clamavMaxScanSizeMb:     maxScanSize,
    });
  }

  const actionLabels: Record<string, { label: string; desc: string; color: string }> = {
    quarantine: { label: 'Quarantäne',   desc: 'Virus-Mail in Junk verschieben',       color: 'amber'  },
    reject:     { label: 'Ablehnen',     desc: 'SMTP-Verbindung mit Fehler abweisen',  color: 'red'    },
    pass:       { label: 'Durchlassen',  desc: 'Nur markieren, nicht blockieren',       color: 'gray'   },
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-900">Antivirus — ClamAV</h2>
        <SaveBtn onClick={save} pending={false} />
      </div>

      {/* Status-Karte */}
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
              <span className="text-xs font-mono text-gray-700 text-right max-w-[200px] break-all">{c.version}</span>
            </div>
          )}
          <div className="flex items-center justify-between py-1">
            <span className="text-sm text-gray-600">Signaturen</span>
            <span className="text-xs text-gray-500">Täglich via freshclam</span>
          </div>
          <div className="flex items-center justify-between py-1">
            <span className="text-sm text-gray-600">Verbindung</span>
            <span className="text-xs font-mono text-gray-500">clamav:3310 (INSTREAM)</span>
          </div>
        </div>

        <div className="card p-4 space-y-2">
          <p className="text-sm font-semibold text-gray-700">Über ClamAV</p>
          <p className="text-xs text-gray-500 leading-relaxed">
            ClamAV ist eine freie, plattformübergreifende Anti-Malware Engine (GPL).
            Sie erkennt Viren, Trojaner und andere schädliche Bedrohungen in
            E-Mail-Anhängen via TCP INSTREAM-Protokoll.
          </p>
          <div className="flex flex-wrap gap-1.5 pt-1">
            {['GPL Open-Source', 'ClamDB Signaturen', 'Archive-Scan', 'freshclam Updates'].map(t => (
              <span key={t} className="text-[10px] bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-full border border-emerald-200">
                {t}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* ── Grundeinstellungen ────────────────────────────────────────── */}
      <div className="card p-4 space-y-1">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide pb-2 border-b border-gray-100">
          Grundeinstellungen
        </p>
        <ToggleRow
          label="ClamAV aktiviert"
          desc="Scannt alle eingehenden E-Mail-Anhänge auf Viren und Malware"
          value={enabled}
          onChange={setEnabled}
        />
        <ToggleRow
          label="Bei ClamAV-Ausfall blockieren"
          desc="Eingehende Mails ablehnen wenn ClamAV nicht erreichbar ist (fail-closed)"
          value={blockOnFailure}
          onChange={setBlockOnFailure}
        />
      </div>

      {/* ── Aktion bei Fund ───────────────────────────────────────────── */}
      <div className="card p-4 space-y-3">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide pb-2 border-b border-gray-100">
          Aktion bei Virenfund
        </p>
        <div className="grid grid-cols-3 gap-2">
          {(['quarantine', 'reject', 'pass'] as const).map(a => {
            const meta = actionLabels[a];
            return (
              <button key={a} onClick={() => setAction(a)}
                className={`rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors text-left ${
                  action === a
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-gray-200 text-gray-600 hover:border-gray-300'
                }`}>
                <p className="font-semibold">{meta?.label}</p>
                <p className="text-[10px] mt-0.5 opacity-70">{meta?.desc}</p>
              </button>
            );
          })}
        </div>
        {action === 'pass' && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700 flex items-start gap-1.5">
            <AlertTriangle size={12} className="shrink-0 mt-0.5" />
            Modus "Durchlassen" schützt nicht vor Viren — nur für Diagnose-Zwecke empfohlen.
          </div>
        )}
      </div>

      {/* ── Scan-Optionen ─────────────────────────────────────────────── */}
      <div className="card p-4 space-y-1">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide pb-2 border-b border-gray-100">
          Scan-Optionen
        </p>
        <ToggleRow
          label="Archive scannen"
          desc="ZIP, RAR, TAR, GZ und andere Archivformate werden entpackt und gescannt"
          value={scanArchives}
          onChange={setScanArchives}
        />
        <ToggleRow
          label="HTML-Inhalt scannen"
          desc="HTML-Teile der E-Mail auf eingebettete Schadskripte prüfen"
          value={scanHtml}
          onChange={setScanHtml}
        />
        <ToggleRow
          label="Verschlüsselte Archive blockieren"
          desc="Passwortgeschützte Archive ablehnen (können nicht gescannt werden)"
          value={blockEncrypted}
          onChange={setBlockEncrypted}
        />
        <NumInput
          label="Max. Dateigröße (je Anhang)"
          value={maxFileSize}
          onChange={setMaxFileSize}
          min={1} max={500} unit="MB"
        />
        <NumInput
          label="Max. Gesamt-Scan-Größe"
          value={maxScanSize}
          onChange={setMaxScanSize}
          min={1} max={2048} unit="MB"
        />
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-700 flex items-start gap-2">
        <AlertTriangle size={13} className="shrink-0 mt-0.5" />
        <span>
          ClamAV läuft als separater Docker-Container (<code className="bg-blue-100 px-1 rounded">clamav/clamav:stable</code>).
          freshclam aktualisiert die Signaturdatenbank täglich automatisch.
          Signaturdatenbank: <strong>ClamAV DB (CVD)</strong> + optionale 3rd-Party Signaturen.
        </span>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// DnsblSection — DB-basierte Zone-Verwaltung mit Aktionen, Score, Test, Stats
// ═════════════════════════════════════════════════════════════════════════════

interface DnsblZone {
  id: string;
  host: string;
  name: string;
  description?: string | null;
  enabled: boolean;
  action: 'REJECT' | 'TAG' | 'SCORE_ONLY';
  weight: number;
  isWhitelist: boolean;
  sortOrder: number;
  isBuiltin: boolean;
}

interface DnsblTestResult {
  zoneId: string;
  host: string;
  name: string;
  enabled: boolean;
  isWhitelist: boolean;
  listed: boolean;
  response: string | null;
}

interface DnsblStats {
  days: number;
  total: number;
  perZone: { zoneId: string; host: string; name: string; hits: number }[];
  recent: { id: string; ip: string; hitAt: string; response: string | null; zoneHost: string; zoneName: string }[];
}

function ActionBadge({ action }: { action: DnsblZone['action'] }) {
  const styles = {
    REJECT:     'bg-red-50 text-red-700 border-red-200',
    TAG:        'bg-amber-50 text-amber-700 border-amber-200',
    SCORE_ONLY: 'bg-blue-50 text-blue-700 border-blue-200',
  } as const;
  const labels = { REJECT: 'Ablehnen', TAG: 'Markieren', SCORE_ONLY: 'Score' } as const;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold border ${styles[action]}`}>
      {labels[action]}
    </span>
  );
}

function DnsblSection({ settings, onSave }: { settings: SecuritySettings; onSave: (d: Partial<SecuritySettings>) => void }) {
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(settings.dnsblEnabled);
  const [tab, setTab] = useState<'zones' | 'test' | 'stats'>('zones');

  // ── Master-Toggle ──────────────────────────────────────────────────────────
  const masterSave = () => onSave({ dnsblEnabled: enabled });

  // ── Zonen ──────────────────────────────────────────────────────────────────
  const { data: zones = [], isLoading: zonesLoading } = useQuery({
    queryKey: ['admin', 'dnsbl-zones'],
    queryFn: () => api.get<DnsblZone[]>('/admin/security/dnsbl'),
  });

  const invalidateZones = () => qc.invalidateQueries({ queryKey: ['admin', 'dnsbl-zones'] });

  const patchZone = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<DnsblZone> }) =>
      api.patch(`/admin/security/dnsbl/${id}`, body),
    onSuccess: invalidateZones,
    onError: (e: Error) => toast.error(e.message || 'Fehler beim Speichern'),
  });

  const deleteZone = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/security/dnsbl/${id}`),
    onSuccess: () => { invalidateZones(); toast.success('Zone gelöscht'); },
    onError: (e: Error) => toast.error(e.message || 'Fehler beim Löschen'),
  });

  const createZone = useMutation({
    mutationFn: (body: Partial<DnsblZone>) =>
      api.post<DnsblZone>('/admin/security/dnsbl', body),
    onSuccess: () => { invalidateZones(); toast.success('Zone angelegt'); setNewHost(''); setNewName(''); setShowAdd(false); },
    onError: (e: Error) => toast.error(e.message || 'Fehler beim Anlegen'),
  });

  const [showAdd, setShowAdd] = useState(false);
  const [newHost, setNewHost] = useState('');
  const [newName, setNewName] = useState('');
  const [newAction, setNewAction] = useState<DnsblZone['action']>('REJECT');
  const [newWeight, setNewWeight] = useState(5);
  const [newWhitelist, setNewWhitelist] = useState(false);

  // ── Test ───────────────────────────────────────────────────────────────────
  const [testIp, setTestIp] = useState('');
  const testMutation = useMutation({
    mutationFn: (ip: string) => api.post<{ ip: string; results: DnsblTestResult[] }>('/admin/security/dnsbl/test', { ip }),
    onError: (e: Error) => toast.error(e.message || 'Test fehlgeschlagen'),
  });

  // ── Stats ──────────────────────────────────────────────────────────────────
  const [statsDays, setStatsDays] = useState(7);
  const { data: stats } = useQuery({
    queryKey: ['admin', 'dnsbl-stats', statsDays],
    queryFn: () => api.get<DnsblStats>(`/admin/security/dnsbl/stats?days=${statsDays}`),
    enabled: tab === 'stats',
    refetchInterval: tab === 'stats' ? 30_000 : false,
  });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-900">DNSBL-Konfiguration</h2>
        <SaveBtn onClick={masterSave} pending={false} />
      </div>

      <div className="card p-4 space-y-1">
        <ToggleRow
          label="DNSBL aktiviert"
          desc="Prüft Absender-IPs gegen DNS-Blacklisten und ggf. Whitelisten (DNSWL)"
          value={enabled}
          onChange={setEnabled}
        />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200">
        {[
          { id: 'zones' as const, label: 'Zonen', count: zones.length },
          { id: 'test'  as const, label: 'Test',  count: undefined },
          { id: 'stats' as const, label: 'Statistik', count: undefined },
        ].map(({ id, label, count }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`px-4 py-2 text-sm border-b-2 transition-colors ${
              tab === id
                ? 'border-accent text-accent font-semibold'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {label}
            {count !== undefined && (
              <span className="ml-1.5 text-xs bg-gray-100 px-1.5 py-0.5 rounded-full text-gray-600">{count}</span>
            )}
          </button>
        ))}
      </div>

      {/* TAB: Zonen */}
      {tab === 'zones' && (
        <>
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-600">{zones.filter(z => z.enabled).length} aktive von {zones.length} Zonen</p>
            <button onClick={() => setShowAdd((v) => !v)} className="btn-secondary text-sm gap-1">
              <Plus size={13} /> Eigene Zone
            </button>
          </div>

          {showAdd && (
            <div className="card p-4 border-2 border-accent/30 space-y-3">
              <p className="text-sm font-semibold text-gray-700">Neue DNSBL/DNSWL-Zone anlegen</p>
              <div className="grid grid-cols-2 gap-2">
                <input value={newHost} onChange={(e) => setNewHost(e.target.value)} placeholder="zen.spamhaus.org"
                  className="border border-gray-300 rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent" />
                <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Anzeigename"
                  className="border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" />
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <select value={newAction} onChange={(e) => setNewAction(e.target.value as DnsblZone['action'])}
                  className="border border-gray-300 rounded px-2 py-1.5 text-sm">
                  <option value="REJECT">Ablehnen</option>
                  <option value="TAG">Als Spam markieren</option>
                  <option value="SCORE_ONLY">Nur Score (rspamd)</option>
                </select>
                <label className="text-sm text-gray-700 flex items-center gap-1">
                  Score:
                  <input type="number" min={0} max={100} value={newWeight} onChange={(e) => setNewWeight(parseInt(e.target.value, 10) || 0)}
                    className="w-16 border border-gray-300 rounded px-2 py-1 text-sm" />
                </label>
                <label className="text-sm text-gray-700 flex items-center gap-1.5">
                  <input type="checkbox" checked={newWhitelist} onChange={(e) => setNewWhitelist(e.target.checked)} />
                  Whitelist (DNSWL)
                </label>
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={() => setShowAdd(false)} className="btn-ghost text-sm">Abbrechen</button>
                <button
                  onClick={() => createZone.mutate({ host: newHost.trim(), name: newName.trim() || newHost.trim(), action: newAction, weight: newWeight, isWhitelist: newWhitelist, enabled: true })}
                  disabled={!newHost.trim() || createZone.isPending}
                  className="btn-primary text-sm">
                  Anlegen
                </button>
              </div>
            </div>
          )}

          {/* Zonen-Karten */}
          <div className="space-y-2">
            {zonesLoading && <p className="text-sm text-gray-400">Lade …</p>}
            {zones.map((z) => (
              <div key={z.id} className={`card p-3 ${!z.enabled ? 'opacity-60' : ''}`}>
                <div className="flex items-start gap-3">
                  <Toggle active={z.enabled} onToggle={() => patchZone.mutate({ id: z.id, body: { enabled: !z.enabled } })} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-gray-900">{z.name}</span>
                      <code className="text-xs text-gray-500">{z.host}</code>
                      {z.isWhitelist && (
                        <span className="text-[10px] bg-emerald-50 text-emerald-700 border border-emerald-200 px-1.5 py-0.5 rounded">WHITELIST</span>
                      )}
                      {z.isBuiltin && (
                        <span className="text-[10px] bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">Built-in</span>
                      )}
                      <ActionBadge action={z.action} />
                    </div>
                    {z.description && (
                      <p className="text-xs text-gray-500 mt-1">{z.description}</p>
                    )}
                    <div className="flex items-center gap-3 mt-2">
                      <label className="flex items-center gap-1 text-xs text-gray-600">
                        Aktion:
                        <select value={z.action}
                          onChange={(e) => patchZone.mutate({ id: z.id, body: { action: e.target.value as DnsblZone['action'] } })}
                          className="border border-gray-200 rounded px-1.5 py-0.5 text-xs">
                          <option value="REJECT">Ablehnen</option>
                          <option value="TAG">Markieren</option>
                          <option value="SCORE_ONLY">Score</option>
                        </select>
                      </label>
                      <label className="flex items-center gap-1 text-xs text-gray-600">
                        Score:
                        <input type="number" min={0} max={100} defaultValue={z.weight}
                          onBlur={(e) => {
                            const v = parseInt(e.target.value, 10);
                            if (v !== z.weight) patchZone.mutate({ id: z.id, body: { weight: v } });
                          }}
                          className="w-14 border border-gray-200 rounded px-1.5 py-0.5 text-xs" />
                      </label>
                    </div>
                  </div>
                  {!z.isBuiltin && (
                    <button onClick={() => {
                      if (window.confirm(`Zone „${z.name}" wirklich löschen?`)) deleteZone.mutate(z.id);
                    }} className="text-gray-400 hover:text-red-500 transition-colors p-1">
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* TAB: Test */}
      {tab === 'test' && (
        <div className="card p-4 space-y-3">
          <p className="text-sm font-semibold text-gray-700">DNSBL-Check für IP testen</p>
          <p className="text-xs text-gray-500">Prüft die IP gegen alle konfigurierten Zonen (auch deaktivierte). Antwortzeit ca. 2 s pro Zone.</p>
          <div className="flex gap-2">
            <input
              value={testIp}
              onChange={(e) => setTestIp(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && testIp.trim() && testMutation.mutate(testIp.trim())}
              placeholder="z. B. 185.220.101.1 oder 2001:db8::1"
              className="flex-1 border border-gray-300 rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <button onClick={() => testIp.trim() && testMutation.mutate(testIp.trim())}
              disabled={!testIp.trim() || testMutation.isPending}
              className="btn-primary text-sm gap-1">
              {testMutation.isPending ? <RefreshCw size={13} className="animate-spin" /> : <Database size={13} />}
              Testen
            </button>
          </div>

          {testMutation.data && (
            <div className="border-t border-gray-100 pt-3 space-y-1.5">
              <p className="text-xs text-gray-500">Ergebnis für <code className="font-mono">{testMutation.data.ip}</code>:</p>
              {testMutation.data.results.map((r) => (
                <div key={r.zoneId} className={`flex items-center gap-2 px-3 py-1.5 rounded text-sm ${
                  r.listed
                    ? (r.isWhitelist ? 'bg-emerald-50' : 'bg-red-50')
                    : 'bg-gray-50'
                }`}>
                  {r.listed
                    ? <CheckCircle size={14} className={r.isWhitelist ? 'text-emerald-600' : 'text-red-600'} />
                    : <XCircle size={14} className="text-gray-400" />}
                  <span className="font-medium">{r.name}</span>
                  <code className="text-xs text-gray-500">{r.host}</code>
                  {!r.enabled && <span className="text-[10px] bg-gray-200 px-1.5 rounded">deaktiviert</span>}
                  <span className="ml-auto text-xs">
                    {r.listed
                      ? <span className={r.isWhitelist ? 'text-emerald-700 font-mono' : 'text-red-700 font-mono'}>gelistet → {r.response}</span>
                      : <span className="text-gray-400">nicht gelistet</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* TAB: Statistik */}
      {tab === 'stats' && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-600">Zeitraum:</span>
            {[1, 7, 30].map((d) => (
              <button key={d}
                onClick={() => setStatsDays(d)}
                className={`px-3 py-1 text-xs rounded-full transition-colors ${
                  statsDays === d ? 'bg-accent text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}>
                {d === 1 ? '24 h' : `${d} Tage`}
              </button>
            ))}
          </div>

          {stats && (
            <>
              <div className="card p-4">
                <p className="text-2xl font-bold text-gray-900">{stats.total.toLocaleString('de-DE')}</p>
                <p className="text-xs text-gray-500">Treffer in den letzten {stats.days === 1 ? '24 h' : `${stats.days} Tagen`}</p>
              </div>

              <div className="card p-4">
                <p className="text-sm font-semibold text-gray-700 mb-2">Top-Zonen</p>
                {stats.perZone.length === 0
                  ? <p className="text-xs text-gray-400">Keine Treffer</p>
                  : stats.perZone.map((p) => (
                      <div key={p.zoneId} className="flex items-center gap-2 py-1.5">
                        <span className="text-sm font-medium text-gray-700">{p.name}</span>
                        <code className="text-xs text-gray-400">{p.host}</code>
                        <div className="flex-1 bg-gray-100 h-2 rounded">
                          <div className="bg-accent h-2 rounded" style={{ width: `${stats.perZone[0] ? (p.hits / stats.perZone[0].hits) * 100 : 0}%` }} />
                        </div>
                        <span className="text-sm tabular-nums text-gray-700 w-16 text-right">{p.hits}</span>
                      </div>
                    ))}
              </div>

              <div className="card p-4">
                <p className="text-sm font-semibold text-gray-700 mb-2">Letzte Treffer</p>
                {stats.recent.length === 0
                  ? <p className="text-xs text-gray-400">Keine Treffer</p>
                  : (
                    <div className="space-y-1 max-h-80 overflow-y-auto">
                      {stats.recent.map((h) => (
                        <div key={h.id} className="flex items-center gap-2 text-xs py-1 border-b border-gray-50 last:border-0">
                          <AlertTriangle size={11} className="text-red-500 shrink-0" />
                          <code className="font-mono text-gray-700 w-32 truncate">{h.ip}</code>
                          <span className="text-gray-600">{h.zoneName}</span>
                          <span className="ml-auto text-gray-400">{new Date(h.hitAt).toLocaleString('de-DE')}</span>
                        </div>
                      ))}
                    </div>
                  )}
              </div>
            </>
          )}
        </div>
      )}
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
