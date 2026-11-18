import { createContext, useContext, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { errorMessage } from '../lib/errors.js';
import { WriteGuard } from '../components/Can.js';
import { protectionFeatureMatrix } from '../lib/protectionStatus.js';
import {
  visibleSections, resolveSection, scannerNotice, scannerNotices, absentScanners,
  type ScannerCapabilities, type ScannerNotice, type ProtectionSection,
} from '../lib/protectionVisibility.js';
import {
  LayoutDashboard, Zap, Bug, Database, Clock, Globe, Paperclip, ListFilter, ShieldAlert,
  CheckCircle, XCircle, RefreshCw, Plus, Trash2, AlertTriangle, Info,
} from 'lucide-react';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';
import { Toggle } from '../components/Toggle.js';
import { ClamavSettingsSection } from '../components/ClamavSettingsSection.js';
import { SenderListsSection } from '../components/SenderListsSection.js';
import { SpoofingSection } from '../components/SpoofingSection.js';
import { dnsblActionOptions } from '../lib/senderLists.js';

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

/** GET /admin/security/clamav/status (clamd VERSION/STATS). */
interface ClamavLiveStatus {
  online: boolean;
  version?: { raw: string; engine?: string; signatureVersion?: number; signatureDate?: string };
  signatureAgeHours?: number;
  error?: string;
}

// ── Sub-navigation ────────────────────────────────────────────────────────────

type Section = ProtectionSection;

const SUB_NAV: { id: Section; label: string; icon: React.ElementType }[] = [
  { id: 'overview',    label: 'Übersicht',    icon: LayoutDashboard },
  { id: 'rspamd',      label: 'Rspamd',       icon: Zap },
  { id: 'antivirus',   label: 'Antivirus',    icon: Bug },
  { id: 'dnsbl',       label: 'DNSBL',        icon: Database },
  { id: 'senderlists', label: 'Absenderlisten', icon: ListFilter },
  { id: 'spoofing',    label: 'Spoofing',     icon: ShieldAlert },
  { id: 'greylisting', label: 'Greylisting',  icon: Clock },
  { id: 'geoip',       label: 'Länderfilter', icon: Globe },
  { id: 'attachments', label: 'Anhänge',      icon: Paperclip },
];

// ── Helper: online badge ───────────────────────────────────────────────────────

function OnlineBadge({ online }: { online: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full ${
      online ? 'bg-success-bg text-success-fg' : 'bg-danger-bg text-danger-fg'
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full ${online ? 'bg-success' : 'bg-danger'}`} />
      {online ? 'Online' : 'Offline'}
    </span>
  );
}

// ── Helper: scanner deployment notice (9.3) ────────────────────────────────────

/** Neutral info line (scanner not deployed) or warning (deployed, not reachable). */
function ScannerNoticeLine({ notice }: { notice: ScannerNotice }) {
  const warn = notice.tone === 'warning';
  return (
    <div role={warn ? 'alert' : 'note'} className={`rounded-lg px-3 py-2 text-xs flex items-start gap-1.5 border ${
      warn ? 'bg-warning-bg border-warning-line text-warning-fg' : 'bg-surface-2 border-line text-fg-muted'
    }`}>
      {warn ? <AlertTriangle size={12} className="shrink-0 mt-0.5" /> : <Info size={12} className="shrink-0 mt-0.5" />}
      <span>
        {notice.text}
        {notice.docsUrl && (
          <> <a href={notice.docsUrl} target="_blank" rel="noopener noreferrer"
            className="text-accent-fg underline-offset-2 hover:underline focus-visible:underline">Dokumentation</a></>
        )}
      </span>
    </div>
  );
}

const CAPABILITIES_KEY = ['admin', 'security', 'capabilities'] as const;

// ── Helper: section save button ───────────────────────────────────────────────

/** The page's settings save is running (no double submits from any section). */
const SavePendingContext = createContext(false);

function SaveBtn({ onClick, pending: pendingProp }: { onClick: () => void; pending: boolean }) {
  const pending = useContext(SavePendingContext) || pendingProp;
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
    <div className="flex items-center justify-between py-2.5 border-b border-line last:border-0">
      <span className="text-sm text-fg-muted">{label}</span>
      <div className="flex items-center gap-1.5">
        <input
          type="number" min={min} max={max} step={step} value={value}
          onChange={e => onChange(parseFloat(e.target.value) || min)}
          className="w-24 border border-line-strong rounded px-2 py-1 text-sm text-right focus:outline-none focus:ring-2 focus:ring-accent-fg"
        />
        {unit && <span className="text-xs text-fg-subtle w-8">{unit}</span>}
      </div>
    </div>
  );
}

// ── Helper: toggle row ────────────────────────────────────────────────────────

function ToggleRow({ label, desc, value, onChange }:
  { label: string; desc?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-line last:border-0">
      <div>
        <p className="text-sm text-fg font-medium">{label}</p>
        {desc && <p className="text-xs text-fg-subtle mt-0.5">{desc}</p>}
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

function OverviewSection({ settings, caps }: { settings: SecuritySettings; caps: ScannerCapabilities | undefined }) {
  const qc = useQueryClient();
  // 9.3: scanners not deployed in this installation get no status card / matrix row
  const absent = absentScanners(caps);
  const notices = scannerNotices(caps);
  const { data: status, isLoading, dataUpdatedAt } = useQuery({
    queryKey: ['admin', 'security', 'status'],
    queryFn: () => api.get<ContainerStatus>('/admin/security/status'),
    refetchInterval: 30_000,
    enabled: !(absent.rspamd && absent.clamav),
  });
  // /status only pings rspamd — the counters come from /rspamd/stat (was never shown)
  const { data: rspamdStat } = useQuery({
    queryKey: ['admin', 'security', 'rspamd', 'stat'],
    queryFn:  () => api.get<RspamdStat>('/admin/security/rspamd/stat'),
    enabled:  !absent.rspamd && !!status?.rspamd.online,
    retry: false,
  });
  const { data: zones } = useQuery({
    queryKey: ['admin', 'dnsbl-zones'],
    queryFn: () => api.get<DnsblZone[]>('/admin/security/dnsbl'),
  });

  // ClamAV: the clamd VERSION/STATS status (same query as the Antivirus section)
  const { data: c, isLoading: clamavLoading } = useQuery({
    queryKey: ['admin', 'security', 'clamav', 'status'],
    queryFn:  () => api.get<ClamavLiveStatus>('/admin/security/clamav/status'),
    refetchInterval: 60_000,
    retry: false,
    enabled: !absent.clamav,
  });

  const r = status?.rspamd;
  const stat = rspamdStat ?? r?.stat;
  const features = protectionFeatureMatrix(
    settings,
    { rspamd: status ? !!r?.online : undefined, clamav: c ? c.online : undefined },
    zones?.filter((z) => z.enabled && !z.isWhitelist).map((z) => z.host),
    absent,
  );

  function fmtUptime(sec?: number) {
    if (!sec) return '—';
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  return (
    <div className="space-y-5">
      {notices.length > 0 && (
        <div className="space-y-2">
          {notices.map((n) => <ScannerNoticeLine key={n.scanner} notice={n} />)}
        </div>
      )}

      {!(absent.rspamd && absent.clamav) && (<>
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-fg">Container-Status</h2>
        <button onClick={() => {
          void qc.invalidateQueries({ queryKey: ['admin', 'security', 'status'] });
          void qc.invalidateQueries({ queryKey: ['admin', 'security', 'clamav', 'status'] });
          void qc.invalidateQueries({ queryKey: CAPABILITIES_KEY });
        }}
          className="btn-ghost text-xs gap-1">
          <RefreshCw size={13} className={isLoading ? 'animate-spin' : ''} />
          Aktualisieren
        </button>
      </div>

      {dataUpdatedAt > 0 && (
        <p className="text-xs text-fg-subtle">
          Zuletzt aktualisiert: {new Date(dataUpdatedAt).toLocaleTimeString('de-DE')}
        </p>
      )}

      <div className="grid grid-cols-2 gap-4">
        {/* Rspamd card */}
        {!absent.rspamd && (
        <div className="card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-info-bg flex items-center justify-center">
                <Zap size={16} className="text-info-fg" />
              </div>
              <div>
                <p className="text-sm font-semibold text-fg">Rspamd</p>
                <p className="text-xs text-fg-subtle">{stat?.version ? `v${stat.version} · ` : ''}Anti-Spam</p>
              </div>
            </div>
            {isLoading ? <span className="text-xs text-fg-subtle">…</span> : <OnlineBadge online={!!r?.online} />}
          </div>

          {r?.online && stat && (
            <div className="grid grid-cols-3 gap-2 pt-1 border-t border-line">
              <div className="text-center">
                <p className="text-lg font-bold text-fg">{(stat.scanned ?? 0).toLocaleString()}</p>
                <p className="text-[10px] text-fg-subtle">Gescannt</p>
              </div>
              <div className="text-center">
                <p className="text-lg font-bold text-danger-fg">{(stat.spam_count ?? 0).toLocaleString()}</p>
                <p className="text-[10px] text-fg-subtle">Spam</p>
              </div>
              <div className="text-center">
                <p className="text-lg font-bold text-success-fg">{(stat.ham_count ?? 0).toLocaleString()}</p>
                <p className="text-[10px] text-fg-subtle">Ham</p>
              </div>
            </div>
          )}
          {r?.online && stat?.uptime !== undefined && (
            <p className="text-xs text-fg-subtle border-t border-line pt-2">
              Uptime: {fmtUptime(stat.uptime)}
            </p>
          )}
          {!r?.online && r?.error && (
            <p className="text-xs text-danger-fg flex items-center gap-1">
              <AlertTriangle size={11} /> {r.error}
            </p>
          )}
        </div>
        )}

        {/* ClamAV card */}
        {!absent.clamav && (
        <div className="card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-success-bg flex items-center justify-center">
                <Bug size={16} className="text-success-fg" />
              </div>
              <div>
                <p className="text-sm font-semibold text-fg">ClamAV</p>
                <p className="text-xs text-fg-subtle">Open-Source Antivirus</p>
              </div>
            </div>
            {clamavLoading ? <span className="text-xs text-fg-subtle">…</span> : <OnlineBadge online={!!c?.online} />}
          </div>

          {c?.online && c.version && (
            <div className="pt-1 border-t border-line">
              <p className="text-xs text-fg-muted font-mono bg-surface-2 rounded px-2 py-1 break-all">
                {c.version.engine ? `ClamAV ${c.version.engine}` : c.version.raw}
                {c.version.signatureVersion !== undefined && ` · Signaturen ${c.version.signatureVersion}`}
              </p>
            </div>
          )}
          {!c?.online && c?.error && (
            <p className="text-xs text-danger-fg flex items-center gap-1">
              <AlertTriangle size={11} /> {c.error}
            </p>
          )}
          {c?.online && c.signatureAgeHours !== undefined && (
            <p className={`text-xs border-t border-line pt-2 ${c.signatureAgeHours > 48 ? 'text-warning-fg' : 'text-fg-subtle'}`}>
              Signaturdatenbank vor {c.signatureAgeHours} h aktualisiert
            </p>
          )}
        </div>
        )}
      </div>
      </>)}

      {/* Feature matrix */}
      <div className="card overflow-hidden">
        <div className="px-4 py-2.5 bg-surface-2 border-b border-line">
          <p className="text-xs font-semibold text-fg-subtle uppercase tracking-wide">Aktive Schutzmaßnahmen</p>
        </div>
        <table className="w-full text-sm">
          <tbody className="divide-y divide-line">
            {features.map(f => (
              <tr key={f.label} className="hover:bg-surface-2 transition-colors">
                <td className="px-4 py-2.5 font-medium text-fg w-48">{f.label}</td>
                <td className="px-4 py-2.5 text-fg-subtle text-xs">{f.note}</td>
                <td className="px-4 py-2.5 text-right pr-5">
                  {f.ok
                    ? <CheckCircle size={16} className="text-success-fg ml-auto" aria-label="aktiv" />
                    : <XCircle    size={16} className="text-danger-fg  ml-auto" aria-label="inaktiv" />}
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
  // Only what the security filter evaluates: switch + spam (→ Junk) and reject
  // thresholds. Greylist score, autolearn, header rewriting and module switches
  // were saved but never applied (CoreMail decides on the score itself; rspamd
  // modules and Bayes autolearn are configured in the rspamd container).
  const [enabled, setEnabled] = useState(settings.rspamdEnabled);
  const [spam,    setSpam]    = useState(settings.rspamdSpamScore);
  const [reject,  setReject]  = useState(settings.rspamdRejectScore);

  const { data: stat, isLoading } = useQuery({
    queryKey: ['admin', 'security', 'rspamd', 'stat'],
    queryFn:  () => api.get<RspamdStat>('/admin/security/rspamd/stat'),
    retry: false,
  });

  function save() {
    if (spam >= reject) { toast.error('Der Spam-Score muss kleiner als der Ablehnungs-Score sein'); return; }
    onSave({ rspamdEnabled: enabled, rspamdSpamScore: spam, rspamdRejectScore: reject });
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-fg">Rspamd-Konfiguration</h2>
        <SaveBtn onClick={save} pending={false} />
      </div>

      {/* Live stats */}
      {isLoading && <p className="text-xs text-fg-subtle">Lade Rspamd-Statistiken…</p>}
      {stat && (
        <div className="grid grid-cols-4 gap-3">
          {[
            { label: 'Version',  value: stat.version ?? '—' },
            { label: 'Gescannt', value: (stat.scanned ?? 0).toLocaleString() },
            { label: 'Spam',     value: (stat.spam_count ?? 0).toLocaleString() },
            { label: 'Uptime',   value: stat.uptime ? `${Math.floor(stat.uptime / 3600)}h` : '—' },
          ].map(s => (
            <div key={s.label} className="card p-3 text-center">
              <p className="text-lg font-bold text-fg">{s.value}</p>
              <p className="text-xs text-fg-subtle">{s.label}</p>
            </div>
          ))}
        </div>
      )}

      {/* ── Action thresholds ──────────────────────────────────────────── */}
      <div className="card p-4 space-y-1">
        <p className="text-xs font-semibold text-fg-subtle uppercase tracking-wide pb-2 border-b border-line">
          Aktions-Schwellwerte
        </p>
        <div className="bg-info-bg border border-info-line rounded-lg px-3 py-2 text-xs text-info-fg my-2">
          Score ≥ Spam → Zustellung in den Junk-Ordner &nbsp;·&nbsp; Score ≥ Ablehnen → Annahme verweigert
        </div>
        <ToggleRow label="Rspamd aktiviert" desc="Eingehende Mails werden von Rspamd bewertet" value={enabled} onChange={setEnabled} />
        <NumInput label="Spam-Score (Junk-Ordner)" value={spam}   onChange={setSpam}   min={0} max={100} step={0.5} />
        <NumInput label="Ablehnungs-Score"         value={reject} onChange={setReject} min={0} max={100} step={0.5} />
      </div>

      <div className="bg-surface-2 border border-line rounded-lg px-4 py-3 text-xs text-fg-muted">
        SPF, DKIM, DMARC und ARC prüft CoreMail selbst. Rspamd-Module (Phishing, Fuzzy, URL-Reputation),
        Bayes-Autolearn und Header werden in der Rspamd-Konfiguration des Containers gepflegt.
        Der Bayes-Klassifikator lernt aus den Aktionen „Junk“ / „Kein Junk“ der Benutzer.
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// DnsblSection — DB-based zone management with actions, score, test, stats
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
    REJECT:     'bg-danger-bg text-danger-fg border-danger-line',
    TAG:        'bg-warning-bg text-warning-fg border-warning-line',
    SCORE_ONLY: 'bg-info-bg text-info-fg border-info-line',
  } as const;
  const labels = { REJECT: 'Ablehnen', TAG: 'Markieren', SCORE_ONLY: 'Score' } as const;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold border ${styles[action]}`}>
      {labels[action]}
    </span>
  );
}

function DnsblSection({ settings, onSave, rspamdAbsent }: {
  settings: SecuritySettings; onSave: (d: Partial<SecuritySettings>) => void; rspamdAbsent: boolean;
}) {
  const qc = useQueryClient();
  const actionOptions = dnsblActionOptions(rspamdAbsent);
  const [enabled, setEnabled] = useState(settings.dnsblEnabled);
  const [tab, setTab] = useState<'zones' | 'test' | 'stats'>('zones');

  // ── Master-Toggle ──────────────────────────────────────────────────────────
  const masterSave = () => onSave({ dnsblEnabled: enabled });

  // ── Zones ──────────────────────────────────────────────────────────────────
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
        <h2 className="text-base font-semibold text-fg">DNSBL-Konfiguration</h2>
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
      <div className="flex gap-1 border-b border-line">
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
                ? 'border-accent-fg text-accent-fg font-semibold'
                : 'border-transparent text-fg-subtle hover:text-fg-muted'
            }`}
          >
            {label}
            {count !== undefined && (
              <span className="ml-1.5 text-xs bg-surface-2 px-1.5 py-0.5 rounded-full text-fg-muted">{count}</span>
            )}
          </button>
        ))}
      </div>

      {/* TAB: Zones */}
      {tab === 'zones' && (
        <>
          <div className="flex items-center justify-between">
            <p className="text-sm text-fg-muted">{zones.filter(z => z.enabled).length} aktive von {zones.length} Zonen</p>
            <button onClick={() => setShowAdd((v) => !v)} className="btn-secondary text-sm gap-1">
              <Plus size={13} /> Eigene Zone
            </button>
          </div>
          <p className="text-xs text-fg-subtle">
            „Ablehnen“ weist die Verbindung ab, ein DNSWL-Treffer überspringt die übrigen Verbindungsprüfungen.
            „Score“ addiert das Score-Gewicht der Zone zum Spam-Score der Nachricht – nur wenn Rspamd aktiv ist{rspamdAbsent ? ' (Rspamd ist in dieser Installation nicht bereitgestellt)' : ''}; angemeldete Absender (SMTP AUTH) erhalten keinen DNSBL-Score.
            „Markieren“ wird derzeit nur in der Statistik erfasst und beeinflusst die Zustellung nicht.
          </p>

          {showAdd && (
            <div className="card p-4 border-2 border-accent/30 space-y-3">
              <p className="text-sm font-semibold text-fg-muted">Neue DNSBL/DNSWL-Zone anlegen</p>
              <div className="grid grid-cols-2 gap-2">
                <input value={newHost} onChange={(e) => setNewHost(e.target.value)} placeholder="zen.spamhaus.org"
                  className="border border-line-strong rounded px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent-fg" />
                <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Anzeigename"
                  className="border border-line-strong rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-fg" />
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <select value={newAction} onChange={(e) => setNewAction(e.target.value as DnsblZone['action'])}
                  aria-label="Aktion" className="border border-line-strong rounded px-2 py-1.5 text-sm">
                  {actionOptions.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
                </select>
                <label className="text-sm text-fg-muted flex items-center gap-1">
                  Score:
                  <input type="number" min={0} max={100} value={newWeight} onChange={(e) => setNewWeight(parseInt(e.target.value, 10) || 0)}
                    className="w-16 border border-line-strong rounded px-2 py-1 text-sm" />
                </label>
                <label className="text-sm text-fg-muted flex items-center gap-1.5">
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

          {/* Zone cards */}
          <div className="space-y-2">
            {zonesLoading && <p className="text-sm text-fg-subtle">Lade …</p>}
            {zones.map((z) => (
              <div key={z.id} className={`card p-3 ${!z.enabled ? 'bg-surface-2' : ''}`}>
                <div className="flex items-start gap-3">
                  <Toggle active={z.enabled} onToggle={() => patchZone.mutate({ id: z.id, body: { enabled: !z.enabled } })} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-fg">{z.name}</span>
                      <code className="text-xs text-fg-subtle">{z.host}</code>
                      {z.isWhitelist && (
                        <span className="text-[10px] bg-success-bg text-success-fg border border-success-line px-1.5 py-0.5 rounded">WHITELIST</span>
                      )}
                      {z.isBuiltin && (
                        <span className="text-[10px] bg-surface-2 text-fg-muted px-1.5 py-0.5 rounded">Built-in</span>
                      )}
                      {!z.enabled && (
                        <span className="text-[10px] bg-surface-3 text-fg-muted px-1.5 py-0.5 rounded">Deaktiviert</span>
                      )}
                      <ActionBadge action={z.action} />
                    </div>
                    {z.description && (
                      <p className="text-xs text-fg-subtle mt-1">{z.description}</p>
                    )}
                    <div className="flex items-center gap-3 mt-2">
                      <label className="flex items-center gap-1 text-xs text-fg-muted">
                        Aktion:
                        <select value={z.action}
                          onChange={(e) => patchZone.mutate({ id: z.id, body: { action: e.target.value as DnsblZone['action'] } })}
                          className="border border-line rounded px-1.5 py-0.5 text-xs">
                          {actionOptions.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
                        </select>
                      </label>
                      <label className="flex items-center gap-1 text-xs text-fg-muted">
                        Score:
                        <input type="number" min={0} max={100} defaultValue={z.weight}
                          onBlur={(e) => {
                            const v = parseInt(e.target.value, 10);
                            if (Number.isFinite(v) && v !== z.weight) patchZone.mutate({ id: z.id, body: { weight: v } });
                          }}
                          className="w-14 border border-line rounded px-1.5 py-0.5 text-xs" />
                      </label>
                    </div>
                  </div>
                  {!z.isBuiltin && (
                    <button aria-label={`Zone ${z.name} löschen`} onClick={() => {
                      if (window.confirm(`Zone „${z.name}" wirklich löschen?`)) deleteZone.mutate(z.id);
                    }} className="text-fg-subtle hover:text-danger-fg transition-colors p-1">
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
          <p className="text-sm font-semibold text-fg-muted">DNSBL-Check für IP testen</p>
          <p className="text-xs text-fg-subtle">Prüft die IP gegen alle konfigurierten Zonen (auch deaktivierte). Antwortzeit ca. 2 s pro Zone.</p>
          <div className="flex gap-2">
            <input
              value={testIp}
              onChange={(e) => setTestIp(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && testIp.trim() && testMutation.mutate(testIp.trim())}
              placeholder="z. B. 185.220.101.1 oder 2001:db8::1"
              className="flex-1 border border-line-strong rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-accent-fg"
            />
            <button onClick={() => testIp.trim() && testMutation.mutate(testIp.trim())}
              disabled={!testIp.trim() || testMutation.isPending}
              className="btn-primary text-sm gap-1">
              {testMutation.isPending ? <RefreshCw size={13} className="animate-spin" /> : <Database size={13} />}
              Testen
            </button>
          </div>

          {testMutation.data && (
            <div className="border-t border-line pt-3 space-y-1.5">
              <p className="text-xs text-fg-subtle">Ergebnis für <code className="font-mono">{testMutation.data.ip}</code>:</p>
              {testMutation.data.results.map((r) => (
                <div key={r.zoneId} className={`flex items-center gap-2 px-3 py-1.5 rounded text-sm ${
                  r.listed
                    ? (r.isWhitelist ? 'bg-success-bg' : 'bg-danger-bg')
                    : 'bg-surface-2'
                }`}>
                  {r.listed
                    ? <CheckCircle size={14} className={r.isWhitelist ? 'text-success-fg' : 'text-danger-fg'} />
                    : <XCircle size={14} className="text-fg-subtle" />}
                  <span className="font-medium">{r.name}</span>
                  <code className="text-xs text-fg-subtle">{r.host}</code>
                  {!r.enabled && <span className="text-[10px] bg-surface-3 px-1.5 rounded">deaktiviert</span>}
                  <span className="ml-auto text-xs">
                    {r.listed
                      ? <span className={r.isWhitelist ? 'text-success-fg font-mono' : 'text-danger-fg font-mono'}>gelistet → {r.response}</span>
                      : <span className="text-fg-subtle">nicht gelistet</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* TAB: Statistics */}
      {tab === 'stats' && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-sm text-fg-muted">Zeitraum:</span>
            {[1, 7, 30].map((d) => (
              <button key={d}
                onClick={() => setStatsDays(d)}
                className={`px-3 py-1 text-xs rounded-full transition-colors ${
                  statsDays === d ? 'bg-accent text-white' : 'bg-surface-2 text-fg-muted hover:bg-surface-3'
                }`}>
                {d === 1 ? '24 h' : `${d} Tage`}
              </button>
            ))}
          </div>

          {stats && (
            <>
              <div className="card p-4">
                <p className="text-2xl font-bold text-fg">{stats.total.toLocaleString('de-DE')}</p>
                <p className="text-xs text-fg-subtle">Treffer in den letzten {stats.days === 1 ? '24 h' : `${stats.days} Tagen`}</p>
              </div>

              <div className="card p-4">
                <p className="text-sm font-semibold text-fg-muted mb-2">Top-Zonen</p>
                {stats.perZone.length === 0
                  ? <p className="text-xs text-fg-subtle">Keine Treffer</p>
                  : stats.perZone.map((p) => (
                      <div key={p.zoneId} className="flex items-center gap-2 py-1.5">
                        <span className="text-sm font-medium text-fg-muted">{p.name}</span>
                        <code className="text-xs text-fg-subtle">{p.host}</code>
                        <div className="flex-1 bg-surface-2 h-2 rounded">
                          <div className="bg-accent h-2 rounded" style={{ width: `${stats.perZone[0] ? (p.hits / stats.perZone[0].hits) * 100 : 0}%` }} />
                        </div>
                        <span className="text-sm tabular-nums text-fg-muted w-16 text-right">{p.hits}</span>
                      </div>
                    ))}
              </div>

              <div className="card p-4">
                <p className="text-sm font-semibold text-fg-muted mb-2">Letzte Treffer</p>
                {stats.recent.length === 0
                  ? <p className="text-xs text-fg-subtle">Keine Treffer</p>
                  : (
                    <div className="space-y-1 max-h-80 overflow-y-auto">
                      {stats.recent.map((h) => (
                        <div key={h.id} className="flex items-center gap-2 text-xs py-1 border-b border-line last:border-0">
                          <AlertTriangle size={11} className="text-danger-fg shrink-0" />
                          <code className="font-mono text-fg-muted w-32 truncate">{h.ip}</code>
                          <span className="text-fg-muted">{h.zoneName}</span>
                          <span className="ml-auto text-fg-subtle">{new Date(h.hitAt).toLocaleString('de-DE')}</span>
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
        <h2 className="text-base font-semibold text-fg">Greylisting</h2>
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

      <div className="card p-4 text-sm text-fg-muted space-y-2">
        <p className="font-medium text-fg">Wie Greylisting funktioniert</p>
        <ol className="list-decimal list-inside space-y-1 text-xs text-fg-subtle">
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
        <h2 className="text-base font-semibold text-fg">GeoIP-Länderfilter</h2>
        <SaveBtn onClick={() => onSave({ geoipMode: mode, geoipCountries: countries })} pending={false} />
      </div>

      <div className="card p-4 space-y-3">
        <p className="text-sm font-semibold text-fg-muted">Filtermodus</p>
        <div className="grid grid-cols-3 gap-2">
          {(['DISABLED', 'WHITELIST', 'BLACKLIST'] as const).map(m => (
            <button key={m} onClick={() => setMode(m)}
              className={`rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors text-left ${
                mode === m ? 'border-accent-fg bg-accent/10 text-accent-fg' : 'border-line text-fg-muted hover:border-line-strong'
              }`}>
              <p className="font-semibold">
                {m === 'DISABLED' ? 'Deaktiviert' : m === 'WHITELIST' ? 'Whitelist' : 'Blacklist'}
              </p>
              <p className="text-[10px] mt-0.5 text-fg-subtle">
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
            <p className="text-sm font-semibold text-fg-muted">
              {mode === 'WHITELIST' ? 'Erlaubte Länder' : 'Blockierte Länder'}
              <span className="ml-2 text-xs font-normal text-fg-subtle">({countries.length} ausgewählt)</span>
            </p>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Suchen…"
              className="border border-line-strong rounded px-2 py-1 text-xs w-36 focus:outline-none focus:ring-2 focus:ring-accent-fg"
            />
          </div>
          <div className="grid grid-cols-3 gap-1 max-h-64 overflow-y-auto">
            {filtered.map(([code, name]) => (
              <label key={code} className="flex items-center gap-1.5 px-2 py-1.5 rounded hover:bg-surface-2 cursor-pointer">
                <input type="checkbox" checked={countries.includes(code)} onChange={() => toggle(code)}
                  className="rounded border-line-strong text-accent-fg focus:ring-accent-fg" />
                <span className="text-xs text-fg-muted truncate" title={name}>
                  <span className="font-mono text-fg-subtle mr-1">{code}</span>{name}
                </span>
              </label>
            ))}
          </div>
          {countries.length > 0 && (
            <button onClick={() => setCountries([])} className="text-xs text-fg-subtle hover:text-danger-fg">
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
        <h2 className="text-base font-semibold text-fg">Anhänge-Filter</h2>
        <SaveBtn onClick={() => onSave({ attachmentEnabled: enabled, attachmentMaxSizeMb: maxSize, attachmentBlockedExt: exts })} pending={false} />
      </div>

      <div className="card p-4 space-y-1">
        <ToggleRow label="Anhänge-Filter aktiviert" desc="Blockiert gefährliche Dateitypen in E-Mail-Anhängen" value={enabled} onChange={setEnabled} />
        <NumInput label="Maximale Anhangsgröße" value={maxSize} onChange={setMaxSize} min={1} max={500} unit="MB" />
      </div>

      <div className="card p-4 space-y-3">
        <p className="text-sm font-semibold text-fg-muted">Blockierte Dateiendungen</p>
        <div className="flex flex-wrap gap-1.5">
          {exts.map(ext => (
            <span key={ext} className="flex items-center gap-1 bg-danger-bg border border-danger-line text-danger-fg text-xs px-2 py-0.5 rounded-full">
              .{ext}
              <button aria-label={`.${ext} entfernen`} onClick={() => setExts(prev => prev.filter(e => e !== ext))}
                className="hover:text-danger-fg ml-0.5">
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
            className="flex-1 border border-line-strong rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent-fg"
          />
          <button onClick={addExt} className="btn-secondary text-sm gap-1">
            <Plus size={13} /> Hinzufügen
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5 pt-1 border-t border-line">
          <p className="w-full text-xs text-fg-subtle mb-1">Schnell hinzufügen:</p>
          {['ps1','vba','jar','msp','reg','inf','lnk','url','xls','doc'].filter(e => !exts.includes(e)).map(e => (
            <button key={e} onClick={() => setExts(prev => [...prev, e])}
              className="text-xs bg-surface-2 hover:bg-surface-3 text-fg-muted px-2 py-0.5 rounded transition-colors">
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

  // 9.3: rspamd / ClamAV deployment state — sections of absent scanners are hidden.
  // A failed request hides nothing (unknown state).
  const { data: caps } = useQuery({
    queryKey: CAPABILITIES_KEY,
    queryFn:  () => api.get<ScannerCapabilities>('/admin/security/capabilities'),
    refetchInterval: 60_000,
    retry: false,
  });
  const nav = visibleSections(SUB_NAV, caps);
  const active = resolveSection(section, nav);
  const sectionNotice = active === 'rspamd' ? scannerNotice('rspamd', caps?.rspamd)
    : active === 'antivirus' ? scannerNotice('clamav', caps?.clamav)
    : null;

  const saveMut = useMutation({
    mutationFn: (data: Partial<SecuritySettings>) =>
      api.put<SecuritySettings>('/admin/security/settings', data),
    onSuccess: () => {
      toast.success('Einstellungen gespeichert');
      void qc.invalidateQueries({ queryKey: ['admin', 'security', 'settings'] });
    },
    onError: (e) => toast.error(errorMessage(e, 'Fehler beim Speichern')),
  });

  function handleSave(data: Partial<SecuritySettings>) {
    saveMut.mutate(data);
  }

  return (
    <div className="flex h-full">
      {/* ── Left sub-nav ────────────────────────────────────────────────── */}
      <aside className="w-44 shrink-0 bg-surface-2 border-r border-line flex flex-col h-full">
        <div className="px-3 py-3 border-b border-line">
          <p className="text-[10px] font-bold uppercase tracking-widest text-fg-subtle">Schutzfilter</p>
        </div>
        <nav className="flex-1 py-2 space-y-0.5">
          {nav.map(({ id, label, icon: Icon }) => (
            <button key={id} onClick={() => setSection(id)}
              className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${
                active === id
                  ? 'bg-surface-3 text-fg border-l-2 border-accent-fg'
                  : 'text-fg-muted hover:bg-surface-3 hover:text-fg'
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
          <div className="text-sm text-fg-subtle">Lade Einstellungen…</div>
        )}
        {settings && (
          <SavePendingContext.Provider value={saveMut.isPending}>
            {active === 'overview'    && <OverviewSection settings={settings} caps={caps} />}
            {/* unavailable scanner: settings stay visible, warning with the reason */}
            {sectionNotice && <div className="mb-4"><ScannerNoticeLine notice={sectionNotice} /></div>}
            {/* Read-only roles (hygiene: read) see the settings disabled — the API answers 403 */}
            {active !== 'overview' && (
              <WriteGuard area="hygiene">
                {active === 'rspamd'      && <RspamdSection    settings={settings} onSave={handleSave} />}
                {active === 'antivirus'   && <ClamavSettingsSection />}
                {active === 'dnsbl'       && <DnsblSection       settings={settings} onSave={handleSave} rspamdAbsent={caps?.rspamd.state === 'absent'} />}
                {active === 'senderlists' && <SenderListsSection />}
                {active === 'spoofing'    && <SpoofingSection />}
                {active === 'greylisting' && <GreylistingSection settings={settings} onSave={handleSave} />}
                {active === 'geoip'       && <GeoipSection       settings={settings} onSave={handleSave} />}
                {active === 'attachments' && <AttachmentsSection settings={settings} onSave={handleSave} />}
              </WriteGuard>
            )}
          </SavePendingContext.Provider>
        )}
      </div>
    </div>
  );
}
