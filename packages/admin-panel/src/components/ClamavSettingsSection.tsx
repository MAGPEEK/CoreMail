// BCP → Schutzfilter → Antivirus (ClamAV, 9.2).
// CoreMail-side policy (saved via /admin/security/clamav, applied by the
// security filter without a restart), live clamd status, EICAR self-test and
// the clamd engine limits as read-only guidance (they live in clamd.conf of the
// clamav container — docs/antivirus.md).
import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bug, CheckCircle, FlaskConical, Info, RefreshCw, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import { errorMessage } from '../lib/errors.js';
import { Toggle } from './Toggle.js';
import { clampNumber } from '../lib/numberInput.js';

// ── API types ─────────────────────────────────────────────────────────────────

type InfectedAction = 'quarantine' | 'reject' | 'pass';
type OversizeAction = 'accept' | 'reject';

interface ClamavPolicy {
  clamavEnabled:           boolean;
  clamavAction:            InfectedAction;
  clamavBlockOnFailure:    boolean;
  clamavTimeoutSec:        number;
  clamavScanLimitMb:       number;
  clamavOversizeAction:    OversizeAction;
  clamavHeuristicsAsVirus: boolean;
  clamavPuaAsVirus:        boolean;
  clamavEncryptedAsVirus:  boolean;
}

interface ClamavPolicyResponse extends ClamavPolicy {
  endpoint: { host: string; port: number; forcedOff: boolean };
}

interface ClamavStatus {
  host: string;
  port: number;
  enabled: boolean;
  online: boolean;
  latencyMs?: number;
  version?: { raw: string; engine?: string; signatureVersion?: number; signatureDate?: string };
  stats?: { queueItems?: number; threadsLive?: number; threadsIdle?: number; threadsMax?: number };
  signatureAgeHours?: number;
  error?: string;
}

interface EicarResult {
  detected: boolean;
  status: 'clean' | 'infected' | 'error' | 'oversize';
  signature?: string;
  category?: 'malware' | 'heuristic' | 'pua' | 'encrypted';
  countsAsVirus?: boolean;
  outcome: 'quarantine' | 'reject' | 'defer' | 'deliver-tagged' | 'deliver';
  latencyMs: number;
  error?: string;
}

const POLICY_KEY = ['admin', 'security', 'clamav'] as const;
const STATUS_KEY = ['admin', 'security', 'clamav', 'status'] as const;

/** Signatures older than this are flagged (freshclam checks at least once a day). */
const STALE_SIGNATURE_HOURS = 48;

const OUTCOME_TEXT: Record<EicarResult['outcome'], string> = {
  quarantine:       'Eine solche Mail würde in die Quarantäne verschoben.',
  reject:           'Eine solche Mail würde beim Empfang abgelehnt.',
  defer:            'Eine solche Mail würde vorübergehend abgewiesen (Absender versucht es erneut).',
  'deliver-tagged': 'Eine solche Mail würde zugestellt und mit einer Kopfzeile markiert.',
  deliver:          'Eine solche Mail würde ohne Befund zugestellt.',
};

// ── small building blocks (module level, never inline) ────────────────────────

function SectionCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="card p-4 space-y-2">
      <p className="text-xs font-semibold text-fg-subtle uppercase tracking-wide pb-2 border-b border-line">{title}</p>
      {children}
    </div>
  );
}

function SettingToggle({ label, desc, value, onChange }:
  { label: string; desc: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 border-b border-line last:border-0">
      <div>
        <p className="text-sm text-fg font-medium">{label}</p>
        <p className="text-xs text-fg-subtle mt-0.5">{desc}</p>
      </div>
      <Toggle active={value} onToggle={() => onChange(!value)} label={label} />
    </div>
  );
}

function ChoiceGroup<T extends string>({ value, onChange, options, label }:
  { value: T; onChange: (v: T) => void; options: { id: T; title: string; desc: string }[]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className={`grid gap-2 ${options.length === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={`rounded-lg border px-3 py-2.5 text-sm text-left transition-colors ${
            value === o.id
              ? 'border-accent-fg bg-accent/10 text-accent-fg'
              : 'border-line text-fg-muted hover:border-line-strong'
          }`}
        >
          <p className="font-semibold">{o.title}</p>
          <p className="text-xs mt-0.5 text-fg-subtle">{o.desc}</p>
        </button>
      ))}
    </div>
  );
}

function NumberRow({ label, desc, value, onChange, min, max, unit }:
  { label: string; desc: string; value: number; onChange: (v: number) => void; min: number; max: number; unit: string }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft((d) => (parseInt(d, 10) === value ? d : String(value))); }, [value]);
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 border-b border-line last:border-0">
      <div>
        <p className="text-sm text-fg font-medium">{label}</p>
        <p className="text-xs text-fg-subtle mt-0.5">{desc}</p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <input
          type="number" min={min} max={max} step={1} value={draft} aria-label={label}
          // Free typing (clamping every keystroke made "15" untypeable: "1" → 5);
          // in-range values apply at once, anything else is clamped on blur.
          onChange={(e) => {
            setDraft(e.target.value);
            const n = parseInt(e.target.value, 10);
            if (Number.isFinite(n) && n >= min && n <= max) onChange(n);
          }}
          onBlur={() => {
            const n = clampNumber(draft, min, max, value);
            setDraft(String(n));
            if (n !== value) onChange(n);
          }}
          className="w-20 border border-line-strong bg-surface rounded px-2 py-1 text-sm text-right text-fg focus:outline-none focus:ring-2 focus:ring-accent-fg"
        />
        <span className="text-xs text-fg-subtle w-6">{unit}</span>
      </div>
    </div>
  );
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <span className="text-sm text-fg-muted shrink-0">{label}</span>
      <span className="text-xs text-fg text-right break-all">{children}</span>
    </div>
  );
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
}

// ── status card ───────────────────────────────────────────────────────────────

function StatusCard({ endpoint }: { endpoint: ClamavPolicyResponse['endpoint'] }) {
  const { data: s, isFetching, refetch, isError } = useQuery({
    queryKey: STATUS_KEY,
    queryFn:  () => api.get<ClamavStatus>('/admin/security/clamav/status'),
    refetchInterval: 60_000,
  });
  const stale = s?.signatureAgeHours !== undefined && s.signatureAgeHours > STALE_SIGNATURE_HOURS;
  const online = !!s?.online;

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${online ? 'bg-success-bg' : 'bg-danger-bg'}`}>
            <Bug size={16} className={online ? 'text-success-fg' : 'text-danger-fg'} />
          </div>
          <div>
            <p className="text-sm font-semibold text-fg">Scanner-Status</p>
            <p className="text-xs text-fg-subtle">clamd im ClamAV-Container</p>
          </div>
        </div>
        <button type="button" onClick={() => void refetch()} className="btn-secondary text-xs flex items-center gap-1" aria-label="Status aktualisieren">
          <RefreshCw size={12} className={isFetching ? 'animate-spin' : ''} /> Aktualisieren
        </button>
      </div>

      <InfoRow label="Erreichbar">
        <span className={`inline-flex items-center gap-1.5 font-medium px-2 py-0.5 rounded-full ${
          online ? 'bg-success-bg text-success-fg' : 'bg-danger-bg text-danger-fg'
        }`}>
          {online ? <CheckCircle size={12} /> : <XCircle size={12} />}
          {s ? (online ? `Online${s.latencyMs !== undefined ? ` (${s.latencyMs} ms)` : ''}` : 'Nicht erreichbar') : (isError ? 'Unbekannt' : 'Prüfe…')}
        </span>
      </InfoRow>
      {s && !online && s.error && <InfoRow label="Fehler"><span className="font-mono">{s.error}</span></InfoRow>}
      {isError && <InfoRow label="Fehler">Sicherheitsfilter nicht erreichbar</InfoRow>}
      <InfoRow label="Engine">{s?.version?.engine ? `ClamAV ${s.version.engine}` : '—'}</InfoRow>
      <InfoRow label="Signaturen">
        {s?.version?.signatureVersion !== undefined ? `Version ${s.version.signatureVersion}` : '—'}
      </InfoRow>
      <InfoRow label="Stand der Datenbank">
        <span className={stale ? 'text-warning-fg font-medium' : ''}>
          {formatDate(s?.version?.signatureDate)}
          {s?.signatureAgeHours !== undefined && ` (vor ${s.signatureAgeHours} h)`}
        </span>
      </InfoRow>
      {s?.stats?.queueItems !== undefined && (
        <InfoRow label="Warteschlange">
          {s.stats.queueItems} Aufträge
          {s.stats.threadsMax !== undefined && ` · ${s.stats.threadsLive ?? 0}/${s.stats.threadsMax} Threads aktiv`}
        </InfoRow>
      )}
      <InfoRow label="Verbindung">
        <span className="font-mono">{endpoint.host}:{endpoint.port}</span>
      </InfoRow>
      <p className="text-xs text-fg-subtle">
        Host und Port kommen aus der Server-Konfiguration (<code>CLAMAV_HOST</code>, <code>CLAMAV_PORT</code>) und sind hier nicht änderbar.
      </p>
      {stale && (
        <div className="bg-warning-bg border border-warning-line rounded-lg px-3 py-2 text-xs text-warning-fg flex items-start gap-1.5">
          <AlertTriangle size={12} className="shrink-0 mt-0.5" />
          Die Signaturdatenbank ist älter als {STALE_SIGNATURE_HOURS} Stunden. Prüfen Sie das Update (freshclam) im ClamAV-Container.
        </div>
      )}
      {endpoint.forcedOff && (
        <div className="bg-warning-bg border border-warning-line rounded-lg px-3 py-2 text-xs text-warning-fg flex items-start gap-1.5">
          <AlertTriangle size={12} className="shrink-0 mt-0.5" />
          Der Virenscan ist per Server-Konfiguration ausgeschaltet (<code>CLAMAV_ENABLED=false</code>). Die Einstellungen unten wirken erst, wenn diese Variable entfernt wird.
        </div>
      )}
    </div>
  );
}

// ── EICAR test card ───────────────────────────────────────────────────────────

function EicarCard() {
  const test = useMutation({
    mutationFn: () => api.post<EicarResult>('/admin/security/clamav/eicar-test'),
    onError: (err) => toast.error(errorMessage(err, 'Test fehlgeschlagen')),
  });
  const r = test.data;

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 bg-info-bg rounded-lg flex items-center justify-center">
          <FlaskConical size={16} className="text-info-fg" />
        </div>
        <div>
          <p className="text-sm font-semibold text-fg">Funktionstest (EICAR)</p>
          <p className="text-xs text-fg-subtle">Harmlose Testdatei, die jeder Virenscanner erkennt</p>
        </div>
      </div>
      <p className="text-xs text-fg-subtle">
        Der Test scannt eine Mail mit der EICAR-Testdatei als Anhang auf demselben Weg wie eingehende Mails
        (Größengrenze, Zeitlimit, Scanner, Regeln) — mit den gespeicherten Einstellungen. Es wird keine Mail zugestellt.
      </p>
      <button type="button" onClick={() => test.mutate()} disabled={test.isPending} className="btn-secondary text-sm">
        {test.isPending ? 'Test läuft…' : 'EICAR-Test ausführen'}
      </button>
      {r && (
        <div
          role="status"
          className={`rounded-lg border px-3 py-2 text-xs space-y-1 ${
            r.detected ? 'bg-success-bg border-success-line text-success-fg' : 'bg-danger-bg border-danger-line text-danger-fg'
          }`}
        >
          <p className="font-semibold flex items-center gap-1.5">
            {r.detected ? <CheckCircle size={12} /> : <XCircle size={12} />}
            {r.detected
              ? `Erkannt: ${r.signature ?? 'Testsignatur'} (${r.latencyMs} ms)`
              : r.status === 'error' ? `Scanner-Fehler: ${r.error ?? 'unbekannt'}`
              : r.status === 'oversize' ? 'Nicht gescannt (Größengrenze)'
              : 'Nicht erkannt — der Scanner arbeitet nicht korrekt'}
          </p>
          <p>{OUTCOME_TEXT[r.outcome]}</p>
        </div>
      )}
    </div>
  );
}

// ── engine limits (read-only guidance) ────────────────────────────────────────

const ENGINE_LIMITS: [string, string, string][] = [
  ['StreamMaxLength', '60M', 'Größte Mail, die clamd annimmt — mindestens so groß wie die Scan-Grenze oben'],
  ['MaxScanSize', '200M', 'Gesamtmenge entpackter Daten je Mail'],
  ['MaxFileSize', '50M', 'Größte einzelne Datei (auch in Archiven)'],
  ['MaxRecursion', '17', 'Verschachtelungstiefe von Archiven'],
  ['MaxFiles', '10000', 'Dateien je Archiv'],
  ['AlertEncryptedArchive', 'yes', 'Passwortgeschützte ZIP/RAR/7z melden (Heuristics.Encrypted.*) — häufiger Schadcode-Träger'],
  ['AlertEncryptedDoc', 'no', 'Verschlüsselte PDFs melden — oft legitim (z. B. Gehaltsabrechnungen)'],
  ['AlertOLE2Macros', 'no', 'Office-Makros melden (viele Fehlalarme bei Geschäftspost)'],
  ['DetectPUA', 'no', 'Potenziell unerwünschte Programme melden (PUA.*)'],
  ['ScanArchive / ScanPDF / ScanOLE2 / ScanMail', 'yes', 'Standard — nicht abschalten'],
  ['FRESHCLAM_CHECKS (Umgebungsvariable)', '12', 'Signatur-Updates pro Tag (Standard: 1)'],
];

function EngineLimitsCard() {
  return (
    <SectionCard title="Engine-Grenzen (im ClamAV-Container)">
      <div className="flex items-start gap-2 text-xs text-fg-muted">
        <Info size={13} className="shrink-0 mt-0.5 text-info-fg" />
        <p>
          Diese Werte stehen in der <code>clamd.conf</code> des ClamAV-Containers und lassen sich hier nicht ändern.
          Empfohlene Werte für 10–500 Postfächer — Einrichtung siehe Dokumentation <code>docs/antivirus.md</code>.
          Ohne eigene Konfiguration gelten die ClamAV-Standardwerte.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-fg-subtle border-b border-line">
              <th className="py-1.5 pr-3 font-medium">Option</th>
              <th className="py-1.5 pr-3 font-medium">Empfehlung</th>
              <th className="py-1.5 font-medium">Bedeutung</th>
            </tr>
          </thead>
          <tbody>
            {ENGINE_LIMITS.map(([opt, val, desc]) => (
              <tr key={opt} className="border-b border-line last:border-0">
                <td className="py-1.5 pr-3 font-mono text-fg">{opt}</td>
                <td className="py-1.5 pr-3 font-mono text-fg">{val}</td>
                <td className="py-1.5 text-fg-muted">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

// ── policy form ───────────────────────────────────────────────────────────────

function toPolicy(p: ClamavPolicyResponse): ClamavPolicy {
  return {
    clamavEnabled:           p.clamavEnabled,
    clamavAction:            p.clamavAction,
    clamavBlockOnFailure:    p.clamavBlockOnFailure,
    clamavTimeoutSec:        p.clamavTimeoutSec,
    clamavScanLimitMb:       p.clamavScanLimitMb,
    clamavOversizeAction:    p.clamavOversizeAction,
    clamavHeuristicsAsVirus: p.clamavHeuristicsAsVirus,
    clamavPuaAsVirus:        p.clamavPuaAsVirus,
    clamavEncryptedAsVirus:  p.clamavEncryptedAsVirus,
  };
}

function PolicyForm({ initial, endpoint }: { initial: ClamavPolicy; endpoint: ClamavPolicyResponse['endpoint'] }) {
  const qc = useQueryClient();
  const [p, setP] = useState<ClamavPolicy>(initial);
  useEffect(() => { setP(initial); }, [initial]);
  const set = <K extends keyof ClamavPolicy>(k: K) => (v: ClamavPolicy[K]) => setP((prev) => ({ ...prev, [k]: v }));
  const dirty = (Object.keys(p) as (keyof ClamavPolicy)[]).some((k) => p[k] !== initial[k]);

  const save = useMutation({
    mutationFn: (data: ClamavPolicy) => api.put<ClamavPolicyResponse>('/admin/security/clamav', data),
    onSuccess: (saved) => {
      toast.success('Antivirus-Einstellungen gespeichert');
      qc.setQueryData(POLICY_KEY, saved);
      void qc.invalidateQueries({ queryKey: ['admin', 'security', 'settings'] });
    },
    onError: (err) => toast.error(errorMessage(err, 'Fehler beim Speichern')),
  });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-fg">Antivirus — ClamAV</h2>
        <button type="button" onClick={() => save.mutate(p)} disabled={save.isPending || !dirty} className="btn-primary text-sm">
          {save.isPending ? 'Speichern…' : 'Speichern'}
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <StatusCard endpoint={endpoint} />
        <EicarCard />
      </div>

      <SectionCard title="Grundeinstellungen">
        <SettingToggle
          label="Virenscan aktiviert"
          desc="Alle eingehenden Mails werden vor der Zustellung von ClamAV geprüft"
          value={p.clamavEnabled}
          onChange={set('clamavEnabled')}
        />
      </SectionCard>

      <SectionCard title="Aktion bei Virenfund">
        <ChoiceGroup<InfectedAction>
          label="Aktion bei Virenfund"
          value={p.clamavAction}
          onChange={set('clamavAction')}
          options={[
            { id: 'quarantine', title: 'Quarantäne',  desc: 'Mail annehmen und in die Quarantäne legen (empfohlen)' },
            { id: 'reject',     title: 'Ablehnen',    desc: 'Mail beim Empfang abweisen, der Absender erhält einen Fehler' },
            { id: 'pass',       title: 'Zustellen und markieren', desc: 'Zustellen mit Kopfzeile X-CoreMail-Virus-Scan: infected' },
          ]}
        />
        {p.clamavAction === 'pass' && (
          <div className="bg-warning-bg border border-warning-line rounded-lg px-3 py-2 text-xs text-warning-fg flex items-start gap-1.5">
            <AlertTriangle size={12} className="shrink-0 mt-0.5" />
            Infizierte Mails erreichen die Postfächer. Nur zur Fehlersuche verwenden.
          </div>
        )}
      </SectionCard>

      <SectionCard title="Bei Ausfall des Scanners">
        <p className="text-xs text-fg-subtle">Gilt, wenn clamd nicht erreichbar ist, einen Fehler meldet oder das Zeitlimit überschreitet.</p>
        <ChoiceGroup<'accept' | 'defer'>
          label="Verhalten bei Ausfall des Scanners"
          value={p.clamavBlockOnFailure ? 'defer' : 'accept'}
          onChange={(v) => set('clamavBlockOnFailure')(v === 'defer')}
          options={[
            { id: 'accept', title: 'Annehmen und markieren', desc: 'Ungeprüft zustellen mit Kopfzeile „unscanned“ — Mail kommt immer an' },
            { id: 'defer',  title: 'Vorübergehend abweisen', desc: 'Antwort 451: der sendende Server versucht es später erneut (sicherer)' },
          ]}
        />
        <NumberRow
          label="Zeitlimit je Scan"
          desc="Danach gilt der Scan als fehlgeschlagen (5–25 Sekunden)"
          value={p.clamavTimeoutSec}
          onChange={set('clamavTimeoutSec')}
          min={5} max={25} unit="s"
        />
      </SectionCard>

      <SectionCard title="Große Nachrichten">
        <NumberRow
          label="Scan-Grenze"
          desc="Größere Mails werden nicht an den Scanner übergeben (1–50 MB)"
          value={p.clamavScanLimitMb}
          onChange={set('clamavScanLimitMb')}
          min={1} max={50} unit="MB"
        />
        <p className="text-xs text-fg-subtle pt-1">Mails über der Grenze:</p>
        <ChoiceGroup<OversizeAction>
          label="Aktion für Mails über der Scan-Grenze"
          value={p.clamavOversizeAction}
          onChange={set('clamavOversizeAction')}
          options={[
            { id: 'accept', title: 'Annehmen und markieren', desc: 'Ungeprüft zustellen mit Kopfzeile „too-large“' },
            { id: 'reject', title: 'Ablehnen',               desc: 'Mail beim Empfang abweisen' },
          ]}
        />
      </SectionCard>

      <SectionCard title="Einstufung von Funden">
        <p className="text-xs text-fg-subtle">
          Abgeschaltete Kategorien gelten nicht als Virus: die Mail wird zugestellt und mit „suspicious“ markiert.
          Echte Virensignaturen gelten immer als Virus.
        </p>
        <SettingToggle
          label="Heuristische Funde als Virus werten"
          desc="Heuristics.* — z. B. Phishing-Merkmale, Office-Makros, defekte Programmdateien"
          value={p.clamavHeuristicsAsVirus}
          onChange={set('clamavHeuristicsAsVirus')}
        />
        <SettingToggle
          label="Potenziell unerwünschte Programme als Virus werten"
          desc="PUA.* — nur wirksam, wenn DetectPUA im ClamAV-Container eingeschaltet ist"
          value={p.clamavPuaAsVirus}
          onChange={set('clamavPuaAsVirus')}
        />
        <SettingToggle
          label="Verschlüsselte Archive als Virus werten"
          desc="Heuristics.Encrypted.* — passwortgeschützte ZIP/RAR/7z/PDF; nur wirksam mit AlertEncryptedArchive/-Doc im Container"
          value={p.clamavEncryptedAsVirus}
          onChange={set('clamavEncryptedAsVirus')}
        />
      </SectionCard>

      <EngineLimitsCard />
    </div>
  );
}

// ── root ──────────────────────────────────────────────────────────────────────

export function ClamavSettingsSection() {
  const { data, isError, error } = useQuery({
    queryKey: POLICY_KEY,
    queryFn:  () => api.get<ClamavPolicyResponse>('/admin/security/clamav'),
  });
  if (isError) return <div className="text-sm text-danger-fg">{errorMessage(error, 'Einstellungen konnten nicht geladen werden')}</div>;
  if (!data) return <div className="text-sm text-fg-subtle">Lade Antivirus-Einstellungen…</div>;
  return <PolicyFormWrapper data={data} />;
}

function PolicyFormWrapper({ data }: { data: ClamavPolicyResponse }) {
  // stable object per server state (avoids resetting the form on every render)
  const [initial, setInitial] = useState(() => toPolicy(data));
  useEffect(() => { setInitial(toPolicy(data)); }, [data]);
  return <PolicyForm initial={initial} endpoint={data.endpoint} />;
}
