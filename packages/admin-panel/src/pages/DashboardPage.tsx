import { useQuery } from '@tanstack/react-query';
import {
  Users, Globe, Mail, HardDrive, Activity,
  AlertTriangle, CheckCircle, Clock, TrendingUp,
  Inbox, RefreshCw, XCircle, Layers,
  ShieldCheck, UserPlus,
} from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell,
} from 'recharts';
import { api } from '../api/client.js';

// ── Typen ─────────────────────────────────────────────────────────────────────
interface DashboardData {
  users:   { total: number; active: number; inactive: number; newWeek: number };
  domains: { total: number; list: { id: string; name: string; active: boolean; userCount: number }[] };
  messages: { total: number; newDay: number; newWeek: number; mailsChart: { day: string; count: number }[] };
  storage:  {
    totalUsedBytes: number;
    topUsers: { id: string; email: string; displayName: string; domainName: string; usedBytes: number; quotaBytes: number; usedPercent: number }[];
  };
  groups:         number;
  sharedMailboxes: number;
  queues:  { waiting: number; active: number; failed: number; delayed: number; completed: number };
  recentErrors: { id: string; timestamp: string; level: string; service: string; message: string }[];
  recentAuditEvents: { id: string; timestamp: string; actorEmail: string; action: string; targetType: string; targetName: string; success: boolean }[];
  generatedAt: string;
}

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────
function fmtBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024)             return `${bytes} B`;
  if (bytes < 1024 * 1024)      return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3)        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtNum(n: number): string {
  return n.toLocaleString('de-DE');
}

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60)    return `vor ${diff}s`;
  if (diff < 3600)  return `vor ${Math.floor(diff / 60)}min`;
  if (diff < 86400) return `vor ${Math.floor(diff / 3600)}h`;
  return `vor ${Math.floor(diff / 86400)}d`;
}

function barColor(pct: number): string {
  if (pct >= 90) return 'bg-red-500';
  if (pct >= 75) return 'bg-yellow-400';
  return 'bg-green-500';
}

// ── KPI-Karte ─────────────────────────────────────────────────────────────────
function KpiCard({
  label, value, sub, icon: Icon, color, trend,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ElementType;
  color: string;
  trend?: { value: number; label: string };
}) {
  return (
    <div className="card flex flex-col gap-3">
      <div className="flex items-start justify-between">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${color}`}>
          <Icon size={18} className="text-white" />
        </div>
        {trend && (
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${trend.value >= 0 ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-600'}`}>
            {trend.value >= 0 ? '↑' : '↓'} {Math.abs(trend.value)} {trend.label}
          </span>
        )}
      </div>
      <div>
        <p className="text-2xl font-bold text-gray-900 tabular-nums">{typeof value === 'number' ? fmtNum(value) : value}</p>
        <p className="text-xs font-medium text-gray-500 mt-0.5">{label}</p>
        {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

// ── Abschnitt-Titel ───────────────────────────────────────────────────────────
function SectionTitle({ icon: Icon, title }: { icon: React.ElementType; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon size={15} className="text-gray-400" />
      <h2 className="text-sm font-semibold text-gray-700">{title}</h2>
    </div>
  );
}

// ── Queue-Badge ───────────────────────────────────────────────────────────────
function QueueBadge({ label, value, variant }: { label: string; value: number; variant: 'default' | 'warn' | 'error' | 'success' }) {
  const colors: Record<string, string> = {
    default: 'bg-blue-50 border-blue-100 text-blue-700',
    warn:    'bg-yellow-50 border-yellow-100 text-yellow-700',
    error:   'bg-red-50 border-red-100 text-red-700',
    success: 'bg-green-50 border-green-100 text-green-700',
  };
  return (
    <div className={`flex flex-col items-center justify-center border rounded-xl p-4 ${colors[variant]}`}>
      <p className="text-2xl font-bold tabular-nums">{fmtNum(value)}</p>
      <p className="text-xs mt-1 font-medium opacity-80">{label}</p>
    </div>
  );
}

// ── Tooltip (Recharts) ─────────────────────────────────────────────────────────
function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: { value: number }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-md px-3 py-2 text-xs">
      <p className="text-gray-500">{label}</p>
      <p className="font-semibold text-gray-900">{fmtNum(payload[0]?.value ?? 0)} Mails</p>
    </div>
  );
}

// ── Hauptkomponente ───────────────────────────────────────────────────────────
export function DashboardPage() {
  const { data, isLoading, refetch, dataUpdatedAt } = useQuery({
    queryKey: ['admin-dashboard'],
    queryFn:  () => api.get<DashboardData>('/admin/dashboard'),
    refetchInterval: 30_000, // alle 30 Sekunden automatisch aktualisieren
  });

  const lastUpdate = dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString('de-DE') : '—';

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex items-center gap-2 text-gray-400">
          <RefreshCw size={16} className="animate-spin" />
          <span className="text-sm">Dashboard wird geladen…</span>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const { users, domains, messages, storage, queues, recentErrors, recentAuditEvents } = data;
  const totalQueueItems = queues.waiting + queues.active + queues.delayed;
  const hasQueueProblem = queues.failed > 0;

  return (
    <div className="p-6 space-y-6 max-w-[1400px]">

      {/* ── Kopfzeile ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Systemübersicht</h1>
          <p className="text-xs text-gray-400 mt-0.5">Letzte Aktualisierung: {lastUpdate} · Auto-Refresh alle 30s</p>
        </div>
        <button
          onClick={() => void refetch()}
          className="btn-secondary text-xs"
          title="Jetzt aktualisieren"
        >
          <RefreshCw size={13} />
          Aktualisieren
        </button>
      </div>

      {/* ── KPI-Karten (Zeile 1) ─────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          icon={Users}  color="bg-blue-500"
          label="Benutzer gesamt"
          value={users.total}
          sub={`${users.active} aktiv · ${users.inactive} deaktiviert`}
          trend={{ value: users.newWeek, label: 'diese Woche neu' }}
        />
        <KpiCard
          icon={Globe} color="bg-indigo-500"
          label="Domains"
          value={domains.total}
          sub={`${data.sharedMailboxes} geteilte Postfächer · ${data.groups} Gruppen`}
        />
        <KpiCard
          icon={Mail}  color="bg-sky-500"
          label="E-Mails gesamt"
          value={messages.total}
          sub={`${fmtNum(messages.newDay)} heute · ${fmtNum(messages.newWeek)} diese Woche`}
          trend={{ value: messages.newDay, label: 'heute' }}
        />
        <KpiCard
          icon={HardDrive} color="bg-violet-500"
          label="Gesamt-Speicher"
          value={fmtBytes(storage.totalUsedBytes)}
          sub={`Top-Nutzer: ${storage.topUsers[0]?.displayName ?? '—'} (${fmtBytes(storage.topUsers[0]?.usedBytes ?? 0)})`}
        />
      </div>

      {/* ── Queue-Status + Nachrichten-Chart ─────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

        {/* Queue-Status */}
        <div className="card">
          <SectionTitle icon={Layers} title="SMTP-Queue-Status" />
          <div className="grid grid-cols-2 gap-3">
            <QueueBadge label="Wartend" value={queues.waiting}
              variant={queues.waiting > 100 ? 'warn' : 'default'} />
            <QueueBadge label="Aktiv" value={queues.active}
              variant={queues.active > 0 ? 'success' : 'default'} />
            <QueueBadge label="Fehlerhaft" value={queues.failed}
              variant={queues.failed > 0 ? 'error' : 'success'} />
            <QueueBadge label="Verzögert" value={queues.delayed}
              variant={queues.delayed > 0 ? 'warn' : 'default'} />
          </div>
          <div className={`mt-3 flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium ${
            hasQueueProblem
              ? 'bg-red-50 text-red-700'
              : totalQueueItems > 200
              ? 'bg-yellow-50 text-yellow-700'
              : 'bg-green-50 text-green-700'
          }`}>
            {hasQueueProblem
              ? <><XCircle size={13} /> {queues.failed} fehlerhafte Jobs — Überprüfung empfohlen</>
              : totalQueueItems > 200
              ? <><AlertTriangle size={13} /> Hohe Queue-Last ({totalQueueItems} Jobs)</>
              : <><CheckCircle size={13} /> Alle Queues im Normalbetrieb</>
            }
          </div>
        </div>

        {/* Mail-Aktivitäts-Chart */}
        <div className="card lg:col-span-2">
          <SectionTitle icon={TrendingUp} title="E-Mail-Aktivität (letzte 7 Tage)" />
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart data={messages.mailsChart} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="mailGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#3b82f6" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}   />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="day" tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} allowDecimals={false} />
              <Tooltip content={<ChartTooltip />} />
              <Area
                type="monotone" dataKey="count"
                stroke="#3b82f6" strokeWidth={2}
                fill="url(#mailGrad)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── Speicher-Ranking + Domain-Übersicht ──────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Top-10 Speichernutzer */}
        <div className="card">
          <SectionTitle icon={HardDrive} title="Speicher-Ranking (Top 10)" />
          <div className="space-y-3">
            {storage.topUsers.length === 0 && (
              <p className="text-xs text-gray-400 text-center py-4">Keine Daten</p>
            )}
            {storage.topUsers.map((u, i) => (
              <div key={u.id}>
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs text-gray-400 w-4 shrink-0">#{i + 1}</span>
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-gray-800 truncate">{u.displayName}</p>
                      <p className="text-[11px] text-gray-400 truncate">{u.email}</p>
                    </div>
                  </div>
                  <div className="text-right shrink-0 ml-2">
                    <p className="text-xs font-semibold text-gray-700">{fmtBytes(u.usedBytes)}</p>
                    <p className="text-[11px] text-gray-400">{u.usedPercent}%</p>
                  </div>
                </div>
                <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${barColor(u.usedPercent)}`}
                    style={{ width: `${Math.min(u.usedPercent, 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Domain-Übersicht */}
        <div className="card">
          <SectionTitle icon={Globe} title="Domains & Benutzerverteilung" />
          {domains.list.length === 0 ? (
            <p className="text-xs text-gray-400 text-center py-4">Keine Domains konfiguriert</p>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={120}>
                <BarChart data={domains.list} margin={{ top: 4, right: 8, left: -20, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: '#9ca3af' }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip
                    formatter={(v: number) => [`${v} Benutzer`, '']}
                    contentStyle={{ fontSize: 12, borderRadius: 8 }}
                  />
                  <Bar dataKey="userCount" radius={[4, 4, 0, 0]} maxBarSize={40}>
                    {domains.list.map((d, i) => (
                      <Cell key={d.id} fill={['#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#ec4899'][i % 5]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <div className="mt-3 divide-y divide-gray-50">
                {domains.list.map((d) => (
                  <div key={d.id} className="flex items-center justify-between py-1.5">
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${d.active ? 'bg-green-400' : 'bg-gray-300'}`} />
                      <span className="text-xs font-mono text-gray-700">{d.name}</span>
                    </div>
                    <span className="text-xs text-gray-500">{d.userCount} Benutzer</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Fehler-Log + Audit-Trail ─────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Letzte Fehler */}
        <div className="card">
          <SectionTitle icon={AlertTriangle} title="Letzte Fehler & Warnungen (30 Tage)" />
          {recentErrors.length === 0 ? (
            <div className="flex items-center gap-2 py-6 justify-center text-green-600">
              <CheckCircle size={16} />
              <span className="text-sm">Keine Fehler in den letzten 30 Tagen</span>
            </div>
          ) : (
            <div className="space-y-2">
              {recentErrors.map((e) => (
                <div key={e.id} className="flex items-start gap-2.5 p-2 rounded-lg bg-gray-50 hover:bg-gray-100 transition-colors">
                  <span className={`shrink-0 mt-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded uppercase ${
                    e.level === 'ERROR' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'
                  }`}>
                    {e.level}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-gray-700 truncate">{e.message}</p>
                    <p className="text-[11px] text-gray-400 mt-0.5">
                      <span className="font-mono">{e.service}</span> · {timeAgo(e.timestamp)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Audit-Trail */}
        <div className="card">
          <SectionTitle icon={ShieldCheck} title="Letzte Admin-Aktionen" />
          {recentAuditEvents.length === 0 ? (
            <p className="text-xs text-gray-400 text-center py-6">Noch keine Aktionen protokolliert</p>
          ) : (
            <div className="divide-y divide-gray-50">
              {recentAuditEvents.map((e) => (
                <div key={e.id} className="flex items-start gap-2.5 py-2.5">
                  <div className={`shrink-0 mt-0.5 w-5 h-5 rounded-full flex items-center justify-center ${
                    e.success ? 'bg-green-100' : 'bg-red-100'
                  }`}>
                    {e.success
                      ? <CheckCircle size={11} className="text-green-600" />
                      : <XCircle    size={11} className="text-red-600"   />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-gray-700">
                      <span className="font-medium">{e.actorEmail}</span>
                      <span className="text-gray-400"> · </span>
                      <span className="font-mono text-gray-600">{e.action}</span>
                      {e.targetName && (
                        <span className="text-gray-400"> → {e.targetName}</span>
                      )}
                    </p>
                    <p className="text-[11px] text-gray-400 mt-0.5">{e.targetType} · {timeAgo(e.timestamp)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── System-Info-Leiste ────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="card flex items-center gap-3 py-3">
          <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
            <Inbox size={14} className="text-blue-600" />
          </div>
          <div>
            <p className="text-xs text-gray-500">Queue-Einträge</p>
            <p className="text-base font-bold text-gray-900">{fmtNum(totalQueueItems)}</p>
          </div>
        </div>
        <div className="card flex items-center gap-3 py-3">
          <div className="w-8 h-8 rounded-lg bg-green-50 flex items-center justify-center shrink-0">
            <Activity size={14} className="text-green-600" />
          </div>
          <div>
            <p className="text-xs text-gray-500">Geliefert (kumuliert)</p>
            <p className="text-base font-bold text-gray-900">{fmtNum(queues.completed)}</p>
          </div>
        </div>
        <div className="card flex items-center gap-3 py-3">
          <div className="w-8 h-8 rounded-lg bg-purple-50 flex items-center justify-center shrink-0">
            <UserPlus size={14} className="text-purple-600" />
          </div>
          <div>
            <p className="text-xs text-gray-500">Neue Benutzer (7 Tage)</p>
            <p className="text-base font-bold text-gray-900">{fmtNum(users.newWeek)}</p>
          </div>
        </div>
        <div className="card flex items-center gap-3 py-3">
          <div className="w-8 h-8 rounded-lg bg-orange-50 flex items-center justify-center shrink-0">
            <Clock size={14} className="text-orange-600" />
          </div>
          <div>
            <p className="text-xs text-gray-500">Mails heute eingegangen</p>
            <p className="text-base font-bold text-gray-900">{fmtNum(messages.newDay)}</p>
          </div>
        </div>
      </div>

    </div>
  );
}
