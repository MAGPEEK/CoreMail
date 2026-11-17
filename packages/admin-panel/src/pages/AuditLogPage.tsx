import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ClipboardList, Download, FileText, RefreshCw,
  CheckCircle2, XCircle, Info, X, AlertTriangle,
  Activity, Users, BarChart3, Code2, ShieldCheck, Copy, Loader2,
} from 'lucide-react';
import { api, apiFetch, saveBlob } from '../api/client.js';
import toast from 'react-hot-toast';
import { useT } from '../i18n/useT.js';
import { DataTable, type Column } from '../components/DataTable.js';
import { apiErrorFromBody } from '../lib/errors.js';
import { dayEndIso, dayStartIso, signatureFromHeader } from '../lib/auditFilters.js';

// v3.18.34: AnomaliesResponse interface + banner removed — the red banners were
// confusing in practice (showed e.g. one's own settings changes as
// "critical action"). The audit log itself shows all relevant actions.

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuditEntry {
  id: string;
  timestamp: string;
  actorId: string;
  actorEmail: string;
  action: string;
  targetType: string;
  targetId?: string;
  targetName?: string;
  ipAddress?: string;
  userAgent?: string;
  success: boolean;
  errorMsg?: string;
  changes?: Record<string, unknown>;
}

interface AuditResponse {
  total: number;
  limit: number;
  offset: number;
  entries: AuditEntry[];
}

interface AuditStats {
  totalEntries: number;
  last24h: number;
  last7d: number;
  topActors: { actorEmail: string; count: number }[];
  topActions: { action: string; count: number }[];
  failureRate: number;
  oldestEntry: string | null;
  newestEntry: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtDt(iso: string) {
  return new Date(iso).toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

/**
 * Check an export file against its signature (POST /admin/audit-log/verify-export,
 * raw bytes). The signature is the X-CoreMail-Signature value of the export.
 */
function VerifyExportPanel({ lastSignature }: { lastSignature: string | null }) {
  const t = useT();
  const [file, setFile] = useState<File | null>(null);
  const [signature, setSignature] = useState('');
  const [result, setResult] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  async function verify() {
    if (!file || !signature.trim() || busy) return;
    setBusy(true); setResult(null);
    try {
      const res = await apiFetch('/admin/audit-log/verify-export', {
        method: 'POST', body: file, headers: { 'X-CoreMail-Signature': signature.trim() },
      }, 'application/octet-stream');
      const body = await res.json().catch(() => ({})) as { valid?: boolean };
      if (!res.ok) throw apiErrorFromBody(body, res.status);
      setResult(body.valid === true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-4 bg-surface border border-line rounded-lg p-4 space-y-3">
      <div className="flex items-center gap-2">
        <ShieldCheck size={16} className="text-fg-subtle" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-fg">{t('audit_verify_title')}</h2>
      </div>
      <p className="text-xs text-fg-subtle">{t('audit_verify_hint')}</p>
      {lastSignature && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-fg-subtle shrink-0">{t('audit_last_signature')}</span>
          <code className="font-mono text-fg-muted bg-surface-2 px-1.5 py-0.5 rounded truncate">{lastSignature}</code>
          <button type="button" className="p-1 rounded text-fg-subtle hover:text-fg hover:bg-surface-2"
            aria-label={t('audit_copy_signature')} title={t('audit_copy_signature')}
            onClick={() => { void navigator.clipboard?.writeText(lastSignature).then(() => toast.success(t('audit_copy_signature'))); }}>
            <Copy size={12} aria-hidden="true" />
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input type="file" accept=".csv,.json,.pdf" aria-label={t('audit_verify_file')} className="text-xs text-fg-muted"
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null); }} />
        <input value={signature} onChange={(e) => { setSignature(e.target.value); setResult(null); }}
          className="input flex-1 min-w-64 font-mono text-xs" placeholder="hmac-sha256=…" aria-label={t('audit_verify_sig')} />
        <button type="button" onClick={() => void verify()} disabled={!file || !signature.trim() || busy}
          className="btn-secondary text-xs flex items-center gap-1.5 disabled:cursor-not-allowed">
          {busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <ShieldCheck size={13} aria-hidden="true" />}
          {t('audit_verify_btn')}
        </button>
      </div>
      {result !== null && (
        <p role="status" className={`flex items-center gap-1.5 text-xs font-medium ${result ? 'text-success-fg' : 'text-danger-fg'}`}>
          {result ? <CheckCircle2 size={14} aria-hidden="true" /> : <XCircle size={14} aria-hidden="true" />}
          {result ? t('audit_verify_valid') : t('audit_verify_invalid')}
        </p>
      )}
    </div>
  );
}

// v3.18.30: Human-readable action labels. The audit middleware writes the pattern
// `<resource>.<verb>` (e.g. `settings.put`, `mailboxes.delete`) — for admins this is
// not very meaningful, though. This map translates common actions into
// human-readable descriptions + assigns colors to them.
type ActionMeta = { label: string; tone: 'create' | 'update' | 'delete' | 'auth' | 'critical' | 'read' };

const ACTION_MAP: Record<string, ActionMeta> = {
  // Settings (v3.18.34: now with sub-resource in the action string)
  'settings.put':                 { label: 'Einstellungen geändert',         tone: 'update' },
  'settings.post':                { label: 'Einstellungen geändert',         tone: 'update' },
  'settings.org.put':             { label: 'Organisations-Einstellungen geändert', tone: 'update' },
  'settings.mail.put':            { label: 'Mail-Einstellungen geändert',    tone: 'update' },
  'settings.security.put':        { label: 'Sicherheitseinstellungen geändert', tone: 'update' },
  'settings.maintenance.put':     { label: 'Wartungsmodus geändert',         tone: 'update' },
  'audit.enabled':                { label: 'Audit-Log AKTIVIERT',            tone: 'critical' },
  'audit.disabled':               { label: 'Audit-Log DEAKTIVIERT',          tone: 'critical' },
  // Mailboxes
  'mailboxes.post':               { label: 'Postfach angelegt',              tone: 'create' },
  'mailboxes.put':                { label: 'Postfach geändert',              tone: 'update' },
  'mailboxes.patch':              { label: 'Postfach geändert',              tone: 'update' },
  'mailboxes.delete':             { label: 'Postfach gelöscht',              tone: 'delete' },
  'mailbox.create':               { label: 'Postfach angelegt',              tone: 'create' },
  'mailbox.update':               { label: 'Postfach geändert',              tone: 'update' },
  'mailbox.delete':               { label: 'Postfach gelöscht',              tone: 'delete' },
  // Domains
  'domains.post':                 { label: 'Domain angelegt',                tone: 'create' },
  'domains.put':                  { label: 'Domain geändert',                tone: 'update' },
  'domains.delete':               { label: 'Domain gelöscht',                tone: 'delete' },
  'domain.create':                { label: 'Domain angelegt',                tone: 'create' },
  'domain.delete':                { label: 'Domain gelöscht',                tone: 'delete' },
  // Auth
  'auth.login':                   { label: 'Anmeldung erfolgreich',          tone: 'auth' },
  'auth.login_failed':            { label: 'Anmeldung fehlgeschlagen',       tone: 'delete' },
  'auth.logout':                  { label: 'Abgemeldet',                     tone: 'auth' },
  'auth.mfa_enabled':             { label: 'MFA aktiviert',                  tone: 'create' },
  'auth.mfa_disabled':            { label: 'MFA deaktiviert',                tone: 'critical' },
  'session.revoke':               { label: 'Session widerrufen',             tone: 'delete' },
  // Backups (v3.18.34: extended action paths)
  'backups.post':                 { label: 'Backup gestartet',               tone: 'create' },
  'backups.delete':               { label: 'Backup gelöscht',                tone: 'delete' },
  'backups.full.post':            { label: 'Vollbackup gestartet',           tone: 'create' },
  'backups.mailbox.post':         { label: 'Mailbox-Backup gestartet',       tone: 'create' },
  'backups.restore.post':         { label: 'Backup wiederhergestellt',       tone: 'update' },
  'backups.import.post':          { label: 'Backup-Datei wiederhergestellt', tone: 'update' },
  'backups.schedules.recommended.post': { label: 'Empfohlene Sicherung eingerichtet', tone: 'create' },
  'backups.jobs.delete':          { label: 'Backup-Job gelöscht',            tone: 'delete' },
  'backups.archive.delete':       { label: 'Backup-Archiv-Objekt gelöscht',  tone: 'delete' },
  'backups.schedules.post':       { label: 'Backup-Zeitplan angelegt',       tone: 'create' },
  'backups.schedules.put':        { label: 'Backup-Zeitplan geändert',       tone: 'update' },
  'backups.schedules.delete':     { label: 'Backup-Zeitplan gelöscht',       tone: 'delete' },
  'backups.schedules.run.post':   { label: 'Zeitplan manuell ausgeführt',    tone: 'create' },
  'backup.full.trigger':          { label: 'Vollbackup gestartet',           tone: 'create' },
  'backup.mailbox.trigger':       { label: 'Mailbox-Backup gestartet',       tone: 'create' },
  'backup.mbox.import':           { label: 'MBOX-Import (Restore)',          tone: 'update' },
  'backup.restore':               { label: 'Backup wiederhergestellt',       tone: 'update' },
  'backup.schedule.recommended':  { label: 'Empfohlene Sicherung eingerichtet', tone: 'create' },
  'backup.job.delete':            { label: 'Backup-Job gelöscht',            tone: 'delete' },
  'backup.archive.delete':        { label: 'Backup-Archiv-Objekt gelöscht',  tone: 'delete' },
  // Calendar Sharing
  'calendar.share.create':        { label: 'Kalender freigegeben',           tone: 'create' },
  'calendar.share.update':        { label: 'Freigabe geändert',              tone: 'update' },
  'calendar.share.delete':        { label: 'Freigabe entzogen',              tone: 'delete' },
  'calendar.share.self_remove':   { label: 'Freigabe selbst verlassen',      tone: 'delete' },
  // Rules / Compliance
  'rule.create':                  { label: 'Regel angelegt',                 tone: 'create' },
  'rule.update':                  { label: 'Regel geändert',                 tone: 'update' },
  'rule.delete':                  { label: 'Regel gelöscht',                 tone: 'delete' },
  'retention.run':                { label: 'Aufbewahrung ausgeführt',        tone: 'update' },
  // Roles
  'user.role':                    { label: 'Rolle geändert',                 tone: 'critical' },
  'roles.put':                    { label: 'Rolle geändert',                 tone: 'critical' },
  // Gateway
  'gateway.settings_updated':     { label: 'SMTP-Gateway konfiguriert',      tone: 'update' },
  // v3.18.34: Audit-Log (sensitive GETs)
  'audit-log.export.csv.get':     { label: 'Audit-Log exportiert (CSV)',     tone: 'read' },
  'audit-log.export.json.get':    { label: 'Audit-Log exportiert (JSON)',    tone: 'read' },
  'audit-log.export.pdf.get':     { label: 'Audit-Log exportiert (PDF)',     tone: 'read' },
  'audit-log.verify-export.post': { label: 'Export-Signatur geprüft',        tone: 'read' },
  'message-trace.export.get':     { label: 'Nachrichtenverfolgung exportiert', tone: 'read' },
  'mailbox.sessions.revoke':      { label: 'Sitzungen abgemeldet',           tone: 'delete' },
  'quarantine.release':           { label: 'Quarantäne-Mail freigegeben',    tone: 'update' },
  'backup.archive.download':      { label: 'Backup-Archiv heruntergeladen',  tone: 'read' },
  'audit-log.anomalies.get':      { label: 'Anomalien-Report abgerufen',     tone: 'read' },
  // v3.18.37: Legacy action strings (before the v3.18.34 path fix — sub-router mutation)
  'anomalies.get':                { label: 'Anomalien-Report abgerufen',     tone: 'read' },
  'full.post':                    { label: 'Vollbackup gestartet',           tone: 'create' },
  'jobs.delete':                  { label: 'Backup-Job gelöscht',            tone: 'delete' },
  'jobs.post':                    { label: 'Backup-Job gestartet',           tone: 'create' },
  'tags.post':                    { label: 'Tag angelegt',                   tone: 'create' },
  'tags.put':                     { label: 'Tag geändert',                   tone: 'update' },
  'tags.delete':                  { label: 'Tag gelöscht',                   tone: 'delete' },
  'archive.delete':               { label: 'Backup-Archiv-Objekt gelöscht',  tone: 'delete' },
  'mailbox.post':                 { label: 'Mailbox-Backup gestartet',       tone: 'create' },
  'schedules.post':               { label: 'Backup-Zeitplan angelegt',       tone: 'create' },
  'schedules.put':                { label: 'Backup-Zeitplan geändert',       tone: 'update' },
  'schedules.delete':             { label: 'Backup-Zeitplan gelöscht',       tone: 'delete' },
  'run.post':                     { label: 'Zeitplan manuell ausgeführt',    tone: 'create' },
  'activate-https.post':          { label: 'Zertifikat für HTTPS aktiviert', tone: 'update' },
  'activate-protocol.post':       { label: 'Zertifikat für Mail-Protokolle aktiviert', tone: 'update' },
  'activate-https.delete':        { label: 'HTTPS-Aktivierung entfernt',     tone: 'update' },
  'renew.post':                   { label: 'Zertifikat erneuert',            tone: 'update' },
  'upload.post':                  { label: 'Zertifikat hochgeladen',         tone: 'create' },
  'self-signed.post':             { label: 'Selbst-signiertes Zertifikat erzeugt', tone: 'create' },
  'regenerate-dkim.post':         { label: 'DKIM-Schlüssel neu erzeugt',     tone: 'update' },
  'make-primary.post':            { label: 'Primäre Domain gesetzt',         tone: 'update' },
  'dkim-record.get':              { label: 'DKIM DNS-Eintrag abgerufen',     tone: 'read' },
  'dns-check.get':                { label: 'DNS-Einrichtung geprüft',        tone: 'read' },
  // v3.18.37: Server-Settings (admin/servers/*)
  'servers.settings.put':         { label: 'Server-Einstellungen geändert',  tone: 'update' },
  'servers.settings.get':         { label: 'Server-Einstellungen abgerufen', tone: 'read' },
  'servers.settings.derive.post': { label: 'Server-URLs neu abgeleitet',     tone: 'update' },
  // v3.18.37: Retention-Tags (admin/compliance/retention/*)
  'retention.tags.post':          { label: 'Aufbewahrungs-Tag angelegt',     tone: 'create' },
  'retention.tags.put':           { label: 'Aufbewahrungs-Tag geändert',     tone: 'update' },
  'retention.tags.delete':        { label: 'Aufbewahrungs-Tag gelöscht',     tone: 'delete' },
  'retention.policy.post':        { label: 'Aufbewahrungsrichtlinie angelegt', tone: 'create' },
  'retention.policy.put':         { label: 'Aufbewahrungsrichtlinie geändert', tone: 'update' },
  'retention.policy.delete':      { label: 'Aufbewahrungsrichtlinie gelöscht', tone: 'delete' },
  // v3.18.37: Dashboard, Logs, Services
  'dashboard.get':                { label: 'Dashboard abgerufen',            tone: 'read' },
  'logs.get':                     { label: 'System-Logs abgerufen',          tone: 'read' },
  'services.put':                 { label: 'Service-Einstellung geändert',   tone: 'update' },
  'services.restart.post':        { label: 'Service neugestartet',           tone: 'update' },
  // v3.18.34: Certificates
  'certificates.post':            { label: 'Zertifikat angelegt',            tone: 'create' },
  'certificates.put':             { label: 'Zertifikat geändert',            tone: 'update' },
  'certificates.delete':          { label: 'Zertifikat gelöscht',            tone: 'delete' },
  'certificates.activate-https.post':    { label: 'Zertifikat für HTTPS aktiviert',         tone: 'update' },
  'certificates.activate-protocol.post': { label: 'Zertifikat für Mail-Protokolle aktiviert', tone: 'update' },
  'certificates.activate-https.delete':  { label: 'HTTPS-Aktivierung entfernt',             tone: 'update' },
  'certificates.renew.post':             { label: 'Zertifikat erneuert',                    tone: 'update' },
  'certificates.upload.post':            { label: 'Zertifikat hochgeladen',                 tone: 'create' },
  'certificates.self-signed.post':       { label: 'Selbst-signiertes Zertifikat erzeugt',   tone: 'create' },
  'certificates.regenerate-dkim.post':   { label: 'DKIM-Schlüssel neu erzeugt',             tone: 'update' },
  // v5.2.13: Let's Encrypt + SMTP-Outbound-Config (smarthost relay)
  'certificates.letsencrypt.post':       { label: "Let's Encrypt Zertifikat angefordert",   tone: 'create' },
  'letsencrypt.post':                    { label: "Let's Encrypt Zertifikat angefordert",   tone: 'create' },
  'smtp-config.settings.get':            { label: 'SMTP-Outbound-Konfiguration abgerufen',  tone: 'read' },
  'smtp-config.settings.put':            { label: 'SMTP-Outbound-Konfiguration geändert',   tone: 'update' },
  'smtp-config.test-smarthost.post':     { label: 'Smarthost-Verbindung getestet',          tone: 'read' },
  // v3.18.34: aliases, Shared Mailboxes (submenus)
  'aliases.post':                 { label: 'E-Mail-Alias angelegt',          tone: 'create' },
  'aliases.delete':               { label: 'E-Mail-Alias gelöscht',          tone: 'delete' },
  'shared-mailboxes.post':        { label: 'Shared Mailbox angelegt',        tone: 'create' },
  'shared-mailboxes.put':         { label: 'Shared Mailbox geändert',        tone: 'update' },
  'shared-mailboxes.delete':      { label: 'Shared Mailbox gelöscht',        tone: 'delete' },
  // v3.18.34: Transport Rules, Quarantine, Queues
  'transport-rules.post':         { label: 'Transportregel angelegt',        tone: 'create' },
  'transport-rules.put':          { label: 'Transportregel geändert',        tone: 'update' },
  'transport-rules.delete':       { label: 'Transportregel gelöscht',        tone: 'delete' },
  'quarantine.release.post':      { label: 'Quarantäne-Mail freigegeben',    tone: 'update' },
  'quarantine.delete':            { label: 'Quarantäne-Mail gelöscht',       tone: 'delete' },
  'queues.flush.post':            { label: 'Warteschlange geleert',          tone: 'update' },
  'queues.retry.post':            { label: 'Warteschlange erneut versucht',  tone: 'update' },
};

function actionMeta(action: string): ActionMeta {
  if (ACTION_MAP[action]) return ACTION_MAP[action];
  // Heuristic: fallback by verb
  const verb = action.split('.').pop()?.toLowerCase() ?? '';
  if (verb === 'post' || verb === 'create')      return { label: action, tone: 'create' };
  if (verb === 'delete')                          return { label: action, tone: 'delete' };
  if (verb === 'put' || verb === 'patch' || verb === 'update') return { label: action, tone: 'update' };
  if (verb === 'get')                             return { label: action, tone: 'read' };
  return { label: action, tone: 'read' };
}

function ActionBadge({ action }: { action: string }) {
  const meta = actionMeta(action);
  const color = meta.tone === 'create'   ? 'bg-success-bg text-success-fg'
              : meta.tone === 'delete'   ? 'bg-danger-bg text-danger-fg'
              : meta.tone === 'update'   ? 'bg-info-bg text-info-fg'
              : meta.tone === 'auth'     ? 'bg-info-bg text-info-fg'
              : meta.tone === 'critical' ? 'bg-warning-bg text-warning-fg border border-warning-line'
              : 'bg-surface-2 text-fg-muted';
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${color}`}
      title={action}
    >
      {meta.label}
    </span>
  );
}

function KpiCard({
  icon: Icon, label, value, accent,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div className="bg-surface border border-line rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-fg-subtle uppercase tracking-wide">{label}</span>
        <Icon size={16} className={accent} />
      </div>
      <div className="text-2xl font-semibold text-fg">{value}</div>
    </div>
  );
}

function TopList({
  title, icon: Icon, items, valueColor = 'bg-accent',
}: {
  title: string;
  icon: typeof Users;
  items: { label: string; count: number }[];
  valueColor?: string;
}) {
  const max = items.length > 0 ? items[0]!.count : 1;
  return (
    <div className="bg-surface border border-line rounded-lg p-4">
      <div className="flex items-center gap-2 mb-3">
        <Icon size={16} className="text-fg-subtle" />
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-fg-subtle">—</p>
      ) : (
        <div className="space-y-1.5">
          {items.map((it) => (
            <div key={it.label} className="flex items-center gap-2 text-xs">
              <div className="w-44 truncate text-fg-muted" title={it.label}>{it.label || '(unknown)'}</div>
              <div className="flex-1 bg-surface-2 rounded-full h-1.5 overflow-hidden">
                <div
                  className={`${valueColor} h-full`}
                  style={{ width: `${Math.max(2, (it.count / max) * 100)}%` }}
                />
              </div>
              <div className="w-10 text-right font-mono text-fg-muted">{it.count}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 100;
const DISMISS_KEY = 'coremail:audit-immutable-notice-dismissed';

export function AuditLogPage() {
  const t = useT();
  const [filters, setFilters] = useState({
    action: '', targetType: '', from: '', to: '', success: '',
    actorEmail: '', ipAddress: '', searchText: '',
  });
  const [offset, setOffset] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [noticeDismissed, setNoticeDismissed] = useState<boolean>(() => {
    try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
  });

  // ─── Build URLSearchParams from current filters (used by list + exports)
  const buildParams = (extra?: Record<string, string>): URLSearchParams => {
    const p = new URLSearchParams(extra ?? {});
    if (filters.action)      p.set('action', filters.action);
    if (filters.targetType)  p.set('targetType', filters.targetType);
    if (filters.actorEmail)  p.set('actorEmail', filters.actorEmail);
    if (filters.ipAddress)   p.set('ipAddress', filters.ipAddress);
    if (filters.searchText)  p.set('searchText', filters.searchText);
    const from = dayStartIso(filters.from);
    const to = dayEndIso(filters.to);
    if (from)                p.set('from', from);
    if (to)                  p.set('to', to);
    if (filters.success !== '') p.set('success', filters.success);
    return p;
  };

  const query = useQuery<AuditResponse>({
    queryKey: ['admin-audit-log', filters, offset],
    queryFn: () => {
      const params = buildParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      return api.get(`/admin/audit-log?${params.toString()}`);
    },
  });

  const stats = useQuery<AuditStats>({
    queryKey: ['admin-audit-log-stats'],
    queryFn: () => api.get('/admin/audit-log/stats'),
    refetchInterval: 30_000,
  });

  // v3.18.34: Anomalies query removed — banner was too noisy

  // Fetch-to-blob with the Authorization header — no ?token= in URLs (logs/history)
  // The signature header is kept so the admin can copy it for a later check.
  const [exporting, setExporting] = useState<'csv' | 'pdf' | 'json' | null>(null);
  const [lastSignature, setLastSignature] = useState<string | null>(null);
  const handleExport = async (format: 'csv' | 'pdf' | 'json') => {
    if (exporting) return;
    setExporting(format);
    try {
      const params = buildParams();
      const res = await apiFetch(`/admin/audit-log/export.${format}?${params.toString()}`, {}, null);
      if (!res.ok) throw apiErrorFromBody(await res.json().catch(() => ({ error: res.statusText })), res.status);
      const stamp = new Date().toISOString().slice(0, 10);
      saveBlob(await res.blob(), `audit-log-${stamp}.${format}`);
      setLastSignature(signatureFromHeader(res.headers.get('x-coremail-signature')));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export fehlgeschlagen');
    } finally {
      setExporting(null);
    }
  };

  const dismissNotice = () => {
    setNoticeDismissed(true);
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* ignore */ }
  };

  const data = query.data;
  const entries = data?.entries ?? [];
  const total   = data?.total ?? 0;
  const page    = Math.floor(offset / PAGE_SIZE) + 1;

  const setFilter = (k: keyof typeof filters, v: string) => {
    setFilters(f => ({ ...f, [k]: v }));
    setOffset(0);
  };

  const hasAnyFilter =
    filters.action || filters.targetType || filters.from || filters.to ||
    filters.success || filters.actorEmail || filters.ipAddress || filters.searchText;

  const s = stats.data;

  const columns: Column<AuditEntry>[] = [
    { key: 'ts', header: 'Zeitpunkt', className: 'text-xs text-fg-muted whitespace-nowrap', cell: (e) => fmtDt(e.timestamp) },
    {
      key: 'actor', header: 'Akteur',
      cell: (e) => (
        // v3.18.37: Fallback when actorEmail is empty (e.g. cron jobs, system actions)
        <p className="text-fg text-xs font-medium">
          {e.actorEmail || (e.actorId ? <span className="text-fg-subtle italic">System ({e.actorId.slice(0, 8)}…)</span> : <span className="text-fg-subtle italic">System</span>)}
        </p>
      ),
    },
    { key: 'action', header: 'Aktion', cell: (e) => <ActionBadge action={e.action} /> },
    {
      key: 'target', header: 'Ziel', className: 'text-xs text-fg-muted',
      cell: (e) => (
        <>
          <span className="text-fg-subtle">{e.targetType}</span>
          {e.targetName && <span className="ml-1 text-fg-muted">{e.targetName}</span>}
        </>
      ),
    },
    { key: 'ip', header: 'IP', className: 'text-xs text-fg-subtle font-mono', cell: (e) => e.ipAddress ?? '—' },
    {
      key: 'ok', header: 'Status', headerClassName: 'text-center', className: 'text-center',
      cell: (e) => e.success
        ? <CheckCircle2 size={15} className="text-success-fg mx-auto" aria-label="Erfolgreich" />
        : <XCircle size={15} className="text-danger-fg mx-auto" aria-label="Fehlgeschlagen" />,
    },
  ];

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <ClipboardList size={22} className="text-accent-fg" />
          <div>
            <h1 className="text-xl font-semibold text-fg">Audit-Log</h1>
            <p className="text-sm text-fg-subtle">Alle Admin-Aktionen protokolliert</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={() => void handleExport('csv')} disabled={exporting !== null}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-fg-muted border border-line-strong rounded hover:bg-surface-2 disabled:cursor-wait">
            {exporting === 'csv' ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} {t('audit_export_csv')}
          </button>
          <button onClick={() => void handleExport('pdf')} disabled={exporting !== null}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-fg-muted border border-line-strong rounded hover:bg-surface-2 disabled:cursor-wait"
            title="PDF — signiert mit HMAC-SHA256 (siehe X-CoreMail-Signature-Header)">
            {exporting === 'pdf' ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />} PDF
          </button>
          <button onClick={() => void handleExport('json')} disabled={exporting !== null}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-fg-muted border border-line-strong rounded hover:bg-surface-2 disabled:cursor-wait"
            title="JSON — signiert mit HMAC-SHA256, für SIEM-Integration (Splunk, Azure Sentinel, ELK)">
            <Code2 size={14} /> JSON
          </button>
        </div>
      </div>

      {/* v3.18.34: Anomalies banner completely removed — the audit log itself shows
          all relevant actions; the banner was confusing in practice
          (one's own settings changes were shown as "critical action"). */}

      {/* Immutability notice + signature hint */}
      {!noticeDismissed && (
        <div className="mb-4 flex items-start gap-2 bg-info-bg border border-info-line text-info-fg rounded px-3 py-2 text-xs">
          <Info size={14} className="text-info-fg shrink-0 mt-0.5" />
          <span className="flex-1">
            {t('audit_immutable_notice')}
            {' '}<strong>Exports sind kryptografisch signiert:</strong> Der HTTP-Response-Header
            <code className="mx-1 font-mono bg-surface px-1 rounded">X-CoreMail-Signature: hmac-sha256=…</code>
            enthält einen HMAC-SHA256 über den exakten Datei-Inhalt, berechnet mit einem
            Server-Schlüssel (AUDIT_EXPORT_SIGNING_KEY, sonst abgeleitet aus JWT_SECRET + PEPPER).
            Eine veränderte Datei lässt sich ohne diesen Schlüssel nicht neu signieren; geprüft
            wird unten mit „{t('audit_verify_btn')}" — ein einfacher
            <code className="mx-1 font-mono bg-surface px-1 rounded">shasum</code>-Vergleich passt nicht.
          </span>
          <button onClick={dismissNotice} className="text-info-fg hover:text-info-fg" aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}

      <VerifyExportPanel lastSignature={lastSignature} />

      {/* Statistics dashboard */}
      {s && (
        <div className="mb-6 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <KpiCard icon={Activity}      label={t('audit_stat_total')}        value={s.totalEntries.toLocaleString('de-DE')} accent="text-fg-subtle" />
            <KpiCard icon={Activity}      label={t('audit_stat_24h')}          value={s.last24h.toLocaleString('de-DE')}      accent="text-info-fg" />
            <KpiCard icon={Activity}      label={t('audit_stat_7d')}           value={s.last7d.toLocaleString('de-DE')}       accent="text-info-fg" />
            <KpiCard icon={AlertTriangle} label={t('audit_stat_failure_rate')} value={`${(s.failureRate * 100).toFixed(2)}%`} accent="text-danger-fg" />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <TopList
              title={t('audit_top_actors')}
              icon={Users}
              items={s.topActors.map(a => ({ label: a.actorEmail, count: a.count }))}
              valueColor="bg-accent"
            />
            <TopList
              title={t('audit_top_actions')}
              icon={BarChart3}
              items={s.topActions.map(a => ({ label: a.action, count: a.count }))}
              valueColor="bg-info-fg"
            />
          </div>
        </div>
      )}

      {/* Additional filters (server-side, like every filter of this list) */}
      <div className="flex flex-wrap gap-2 mb-3">
        <input value={filters.actorEmail} onChange={e => setFilter('actorEmail', e.target.value)}
          className="border border-line-strong rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent-fg w-56"
          placeholder={t('audit_filter_actor_email')} aria-label={t('audit_filter_actor_email')} />
        <input value={filters.ipAddress} onChange={e => setFilter('ipAddress', e.target.value)}
          className="border border-line-strong rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent-fg w-44"
          placeholder={t('audit_filter_ip')} aria-label={t('audit_filter_ip')} />
        <input type="date" value={filters.from} onChange={e => setFilter('from', e.target.value)} aria-label="Von"
          className="border border-line-strong rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent-fg" />
        <input type="date" value={filters.to} onChange={e => setFilter('to', e.target.value)} aria-label="Bis"
          className="border border-line-strong rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent-fg" />
        {hasAnyFilter && (
          <button
            onClick={() => {
              setFilters({
                action: '', targetType: '', from: '', to: '', success: '',
                actorEmail: '', ipAddress: '', searchText: '',
              });
              setOffset(0);
            }}
            className="px-3 py-1.5 text-xs text-fg-subtle border border-line rounded hover:bg-surface-2">
            Filter zurücksetzen
          </button>
        )}
      </div>

      {/* List — server-side paging (API: limit/offset + filters) */}
      <DataTable<AuditEntry>
        caption="Audit-Log"
        rows={entries}
        columns={columns}
        rowKey={(e) => e.id}
        loading={query.isLoading}
        server={{ page, pageSize: PAGE_SIZE, total, onPageChange: (p) => setOffset((p - 1) * PAGE_SIZE) }}
        search={{ placeholder: t('audit_filter_search'), value: filters.searchText, onChange: (q) => setFilter('searchText', q) }}
        onActivate={(e) => setExpandedId(expandedId === e.id ? null : e.id)}
        activeKey={expandedId}
        emptyText="Keine Einträge gefunden"
        filters={
          <>
            <input value={filters.action} onChange={e => setFilter('action', e.target.value)}
              className="input w-36" placeholder="Aktion…" aria-label="Aktion" />
            <input value={filters.targetType} onChange={e => setFilter('targetType', e.target.value)}
              className="input w-36" placeholder="Zieltyp…" aria-label="Zieltyp" />
            <select value={filters.success} onChange={e => setFilter('success', e.target.value)}
              className="input w-auto" aria-label="Status">
              <option value="">Alle</option>
              <option value="true">Erfolgreich</option>
              <option value="false">Fehlgeschlagen</option>
            </select>
          </>
        }
        toolbar={() => (
          <button onClick={() => { void query.refetch(); void stats.refetch(); }} className="btn-secondary flex items-center gap-1.5 text-xs">
            <RefreshCw size={13} className={query.isFetching ? 'animate-spin' : ''} aria-hidden="true" /> {t('tb_refresh')}
          </button>
        )}
        renderExpanded={(e) => expandedId === e.id ? (
          <div className="grid grid-cols-3 gap-2 text-xs">
            {e.targetId && <div><span className="text-fg-subtle">Ziel-ID: </span><span className="font-mono text-fg-muted">{e.targetId}</span></div>}
            {e.actorId && <div><span className="text-fg-subtle">Akteur-ID: </span><span className="font-mono text-fg-muted">{e.actorId}</span></div>}
            {e.userAgent && (
              <div className="col-span-3">
                <span className="text-fg-subtle">User-Agent: </span>
                <span className="font-mono text-fg-muted break-all">{e.userAgent}</span>
              </div>
            )}
            {e.errorMsg && <div className="col-span-3"><span className="text-danger-fg">Fehler: </span><span className="text-fg-muted">{e.errorMsg}</span></div>}
            {e.changes && Object.keys(e.changes).length > 0 && (
              <div className="col-span-3">
                <span className="text-fg-subtle">Änderungen: </span>
                <pre className="inline text-fg-muted text-xs">{JSON.stringify(e.changes, null, 2)}</pre>
              </div>
            )}
          </div>
        ) : null}
      />
    </div>
  );
}
