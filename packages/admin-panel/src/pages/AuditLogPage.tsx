import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ClipboardList, Download, FileText, Search,
  CheckCircle2, XCircle, Info, X, AlertTriangle,
  Activity, Users, BarChart3, Code2,
} from 'lucide-react';
import { api, exportUrl } from '../api/client.js';
import { useT } from '../i18n/useT.js';

// v3.18.34: AnomaliesResponse-Interface + Banner entfernt — rote Banner waren
// in der Praxis verwirrend (zeigten u.a. eigene Settings-Änderungen als
// „kritische Aktion"). Audit-Log selbst zeigt alle relevanten Aktionen.

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

/** Convert a YYYY-MM-DD value to ISO at start-of-day UTC. */
function dateFromIso(d: string): string {
  return new Date(d + 'T00:00:00.000Z').toISOString();
}
/** Convert a YYYY-MM-DD value to ISO at end-of-day UTC. */
function dateToIso(d: string): string {
  return new Date(d + 'T23:59:59.999Z').toISOString();
}

// v3.18.30: Human-readable Action-Labels. Audit-Middleware schreibt das Pattern
// `<resource>.<verb>` (z.B. `settings.put`, `mailboxes.delete`) — für Admins ist
// das aber wenig aussagekräftig. Diese Map übersetzt häufige Aktionen in
// menschenlesbare Beschreibungen + ordnet sie Farben zu.
type ActionMeta = { label: string; tone: 'create' | 'update' | 'delete' | 'auth' | 'critical' | 'read' };

const ACTION_MAP: Record<string, ActionMeta> = {
  // Settings (v3.18.34: jetzt mit Sub-Resource im Action-String)
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
  // OAuth
  'oauth.token_issued':           { label: 'OAuth-Token ausgestellt',        tone: 'auth' },
  'oauth.token_revoked':          { label: 'OAuth-Token widerrufen',         tone: 'delete' },
  'oauth.client.post':            { label: 'OAuth-Client angelegt',          tone: 'create' },
  'oauth.client.put':             { label: 'OAuth-Client geändert',          tone: 'update' },
  'oauth.client.delete':          { label: 'OAuth-Client gelöscht',          tone: 'delete' },
  // Backups (v3.18.34: erweiterte Action-Pfade)
  'backups.post':                 { label: 'Backup gestartet',               tone: 'create' },
  'backups.delete':               { label: 'Backup gelöscht',                tone: 'delete' },
  'backups.full.post':            { label: 'Vollbackup gestartet',           tone: 'create' },
  'backups.mailbox.post':         { label: 'Mailbox-Backup gestartet',       tone: 'create' },
  'backups.restore.post':         { label: 'MBOX-Import (Restore)',          tone: 'update' },
  'backups.jobs.delete':          { label: 'Backup-Job gelöscht',            tone: 'delete' },
  'backups.archive.delete':       { label: 'Backup-Archiv-Objekt gelöscht',  tone: 'delete' },
  'backups.schedules.post':       { label: 'Backup-Zeitplan angelegt',       tone: 'create' },
  'backups.schedules.put':        { label: 'Backup-Zeitplan geändert',       tone: 'update' },
  'backups.schedules.delete':     { label: 'Backup-Zeitplan gelöscht',       tone: 'delete' },
  'backups.schedules.run.post':   { label: 'Zeitplan manuell ausgeführt',    tone: 'create' },
  'backup.full.trigger':          { label: 'Vollbackup gestartet',           tone: 'create' },
  'backup.mailbox.trigger':       { label: 'Mailbox-Backup gestartet',       tone: 'create' },
  'backup.mbox.import':           { label: 'MBOX-Import (Restore)',          tone: 'update' },
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
  'journaling.rule_created':      { label: 'Journaling-Regel angelegt',      tone: 'create' },
  'retention.run':                { label: 'Aufbewahrung ausgeführt',        tone: 'update' },
  // Roles
  'user.role':                    { label: 'Rolle geändert',                 tone: 'critical' },
  'roles.put':                    { label: 'Rolle geändert',                 tone: 'critical' },
  // Gateway
  'gateway.settings_updated':     { label: 'SMTP-Gateway konfiguriert',      tone: 'update' },
  // v3.18.34: Audit-Log (sensitive GETs)
  'audit-log.export.get':         { label: 'Audit-Log exportiert',           tone: 'read' },
  'audit-log.anomalies.get':      { label: 'Anomalien-Report abgerufen',     tone: 'read' },
  // v3.18.37: Legacy-Action-Strings (vor v3.18.34 Path-Fix — Sub-Router-Mutation)
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
  'members.post':                 { label: 'Gruppenmitglied hinzugefügt',    tone: 'create' },
  'members.delete':               { label: 'Gruppenmitglied entfernt',       tone: 'delete' },
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
  // v3.18.34: Zertifikate
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
  // v3.18.34: Gruppen, Aliase, Postfächer (Untermenüs)
  'groups.post':                  { label: 'Verteilergruppe angelegt',       tone: 'create' },
  'groups.put':                   { label: 'Verteilergruppe geändert',       tone: 'update' },
  'groups.delete':                { label: 'Verteilergruppe gelöscht',       tone: 'delete' },
  'groups.members.post':          { label: 'Gruppenmitglied hinzugefügt',    tone: 'create' },
  'groups.members.delete':        { label: 'Gruppenmitglied entfernt',       tone: 'delete' },
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
  // v3.18.34: OAuth Clients (Sub-Routes)
  'oauth.clients.post':           { label: 'OAuth-Client angelegt',          tone: 'create' },
  'oauth.clients.put':            { label: 'OAuth-Client geändert',          tone: 'update' },
  'oauth.clients.delete':         { label: 'OAuth-Client gelöscht',          tone: 'delete' },
};

function actionMeta(action: string): ActionMeta {
  if (ACTION_MAP[action]) return ACTION_MAP[action];
  // Heuristik: Fallback nach Verb
  const verb = action.split('.').pop()?.toLowerCase() ?? '';
  if (verb === 'post' || verb === 'create')      return { label: action, tone: 'create' };
  if (verb === 'delete')                          return { label: action, tone: 'delete' };
  if (verb === 'put' || verb === 'patch' || verb === 'update') return { label: action, tone: 'update' };
  if (verb === 'get')                             return { label: action, tone: 'read' };
  return { label: action, tone: 'read' };
}

function ActionBadge({ action }: { action: string }) {
  const meta = actionMeta(action);
  const color = meta.tone === 'create'   ? 'bg-green-100 text-green-700'
              : meta.tone === 'delete'   ? 'bg-red-100 text-red-700'
              : meta.tone === 'update'   ? 'bg-blue-100 text-blue-700'
              : meta.tone === 'auth'     ? 'bg-purple-100 text-purple-700'
              : meta.tone === 'critical' ? 'bg-amber-100 text-amber-800 border border-amber-200'
              : 'bg-gray-100 text-gray-600';
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
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-gray-500 uppercase tracking-wide">{label}</span>
        <Icon size={16} className={accent} />
      </div>
      <div className="text-2xl font-semibold text-gray-900">{value}</div>
    </div>
  );
}

function TopList({
  title, icon: Icon, items, valueColor = 'bg-blue-500',
}: {
  title: string;
  icon: typeof Users;
  items: { label: string; count: number }[];
  valueColor?: string;
}) {
  const max = items.length > 0 ? items[0]!.count : 1;
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <div className="flex items-center gap-2 mb-3">
        <Icon size={16} className="text-gray-500" />
        <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-gray-400">—</p>
      ) : (
        <div className="space-y-1.5">
          {items.map((it) => (
            <div key={it.label} className="flex items-center gap-2 text-xs">
              <div className="w-44 truncate text-gray-700" title={it.label}>{it.label || '(unknown)'}</div>
              <div className="flex-1 bg-gray-100 rounded-full h-1.5 overflow-hidden">
                <div
                  className={`${valueColor} h-full`}
                  style={{ width: `${Math.max(2, (it.count / max) * 100)}%` }}
                />
              </div>
              <div className="w-10 text-right font-mono text-gray-600">{it.count}</div>
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
    if (filters.from)        p.set('from', dateFromIso(filters.from));
    if (filters.to)          p.set('to', dateToIso(filters.to));
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

  // v3.18.34: Anomalies-Query entfernt — Banner war zu noisy

  const handleExport = (format: 'csv' | 'pdf' | 'json') => {
    const params = buildParams();
    const url = exportUrl(`/admin/audit-log/export.${format}`, params);
    window.open(url, '_blank');
  };

  const dismissNotice = () => {
    setNoticeDismissed(true);
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* ignore */ }
  };

  const data = query.data;
  const entries = data?.entries ?? [];
  const total   = data?.total ?? 0;
  const pages   = Math.ceil(total / PAGE_SIZE);
  const page    = Math.floor(offset / PAGE_SIZE) + 1;

  const setFilter = (k: keyof typeof filters, v: string) => {
    setFilters(f => ({ ...f, [k]: v }));
    setOffset(0);
  };

  const hasAnyFilter =
    filters.action || filters.targetType || filters.from || filters.to ||
    filters.success || filters.actorEmail || filters.ipAddress || filters.searchText;

  const s = stats.data;

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <ClipboardList size={22} className="text-accent" />
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Audit-Log</h1>
            <p className="text-sm text-gray-500">Alle Admin-Aktionen protokolliert</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={() => handleExport('csv')}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-700 border border-gray-300 rounded hover:bg-gray-50">
            <Download size={14} /> {t('audit_export_csv')}
          </button>
          <button onClick={() => handleExport('pdf')}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-700 border border-gray-300 rounded hover:bg-gray-50"
            title="PDF — signiert mit SHA-256 (siehe X-CoreMail-Signature-Header)">
            <FileText size={14} /> PDF
          </button>
          <button onClick={() => handleExport('json')}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-700 border border-gray-300 rounded hover:bg-gray-50"
            title="JSON — signiert mit SHA-256, für SIEM-Integration (Splunk, Azure Sentinel, ELK)">
            <Code2 size={14} /> JSON
          </button>
        </div>
      </div>

      {/* v3.18.34: Anomalies-Banner komplett entfernt — Audit-Log selbst zeigt
          alle relevanten Aktionen, der Banner war in der Praxis verwirrend
          (eigene Settings-Änderungen wurden als „kritische Aktion" angezeigt). */}

      {/* Immutability notice + Signatur-Hinweis */}
      {!noticeDismissed && (
        <div className="mb-4 flex items-start gap-2 bg-blue-50 border border-blue-200 text-blue-900 rounded px-3 py-2 text-xs">
          <Info size={14} className="text-blue-500 shrink-0 mt-0.5" />
          <span className="flex-1">
            {t('audit_immutable_notice')}
            {' '}<strong>Exports sind kryptografisch signiert:</strong> Der HTTP-Response-Header
            <code className="mx-1 font-mono bg-white px-1 rounded">X-CoreMail-Signature: sha256=…</code>
            enthält den SHA-256-Hash über den Datei-Inhalt. Verifikation lokal mit
            <code className="ml-1 font-mono bg-white px-1 rounded">shasum -a 256 audit-log-YYYY-MM-DD.csv</code>.
          </span>
          <button onClick={dismissNotice} className="text-blue-500 hover:text-blue-700" aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Statistics dashboard */}
      {s && (
        <div className="mb-6 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <KpiCard icon={Activity}      label={t('audit_stat_total')}        value={s.totalEntries.toLocaleString('de-DE')} accent="text-gray-400" />
            <KpiCard icon={Activity}      label={t('audit_stat_24h')}          value={s.last24h.toLocaleString('de-DE')}      accent="text-blue-500" />
            <KpiCard icon={Activity}      label={t('audit_stat_7d')}           value={s.last7d.toLocaleString('de-DE')}       accent="text-indigo-500" />
            <KpiCard icon={AlertTriangle} label={t('audit_stat_failure_rate')} value={`${(s.failureRate * 100).toFixed(2)}%`} accent="text-red-500" />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <TopList
              title={t('audit_top_actors')}
              icon={Users}
              items={s.topActors.map(a => ({ label: a.actorEmail, count: a.count }))}
              valueColor="bg-blue-500"
            />
            <TopList
              title={t('audit_top_actions')}
              icon={BarChart3}
              items={s.topActions.map(a => ({ label: a.action, count: a.count }))}
              valueColor="bg-indigo-500"
            />
          </div>
        </div>
      )}

      {/* Filters — row 1 */}
      <div className="flex flex-wrap gap-2 mb-2">
        <div className="flex items-center gap-1.5 bg-white border border-gray-300 rounded px-3 py-1.5">
          <Search size={13} className="text-gray-400" />
          <input value={filters.searchText} onChange={e => setFilter('searchText', e.target.value)}
            className="w-56 text-sm focus:outline-none" placeholder={t('audit_filter_search')} />
        </div>
        <input value={filters.action} onChange={e => setFilter('action', e.target.value)}
          className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent w-36"
          placeholder="Aktion…" />
        <input value={filters.targetType} onChange={e => setFilter('targetType', e.target.value)}
          className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent w-36"
          placeholder="Zieltyp…" />
        <select value={filters.success} onChange={e => setFilter('success', e.target.value)}
          className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent">
          <option value="">Alle</option>
          <option value="true">Erfolgreich</option>
          <option value="false">Fehlgeschlagen</option>
        </select>
      </div>

      {/* Filters — row 2 */}
      <div className="flex flex-wrap gap-2 mb-4">
        <input value={filters.actorEmail} onChange={e => setFilter('actorEmail', e.target.value)}
          className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent w-56"
          placeholder={t('audit_filter_actor_email')} />
        <input value={filters.ipAddress} onChange={e => setFilter('ipAddress', e.target.value)}
          className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent w-44"
          placeholder={t('audit_filter_ip')} />
        <input type="date" value={filters.from} onChange={e => setFilter('from', e.target.value)}
          className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" />
        <input type="date" value={filters.to} onChange={e => setFilter('to', e.target.value)}
          className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-accent" />
        {hasAnyFilter && (
          <button
            onClick={() => {
              setFilters({
                action: '', targetType: '', from: '', to: '', success: '',
                actorEmail: '', ipAddress: '', searchText: '',
              });
              setOffset(0);
            }}
            className="px-3 py-1.5 text-xs text-gray-500 border border-gray-200 rounded hover:bg-gray-50">
            Filter zurücksetzen
          </button>
        )}
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide">
              <th className="text-left px-4 py-3">Zeitpunkt</th>
              <th className="text-left px-4 py-3">Akteur</th>
              <th className="text-left px-4 py-3">Aktion</th>
              <th className="text-left px-4 py-3">Ziel</th>
              <th className="text-left px-4 py-3">IP</th>
              <th className="text-center px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {query.isLoading ? (
              <tr><td colSpan={6} className="text-center py-12 text-gray-400">Laden…</td></tr>
            ) : entries.length === 0 ? (
              <tr><td colSpan={6} className="text-center py-12 text-gray-400">Keine Einträge gefunden</td></tr>
            ) : entries.map(e => (
              <React.Fragment key={e.id}>
                <tr
                  className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer"
                  onClick={() => setExpandedId(expandedId === e.id ? null : e.id)}>
                  <td className="px-4 py-2.5 text-xs text-gray-600 whitespace-nowrap">{fmtDt(e.timestamp)}</td>
                  <td className="px-4 py-2.5">
                    {/* v3.18.37: Fallback wenn actorEmail leer ist (z.B. Cron-Jobs, System-Aktionen) */}
                    <p className="text-gray-900 text-xs font-medium">
                      {e.actorEmail || (e.actorId ? <span className="text-gray-400 italic">System ({e.actorId.slice(0, 8)}…)</span> : <span className="text-gray-400 italic">System</span>)}
                    </p>
                  </td>
                  <td className="px-4 py-2.5"><ActionBadge action={e.action} /></td>
                  <td className="px-4 py-2.5 text-xs text-gray-600">
                    <span className="text-gray-400">{e.targetType}</span>
                    {e.targetName && <span className="ml-1 text-gray-700">{e.targetName}</span>}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-gray-500 font-mono">{e.ipAddress ?? '—'}</td>
                  <td className="px-4 py-2.5 text-center">
                    {e.success
                      ? <CheckCircle2 size={15} className="text-green-500 mx-auto" />
                      : <XCircle size={15} className="text-red-500 mx-auto" />}
                  </td>
                </tr>
                {expandedId === e.id && (
                  <tr>
                    <td colSpan={6} className="p-0">
                      <div className="bg-gray-50 border-t border-gray-100 px-8 py-3">
                        <div className="grid grid-cols-3 gap-2 text-xs">
                          {e.targetId && <div><span className="text-gray-500">Ziel-ID: </span><span className="font-mono text-gray-700">{e.targetId}</span></div>}
                          {e.actorId && <div><span className="text-gray-500">Akteur-ID: </span><span className="font-mono text-gray-700">{e.actorId}</span></div>}
                          {e.userAgent && (
                            <div className="col-span-3">
                              <span className="text-gray-500">User-Agent: </span>
                              <span className="font-mono text-gray-700 break-all">{e.userAgent}</span>
                            </div>
                          )}
                          {e.errorMsg && <div className="col-span-3"><span className="text-red-500">Fehler: </span><span className="text-gray-700">{e.errorMsg}</span></div>}
                          {e.changes && Object.keys(e.changes).length > 0 && (
                            <div className="col-span-3">
                              <span className="text-gray-500">Änderungen: </span>
                              <pre className="inline text-gray-700 text-xs">{JSON.stringify(e.changes, null, 2)}</pre>
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>

        {/* Pagination */}
        {total > PAGE_SIZE && (
          <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between text-xs text-gray-500">
            <span>{total.toLocaleString('de-DE')} Einträge · Seite {page} / {pages}</span>
            <div className="flex gap-1">
              <button onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0}
                className="px-3 py-1 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-40">← Zurück</button>
              <button onClick={() => setOffset(offset + PAGE_SIZE)} disabled={offset + PAGE_SIZE >= total}
                className="px-3 py-1 border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-40">Weiter →</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
