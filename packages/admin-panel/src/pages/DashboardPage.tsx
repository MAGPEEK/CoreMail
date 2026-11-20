import { useState, useRef, useEffect, type ReactElement } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Users, Globe, Mail, HardDrive, Activity,
  AlertTriangle, CheckCircle, Clock, TrendingUp,
  Inbox, RefreshCw, XCircle, Layers,
  ShieldCheck, UserPlus, Settings, Server, Cpu,
  MemoryStick, LogIn, ShieldAlert, GripVertical, Siren,
} from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { api, fetchEventTicket } from '../api/client.js';
import { openReconnectingEventSource, eventStreamUrl } from '../lib/reconnectingEventSource.js';
import { useDashboardStore, WIDGET_CATALOG, type WidgetId } from '../store/dashboard.js';
import { useT } from '../i18n/useT.js';
import { ServedCertWarning } from '../components/ServedCert.js';
import { CertificateSetupCard } from '../components/CertificateSetupCard.js';
import { protocolLabel } from '../lib/attackProtection.js';

// ── Types ─────────────────────────────────────────────────────────────────────
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
  server: {
    version: string; hostname: string; platform: string; arch: string;
    nodeVersion: string; pid: number; uptimeSeconds: number; startedAt: string;
    memory: { heapUsed: number; heapTotal: number; heapLimit?: number; rss: number; systemTotal: number; systemFree: number };
    cpu:    { cores: number; model: string; load1: number; load5: number; load15: number };
  };
  activeSessions: number;
  recentLogins:   { id: string; timestamp: string; actorEmail: string; ipAddress: string | null; userAgent: string }[];
  securityHits24h: number;
  /** Widgets whose data belongs to another area (absent on older backends → all shown). */
  sections?: { errors: boolean; storageUsers: boolean; audit: boolean; logins: boolean; attacks: boolean };
  generatedAt: string;
}

interface AttackSummary {
  total24h:    number;
  total1h:     number;
  byType:      { type: string; count: number }[];
  topIps:      { ip: string;   count: number }[];
  /** 10.5: events per protocol (all login front doors). */
  byProtocol?: { protocol: string; count: number }[];
  latestEvents: {
    id: string; timestamp: string; type: string;
    ip: string; target: string | null; service: string;
    protocol?: string | null;
    detail: Record<string, unknown>;
  }[];
  isUnderAttack: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
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

function fmtUptime(sec: number): { primary: string; secondary: string } {
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  if (days > 0) return { primary: `${days} ${days === 1 ? 'Tag' : 'Tage'}`, secondary: `${hours} h ${mins} min` };
  if (hours > 0) return { primary: `${hours} h`, secondary: `${mins} min` };
  return { primary: `${mins} min`, secondary: `${sec % 60} s` };
}

// Status fills use the *-fg tokens: they keep >= 3:1 against the track in both themes.
function barColor(pct: number): string {
  if (pct >= 90) return 'bg-danger-fg';
  if (pct >= 75) return 'bg-warning-fg';
  return 'bg-success-fg';
}

// ── Chart colours from the theme tokens ───────────────────────────────────────
// Recharts writes colours into SVG attributes, where var() is not reliable, so the
// tokens are resolved from :root and re-read whenever the theme class or the
// runtime accent colour (inline style on <html>) changes.
interface ChartTheme { grid: string; axis: string; series: string; surface: string; border: string; fg: string; hover: string }

function readChartTheme(): ChartTheme {
  const cs = getComputedStyle(document.documentElement);
  const tok = (name: string, fallback: string) => {
    const v = cs.getPropertyValue(`--${name}`).trim();
    return `rgb(${v || fallback})`;
  };
  return {
    grid:    tok('line', '226 229 233'),
    axis:    tok('fg-subtle', '93 100 112'),
    series:  tok('color-accent-fg', '0 95 184'),
    surface: tok('surface', '255 255 255'),
    border:  tok('line-strong', '122 129 141'),
    fg:      tok('fg', '17 24 39'),
    hover:   tok('surface-2', '246 247 249'),
  };
}

function useChartTheme(): ChartTheme {
  const [theme, setTheme] = useState<ChartTheme>(readChartTheme);
  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(readChartTheme()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    return () => obs.disconnect();
  }, []);
  return theme;
}

// ── KPI card ──────────────────────────────────────────────────────────────────
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
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${trend.value >= 0 ? 'bg-success-bg text-success-fg' : 'bg-danger-bg text-danger-fg'}`}>
            {trend.value >= 0 ? '↑' : '↓'} {Math.abs(trend.value)} {trend.label}
          </span>
        )}
      </div>
      <div>
        <p className="text-2xl font-bold text-fg tabular-nums">{typeof value === 'number' ? fmtNum(value) : value}</p>
        <p className="text-xs font-medium text-fg-subtle mt-0.5">{label}</p>
        {sub && <p className="text-xs text-fg-subtle mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

// ── Section title ─────────────────────────────────────────────────────────────
function SectionTitle({ icon: Icon, title }: { icon: React.ElementType; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon size={15} className="text-fg-subtle" />
      <h2 className="text-sm font-semibold text-fg-muted">{title}</h2>
    </div>
  );
}

// ── Queue-Badge ───────────────────────────────────────────────────────────────
function QueueBadge({ label, value, variant }: { label: string; value: number; variant: 'default' | 'warn' | 'error' | 'success' }) {
  const colors: Record<string, string> = {
    default: 'bg-info-bg border-info-line text-info-fg',
    warn:    'bg-warning-bg border-warning-line text-warning-fg',
    error:   'bg-danger-bg border-danger-line text-danger-fg',
    success: 'bg-success-bg border-success-line text-success-fg',
  };
  return (
    <div className={`flex flex-col items-center justify-center border rounded-xl p-4 ${colors[variant]}`}>
      <p className="text-2xl font-bold tabular-nums">{fmtNum(value)}</p>
      <p className="text-xs mt-1 font-medium">{label}</p>
    </div>
  );
}

// ── Tooltip (Recharts) ─────────────────────────────────────────────────────────
function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: { value: number }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-surface border border-line rounded-lg shadow-md px-3 py-2 text-xs">
      <p className="text-fg-subtle">{label}</p>
      <p className="font-semibold text-fg">{fmtNum(payload[0]?.value ?? 0)} Mails</p>
    </div>
  );
}

// ── Mini bar (for RAM/CPU display) ────────────────────────────────────────────
function MiniBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="h-1.5 bg-surface-2 rounded-full overflow-hidden">
      <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${Math.min(pct, 100)}%` }} />
    </div>
  );
}

// ── Settings popover with drag reorder ───────────────────────────────────────
// Native HTML5 drag-and-drop — no @dnd-kit needed because the interaction is
// limited to a simple vertical list. The position within the global
// `order` list determines the order in the dashboard (sorted per group).
function WidgetSettingsPopover({ onClose }: { onClose: () => void }) {
  const t = useT();
  const visible    = useDashboardStore((s) => s.visible);
  const order      = useDashboardStore((s) => s.order);
  const toggle     = useDashboardStore((s) => s.toggle);
  const setAll     = useDashboardStore((s) => s.setAll);
  const reset      = useDashboardStore((s) => s.resetDefaults);
  const moveWidget = useDashboardStore((s) => s.moveWidget);
  const ref = useRef<HTMLDivElement | null>(null);
  const dragIndex = useRef<number | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [onClose]);

  const catalogById = new Map(WIDGET_CATALOG.map((w) => [w.id, w]));
  const orderedItems = order
    .map((id) => catalogById.get(id))
    .filter((w): w is (typeof WIDGET_CATALOG)[number] => w !== undefined);

  const GROUP_LABELS: Record<(typeof WIDGET_CATALOG)[number]['group'], string> = {
    kpi: t('dash_widget_group_kpi'), charts: t('dash_widget_group_charts'), lists: t('dash_widget_group_lists'), server: t('dash_widget_group_server'),
  };

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-2 w-96 bg-surface rounded-lg border border-line shadow-xl z-20"
    >
      <div className="px-4 py-3 border-b border-line flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-fg">{t('dash_widget_settings')}</h3>
          <p className="text-[11px] text-fg-subtle mt-0.5">{t('dash_widget_drag_hint')}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button onClick={() => setAll(true)}  className="text-[11px] px-2 py-0.5 rounded border border-line-strong text-fg-muted hover:bg-surface-2">{t('dash_widget_all')}</button>
          <button onClick={() => setAll(false)} className="text-[11px] px-2 py-0.5 rounded border border-line-strong text-fg-muted hover:bg-surface-2">{t('dash_widget_none')}</button>
          <button onClick={reset}               className="text-[11px] px-2 py-0.5 rounded border border-line-strong text-fg-muted hover:bg-surface-2">{t('dash_widget_reset')}</button>
        </div>
      </div>
      <div className="max-h-[60vh] overflow-y-auto py-1">
        {orderedItems.map((w, i) => (
          <div
            key={w.id}
            draggable
            onDragStart={(e) => {
              dragIndex.current = i;
              setDraggingIndex(i);
              // Firefox: without setData the drag is aborted immediately
              e.dataTransfer.setData('text/plain', w.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragEnter={(e) => { e.preventDefault(); if (dragIndex.current !== null) setHoverIndex(i); }}
            onDragOver={(e) => {
              if (dragIndex.current === null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
            }}
            onDragLeave={(e) => {
              // Only clear when the cursor really leaves the entire row
              if (e.currentTarget.contains(e.relatedTarget as Node)) return;
              setHoverIndex((h) => (h === i ? null : h));
            }}
            onDrop={(e) => {
              e.preventDefault();
              const from = dragIndex.current;
              if (from !== null && from !== i) moveWidget(from, i);
              dragIndex.current = null;
              setHoverIndex(null);
              setDraggingIndex(null);
            }}
            onDragEnd={() => { dragIndex.current = null; setHoverIndex(null); setDraggingIndex(null); }}
            className={`flex items-center gap-2 px-3 py-1.5 hover:bg-surface-2 cursor-move transition-opacity ${
              hoverIndex === i ? 'border-t-2 border-accent-fg' : 'border-t-2 border-transparent'
            } ${draggingIndex === i ? 'opacity-40' : ''}`}
          >
            <GripVertical size={13} className="text-fg-subtle shrink-0" />
            <input
              type="checkbox"
              checked={visible[w.id] ?? true}
              onChange={() => toggle(w.id)}
              onClick={(e) => e.stopPropagation()}
              draggable={false}
              className="h-4 w-4 rounded border-line-strong text-accent-fg focus:ring-accent-fg shrink-0"
            />
            <span className="text-sm text-fg-muted flex-1 truncate">{w.label}</span>
            <span className="text-[10px] text-fg-subtle uppercase tracking-wide shrink-0">{GROUP_LABELS[w.group]}</span>
          </div>
        ))}
        {/* End-of-list drop zone — allows "drag to the end" */}
        <div
          onDragEnter={(e) => { e.preventDefault(); if (dragIndex.current !== null) setHoverIndex(orderedItems.length); }}
          onDragOver={(e) => {
            if (dragIndex.current === null) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
          }}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node)) return;
            setHoverIndex((h) => (h === orderedItems.length ? null : h));
          }}
          onDrop={(e) => {
            e.preventDefault();
            const from = dragIndex.current;
            if (from !== null) moveWidget(from, orderedItems.length);
            dragIndex.current = null;
            setHoverIndex(null);
            setDraggingIndex(null);
          }}
          className={`h-3 ${hoverIndex === orderedItems.length ? 'border-t-2 border-accent-fg' : 'border-t-2 border-transparent'}`}
        />
      </div>
    </div>
  );
}

// ── Reorder helper for the dashboard sections ────────────────────────────────
// Sorts a list of widget IDs by their position in the user's `order`.
// Unknown IDs (not in the order list) end up at the end in their original order.
function sortByOrder(ids: WidgetId[], order: WidgetId[]): WidgetId[] {
  const idx = new Map(order.map((id, i) => [id, i] as const));
  return [...ids].sort((a, b) => (idx.get(a) ?? 9999) - (idx.get(b) ?? 9999));
}

// ── DraggableCard ───────────────────────────────────────────────────────────
// IMPORTANT: must be defined at module level. Inline in DashboardPage causes
// every re-render to create a new function reference → React remounts
// the cards on the first setState call → the running drag is aborted.
//
// `select-none` prevents text selection on mousedown on text inside the card
// (otherwise Chrome/Firefox starts text selection instead of a drag).
interface DraggableCardProps {
  id:            WidgetId;
  children:      React.ReactNode;
  cardDrag:      WidgetId | null;
  cardHover:     WidgetId | null;
  setCardDrag:   (id: WidgetId | null) => void;
  setCardHover:  (id: WidgetId | null) => void;
  order:         WidgetId[];
  moveWidget:    (from: number, to: number) => void;
}

function DraggableCard({
  id, children, cardDrag, cardHover, setCardDrag, setCardHover, order, moveWidget,
}: DraggableCardProps): ReactElement {
  const myGroup     = WIDGET_CATALOG.find((w) => w.id === id)?.group;
  const sourceGroup = cardDrag ? WIDGET_CATALOG.find((w) => w.id === cardDrag)?.group : null;
  const sameGroup   = sourceGroup === myGroup;

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', id);
        e.dataTransfer.effectAllowed = 'move';
        setCardDrag(id);
      }}
      onDragEnter={(e) => {
        if (!cardDrag || cardDrag === id) return;
        e.preventDefault();
        setCardHover(id);
      }}
      onDragOver={(e) => {
        if (!cardDrag || cardDrag === id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        if (cardHover === id) setCardHover(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (!cardDrag || cardDrag === id) {
          setCardDrag(null); setCardHover(null);
          return;
        }
        const fromIdx = order.indexOf(cardDrag);
        const toIdx   = order.indexOf(id);
        if (fromIdx >= 0 && toIdx >= 0) moveWidget(fromIdx, toIdx);
        setCardDrag(null);
        setCardHover(null);
      }}
      onDragEnd={() => { setCardDrag(null); setCardHover(null); }}
      className={`cursor-move select-none transition-all relative rounded-xl ${
        cardDrag === id ? 'opacity-40 scale-[0.98]' : ''
      } ${
        cardHover === id && sameGroup ? 'ring-2 ring-accent-fg ring-offset-2' : ''
      }`}
      title=""
    >
      {children}
    </div>
  );
}

// ── Attack detection widget ───────────────────────────────────────────────────
// Polls /admin/security/attacks/summary every 30s and listens for SSE events
// of type `security:attack` for real-time updates.
function AttackEventsWidget() {
  const t = useT();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['attack-summary'],
    queryFn:  () => api.get<AttackSummary>('/admin/security/attacks/summary'),
    refetchInterval: 30_000,
  });

  // SSE subscription for live updates
  useEffect(() => openReconnectingEventSource({
    // v8.1: a fresh single-use ticket on every (re)connect — no token in the URL
    url: async () => {
      const ticket = await fetchEventTicket();
      return ticket ? eventStreamUrl(ticket) : null;
    },
    handlers: {
      'security:attack': () => {
        // Invalidating is enough — the query fetches the new data
        void queryClient.invalidateQueries({ queryKey: ['attack-summary'] });
      },
    },
  }), [queryClient]);

  const typeLabel: Record<string, string> = {
    AUTH_BRUTE_FORCE: 'Brute-Force',
    IP_RATE_LIMIT:    'IP-Rate-Limit',
    OPEN_RELAY:       'Open-Relay',
    SPAM:             'Spam',
    // 10.5 attack protection (all protocols)
    AUTH_LOCKOUT:     'Sperre',
    AUTH_LOCKED:      'Gesperrt abgewiesen',
    IP_BLOCKLIST:     'Sperrliste',
    IP_AUTO_BLOCKED:  'Auto-Sperrliste',
  };

  if (isLoading || !data) {
    return (
      <div className="card">
        <SectionTitle icon={Siren} title={t('dash_attack_title')} />
        <p className="text-xs text-fg-subtle text-center py-4">{t('dash_attack_loading')}</p>
      </div>
    );
  }

  return (
    <div className={`card border-2 transition-colors ${data.isUnderAttack ? 'border-danger-line bg-danger-bg' : 'border-transparent'}`}>
      <div className="flex items-center justify-between mb-3">
        <SectionTitle icon={Siren} title={t('dash_attack_title')} />
        {data.isUnderAttack && (
          <span className="flex items-center gap-1.5 text-xs font-bold text-danger-fg bg-danger-bg px-2.5 py-1 rounded-full animate-pulse">
            <AlertTriangle size={12} />
            {t('dash_attack_under')}
          </span>
        )}
      </div>

      {/* Counters */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className={`rounded-lg p-3 text-center ${data.total1h > 0 ? 'bg-danger-bg border border-danger-line' : 'bg-surface-2'}`}>
          <p className={`text-2xl font-bold tabular-nums ${data.total1h > 0 ? 'text-danger-fg' : 'text-fg-muted'}`}>{data.total1h}</p>
          <p className="text-[11px] text-fg-subtle mt-0.5">{t('dash_attack_last_hour')}</p>
        </div>
        <div className="rounded-lg p-3 text-center bg-surface-2">
          <p className="text-2xl font-bold tabular-nums text-fg-muted">{data.total24h}</p>
          <p className="text-[11px] text-fg-subtle mt-0.5">{t('dash_attack_last_24h')}</p>
        </div>
      </div>

      {/* Top attack types */}
      {data.byType.length > 0 && (
        <div className="mb-4">
          <p className="text-[11px] font-semibold text-fg-subtle uppercase tracking-wide mb-2">{t('dash_attack_types')}</p>
          <div className="space-y-1.5">
            {data.byType.map((b) => (
              <div key={b.type} className="flex items-center justify-between">
                <span className="text-xs text-fg-muted font-mono">{typeLabel[b.type] ?? b.type}</span>
                <span className="text-xs font-semibold text-fg tabular-nums">{b.count}×</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 10.5: per protocol */}
      {(data.byProtocol?.length ?? 0) > 0 && (
        <div className="mb-4">
          <p className="text-[11px] font-semibold text-fg-subtle uppercase tracking-wide mb-2">{t('dash_attack_protocols')}</p>
          <div className="space-y-1.5">
            {data.byProtocol!.map((b) => (
              <div key={b.protocol} className="flex items-center justify-between">
                <span className="text-xs text-fg-muted font-mono">{protocolLabel(b.protocol)}</span>
                <span className="text-xs font-semibold text-fg tabular-nums">{b.count}×</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Top-IPs */}
      {data.topIps.length > 0 && (
        <div className="mb-4">
          <p className="text-[11px] font-semibold text-fg-subtle uppercase tracking-wide mb-2">{t('dash_attack_top_ips')}</p>
          <div className="space-y-1.5">
            {data.topIps.slice(0, 5).map((t) => (
              <div key={t.ip} className="flex items-center justify-between">
                <span className="text-xs font-mono text-fg-muted">{t.ip}</span>
                <span className="text-xs font-semibold text-danger-fg tabular-nums">{t.count}×</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent events */}
      {data.latestEvents.length === 0 ? (
        <div className="flex items-center gap-2 justify-center text-success-fg py-2">
          <CheckCircle size={14} />
          <span className="text-xs">{t('dash_attack_none')}</span>
        </div>
      ) : (
        <div>
          <p className="text-[11px] font-semibold text-fg-subtle uppercase tracking-wide mb-2">{t('dash_attack_events')}</p>
          <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
            {data.latestEvents.slice(0, 10).map((e) => (
              <div key={e.id} className="flex items-start gap-2 p-1.5 rounded bg-surface-2 hover:bg-surface-2 transition-colors">
                <span className="shrink-0 mt-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded bg-danger-bg text-danger-fg whitespace-nowrap">
                  {typeLabel[e.type] ?? e.type}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-mono text-fg-muted truncate">{e.ip}</p>
                  <p className="text-[10px] text-fg-subtle">{protocolLabel(e.protocol ?? e.service)} · {timeAgo(e.timestamp)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export function DashboardPage() {
  const t = useT();
  const chart = useChartTheme();
  const { data, isLoading, isError, error, refetch, dataUpdatedAt } = useQuery({
    queryKey: ['admin-dashboard'],
    queryFn:  () => api.get<DashboardData>('/admin/dashboard'),
    refetchInterval: 30_000,
  });
  const [showSettings, setShowSettings] = useState(false);
  const visible    = useDashboardStore((s) => s.visible);
  const order      = useDashboardStore((s) => s.order);
  const moveWidget = useDashboardStore((s) => s.moveWidget);
  // Widgets whose data the role may not read are left out entirely (server sends `sections`)
  const allowed: Partial<Record<WidgetId, boolean | undefined>> = {
    'recent-errors':   data?.sections?.errors,
    'storage-ranking': data?.sections?.storageUsers,
    'recent-audit':    data?.sections?.audit,
    'recent-logins':   data?.sections?.logins,
    'attack-events':   data?.sections?.attacks,
  };
  const isVisible  = (id: WidgetId) => (visible[id] ?? true) && allowed[id] !== false;

  // ── Drag state for direct reordering on the dashboard cards ────────────────
  const [cardDrag, setCardDrag]   = useState<WidgetId | null>(null);
  const [cardHover, setCardHover] = useState<WidgetId | null>(null);

  const lastUpdate = dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString('de-DE') : '—';

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex items-center gap-2 text-fg-subtle">
          <RefreshCw size={16} className="animate-spin" />
          <span className="text-sm">{t('dash_loading')}</span>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-6">
        <div role="alert" className="flex items-center gap-3 bg-danger-bg border border-danger-line text-danger-fg rounded-lg px-4 py-3 text-sm">
          <XCircle size={16} className="shrink-0" />
          <span className="flex-1">{isError && error instanceof Error && error.message ? error.message : t('dash_loading')}</span>
          <button onClick={() => void refetch()} className="btn-secondary text-xs">
            <RefreshCw size={13} /> {t('dash_refresh')}
          </button>
        </div>
      </div>
    );
  }

  const { users, domains, messages, storage, queues, recentErrors, recentAuditEvents, server, activeSessions, recentLogins, securityHits24h } = data;
  const totalQueueItems = queues.waiting + queues.active + queues.delayed;
  const hasQueueProblem = queues.failed > 0;
  const uptime = fmtUptime(server.uptimeSeconds);
  // Heap budget = V8 heap_size_limit (--max-old-space-size). Fallback to heapTotal
  // for older backends that do not yet provide heapLimit.
  const heapBudget = server.memory.heapLimit ?? server.memory.heapTotal;
  const heapPct    = heapBudget > 0 ? Math.round((server.memory.heapUsed / heapBudget) * 100) : 0;
  const sysMemUsed = server.memory.systemTotal - server.memory.systemFree;
  const sysMemPct = server.memory.systemTotal > 0 ? Math.round((sysMemUsed / server.memory.systemTotal) * 100) : 0;
  const cpuPct = server.cpu.cores > 0 ? Math.min(100, Math.round((server.cpu.load1 / server.cpu.cores) * 100)) : 0;

  const anyKpi = isVisible('kpi-users') || isVisible('kpi-domains') || isVisible('kpi-messages') || isVisible('kpi-storage');
  const anyQueueOrChart = isVisible('queue-status') || isVisible('mails-chart');
  const anyRankOrDomain = isVisible('storage-ranking') || isVisible('domains-chart');
  const anyErrorOrAudit = isVisible('recent-errors') || isVisible('recent-audit') || isVisible('attack-events');
  const anyServer = isVisible('server-info') || isVisible('server-resources') || isVisible('security-stats');

  return (
    <div className="p-6 space-y-6 max-w-[1400px]">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-fg">{t('dash_title')}</h1>
          <p className="text-xs text-fg-subtle mt-0.5">{t('dash_last_update')} {lastUpdate} · {t('dash_auto_refresh')}</p>
        </div>
        <div className="flex items-center gap-2 relative">
          <button
            onClick={() => void refetch()}
            className="btn-secondary text-xs"
            title={t('dash_refresh')}
          >
            <RefreshCw size={13} />
            {t('dash_refresh')}
          </button>
          <button
            onClick={() => setShowSettings((v) => !v)}
            className="btn-secondary text-xs"
            title={t('dash_display')}
          >
            <Settings size={13} />
            {t('dash_display')}
          </button>
          {showSettings && <WidgetSettingsPopover onClose={() => setShowSettings(false)} />}
        </div>
      </div>

      {/* 9.3: a mail port serves a self-signed / name-mismatched certificate */}
      <ServedCertWarning linkToCertificates />

      {/* 10.4.2: no trusted certificate for the public host name yet — one-click Let's Encrypt (dismissible) */}
      <CertificateSetupCard />

      {/* ── KPI cards (row 1) — order according to user `order` ────────────── */}
      {anyKpi && (() => {
        const kpiSlots: Partial<Record<WidgetId, ReactElement>> = {
          'kpi-users': (
            <KpiCard
              icon={Users}  color="bg-accent"
              label={t('dash_kpi_users')}
              value={users.total}
              sub={`${users.active} ${t('dash_kpi_users_sub')} · ${users.inactive} ${t('dash_kpi_users_sub2')}`}
              trend={{ value: users.newWeek, label: t('dash_kpi_users_trend') }}
            />
          ),
          'kpi-domains': (
            <KpiCard
              icon={Globe} color="bg-info"
              label={t('dash_kpi_domains')}
              value={domains.total}
              sub={`${data.sharedMailboxes} ${t('dash_kpi_domains_sub')}`}
            />
          ),
          'kpi-messages': (
            <KpiCard
              icon={Mail}  color="bg-info"
              label={t('dash_kpi_messages')}
              value={messages.total}
              sub={`${fmtNum(messages.newDay)} ${t('dash_kpi_messages_today')} · ${fmtNum(messages.newWeek)} ${t('dash_kpi_messages_week')}`}
              trend={{ value: messages.newDay, label: t('dash_kpi_messages_today') }}
            />
          ),
          'kpi-storage': (
            <KpiCard
              icon={HardDrive} color="bg-info"
              label={t('dash_kpi_storage')}
              value={fmtBytes(storage.totalUsedBytes)}
              sub={`${t('dash_kpi_storage_top')} ${storage.topUsers[0]?.displayName ?? '—'} (${fmtBytes(storage.topUsers[0]?.usedBytes ?? 0)})`}
            />
          ),
        };
        const sorted = sortByOrder(['kpi-users','kpi-domains','kpi-messages','kpi-storage'], order);
        return (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {sorted.map((id) => isVisible(id) && kpiSlots[id]
              ? <DraggableCard key={id} id={id}
                  cardDrag={cardDrag} cardHover={cardHover}
                  setCardDrag={setCardDrag} setCardHover={setCardHover}
                  order={order} moveWidget={moveWidget}>{kpiSlots[id]}</DraggableCard>
              : null)}
          </div>
        );
      })()}

      {/* ── Server section ────────────────────────────────────────────────── */}
      {anyServer && (() => {
        const serverSlots: Partial<Record<WidgetId, ReactElement>> = {
          'server-info': (
            <div className="card">
              <SectionTitle icon={Server} title="Server" />
              <div className="space-y-3">
                <div className="flex items-end gap-2">
                  <p className="text-3xl font-bold text-fg tabular-nums leading-none">{uptime.primary}</p>
                  <p className="text-sm text-fg-subtle mb-0.5">{uptime.secondary}</p>
                </div>
                <p className="text-xs text-fg-subtle">{t('dash_server_uptime')} {new Date(server.startedAt).toLocaleString('de-DE')}</p>
                <div className="pt-3 border-t border-line grid grid-cols-2 gap-y-1.5 gap-x-3 text-xs">
                  <span className="text-fg-subtle">{t('dash_server_version')}</span>
                  <span className="text-fg-muted font-mono">v{server.version}</span>
                  <span className="text-fg-subtle">{t('dash_server_hostname')}</span>
                  <span className="text-fg-muted font-mono truncate" title={server.hostname}>{server.hostname}</span>
                  <span className="text-fg-subtle">{t('dash_server_platform')}</span>
                  <span className="text-fg-muted font-mono">{server.platform}/{server.arch}</span>
                  <span className="text-fg-subtle">{t('dash_server_nodejs')}</span>
                  <span className="text-fg-muted font-mono">{server.nodeVersion}</span>
                  <span className="text-fg-subtle">{t('dash_server_pid')}</span>
                  <span className="text-fg-muted font-mono">{server.pid}</span>
                  <span className="text-fg-subtle">{t('dash_server_sessions')}</span>
                  <span className="text-fg-muted tabular-nums">{fmtNum(activeSessions)}</span>
                </div>
              </div>
            </div>
          ),
          'server-resources': (
            <div className="card">
              <SectionTitle icon={Cpu} title="Ressourcen" />
              <div className="space-y-4">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-fg-muted flex items-center gap-1.5"><Cpu size={12} className="text-fg-subtle" /> {t('dash_server_cpu')}</span>
                    <span className="text-xs font-semibold text-fg-muted tabular-nums">{server.cpu.load1.toFixed(2)} / {server.cpu.cores} Cores</span>
                  </div>
                  <MiniBar pct={cpuPct} color={barColor(cpuPct)} />
                  <p className="text-[11px] text-fg-subtle mt-1">5 min: {server.cpu.load5.toFixed(2)} · 15 min: {server.cpu.load15.toFixed(2)}</p>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-fg-muted flex items-center gap-1.5"><MemoryStick size={12} className="text-fg-subtle" /> {t('dash_server_ram')}</span>
                    <span className="text-xs font-semibold text-fg-muted tabular-nums">{fmtBytes(sysMemUsed)} / {fmtBytes(server.memory.systemTotal)}</span>
                  </div>
                  <MiniBar pct={sysMemPct} color={barColor(sysMemPct)} />
                  <p className="text-[11px] text-fg-subtle mt-1">{t('dash_server_free')} {fmtBytes(server.memory.systemFree)}</p>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-fg-muted flex items-center gap-1.5"><Activity size={12} className="text-fg-subtle" /> {t('dash_server_heap')}</span>
                    <span className="text-xs font-semibold text-fg-muted tabular-nums">{fmtBytes(server.memory.heapUsed)} / {fmtBytes(heapBudget)}</span>
                  </div>
                  <MiniBar pct={heapPct} color={barColor(heapPct)} />
                  <p className="text-[11px] text-fg-subtle mt-1">{t('dash_server_allocated')} {fmtBytes(server.memory.heapTotal)} · {t('dash_server_rss')} {fmtBytes(server.memory.rss)}</p>
                </div>
              </div>
            </div>
          ),
          'security-stats': (
            <div className="card">
              <SectionTitle icon={ShieldAlert} title="Sicherheit (24h)" />
              <div className="space-y-3">
                <div className="flex items-end gap-2">
                  <p className="text-3xl font-bold text-fg tabular-nums leading-none">{fmtNum(securityHits24h)}</p>
                  <p className="text-sm text-fg-subtle mb-0.5">{t('dash_security_hits')}</p>
                </div>
                <p className="text-xs text-fg-subtle">{t('dash_security_blocked')}</p>
                <div className="pt-3 border-t border-line grid grid-cols-2 gap-y-1.5 gap-x-3 text-xs">
                  <span className="text-fg-subtle">{t('dash_security_errors')}</span>
                  <span className="text-fg-muted tabular-nums">{allowed['recent-errors'] === false ? '—' : recentErrors.length}</span>
                  <span className="text-fg-subtle">{t('dash_security_audit')}</span>
                  <span className="text-fg-muted tabular-nums">{allowed['recent-audit'] === false ? '—' : recentAuditEvents.length}</span>
                  <span className="text-fg-subtle">{t('dash_security_logins')}</span>
                  <span className="text-fg-muted tabular-nums">{allowed['recent-logins'] === false ? '—' : recentLogins.length}</span>
                </div>
              </div>
            </div>
          ),
        };
        const sorted = sortByOrder(['server-info','server-resources','security-stats'], order);
        return (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {sorted.map((id) => isVisible(id) && serverSlots[id]
              ? <DraggableCard key={id} id={id}
                  cardDrag={cardDrag} cardHover={cardHover}
                  setCardDrag={setCardDrag} setCardHover={setCardHover}
                  order={order} moveWidget={moveWidget}>{serverSlots[id]}</DraggableCard>
              : null)}
          </div>
        );
      })()}

      {/* ── Queue status + messages chart ────────────────────────────────── */}
      {anyQueueOrChart && (() => {
        const queueSlots: Partial<Record<WidgetId, ReactElement>> = {
          'queue-status': (
            <div className="card">
              <SectionTitle icon={Layers} title="SMTP-Queue-Status" />
              <div className="grid grid-cols-2 gap-3">
                <QueueBadge label={t('dash_queue_waiting')} value={queues.waiting}
                  variant={queues.waiting > 100 ? 'warn' : 'default'} />
                <QueueBadge label={t('dash_queue_active')} value={queues.active}
                  variant={queues.active > 0 ? 'success' : 'default'} />
                <QueueBadge label={t('dash_queue_failed')} value={queues.failed}
                  variant={queues.failed > 0 ? 'error' : 'success'} />
                <QueueBadge label={t('dash_queue_delayed')} value={queues.delayed}
                  variant={queues.delayed > 0 ? 'warn' : 'default'} />
              </div>
              <div className={`mt-3 flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium ${
                hasQueueProblem
                  ? 'bg-danger-bg text-danger-fg'
                  : totalQueueItems > 200
                  ? 'bg-warning-bg text-warning-fg'
                  : 'bg-success-bg text-success-fg'
              }`}>
                {hasQueueProblem
                  ? <><XCircle size={13} /> {queues.failed} {t('dash_queue_jobs_error')}</>
                  : totalQueueItems > 200
                  ? <><AlertTriangle size={13} /> {t('dash_queue_high_load')} ({totalQueueItems} Jobs)</>
                  : <><CheckCircle size={13} /> {t('dash_queue_normal')}</>
                }
              </div>
            </div>
          ),
          'mails-chart': (
            <div className={`card ${isVisible('queue-status') ? 'lg:col-span-2' : 'lg:col-span-3'}`}>
              <SectionTitle icon={TrendingUp} title={t('dash_mails_chart_title')} />
              <ResponsiveContainer width="100%" height={160}>
                <AreaChart data={messages.mailsChart} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="mailGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor={chart.series} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={chart.series} stopOpacity={0}   />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
                  <XAxis dataKey="day" tick={{ fontSize: 11, fill: chart.axis }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: chart.axis }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip content={<ChartTooltip />} cursor={{ stroke: chart.border }} />
                  <Area
                    type="monotone" dataKey="count"
                    stroke={chart.series} strokeWidth={2}
                    fill="url(#mailGrad)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ),
        };
        const sorted = sortByOrder(['queue-status', 'mails-chart'], order);
        return (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {sorted.map((id) => isVisible(id) && queueSlots[id]
              ? <DraggableCard key={id} id={id}
                  cardDrag={cardDrag} cardHover={cardHover}
                  setCardDrag={setCardDrag} setCardHover={setCardHover}
                  order={order} moveWidget={moveWidget}>{queueSlots[id]}</DraggableCard>
              : null)}
          </div>
        );
      })()}

      {/* ── Storage ranking + domain overview ────────────────────────────── */}
      {anyRankOrDomain && (() => {
        const rankSlots: Partial<Record<WidgetId, ReactElement>> = {
          'storage-ranking': (
            <div className="card">
              <SectionTitle icon={HardDrive} title={t('dash_storage_ranking')} />
              <div className="space-y-3">
                {storage.topUsers.length === 0 && (
                  <p className="text-xs text-fg-subtle text-center py-4">{t('dash_storage_no_data')}</p>
                )}
                {storage.topUsers.map((u, i) => (
                  <div key={u.id}>
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs text-fg-subtle w-4 shrink-0">#{i + 1}</span>
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-fg truncate">{u.displayName}</p>
                          <p className="text-[11px] text-fg-subtle truncate">{u.email}</p>
                        </div>
                      </div>
                      <div className="text-right shrink-0 ml-2">
                        <p className="text-xs font-semibold text-fg-muted">{fmtBytes(u.usedBytes)}</p>
                        <p className="text-[11px] text-fg-subtle">{u.usedPercent}%</p>
                      </div>
                    </div>
                    <div className="h-1.5 bg-surface-2 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${barColor(u.usedPercent)}`}
                        style={{ width: `${Math.min(u.usedPercent, 100)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ),
          'domains-chart': (
            <div className="card">
              <SectionTitle icon={Globe} title={t('dash_domains_chart')} />
              {domains.list.length === 0 ? (
                <p className="text-xs text-fg-subtle text-center py-4">{t('dash_domains_no_domains')}</p>
              ) : (
                <>
                  <ResponsiveContainer width="100%" height={120}>
                    <BarChart data={domains.list} margin={{ top: 4, right: 8, left: -20, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={chart.grid} />
                      <XAxis dataKey="name" tick={{ fontSize: 10, fill: chart.axis }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 10, fill: chart.axis }} axisLine={false} tickLine={false} allowDecimals={false} />
                      <Tooltip
                        formatter={(v: number) => [`${v} ${t('dash_domains_users')}`, '']}
                        contentStyle={{ fontSize: 12, borderRadius: 8, background: chart.surface, borderColor: chart.border, color: chart.fg }}
                        itemStyle={{ color: chart.fg }}
                        labelStyle={{ color: chart.fg }}
                        cursor={{ fill: chart.hover }}
                      />
                      {/* One series (users per domain): the domain name on the axis and in the
                          list below carries the meaning, so every bar uses the accent token. */}
                      <Bar dataKey="userCount" radius={[4, 4, 0, 0]} maxBarSize={40} fill={chart.series} />
                    </BarChart>
                  </ResponsiveContainer>
                  <div className="mt-3 divide-y divide-line">
                    {domains.list.map((d) => (
                      <div key={d.id} className="flex items-center justify-between py-1.5">
                        <div className="flex items-center gap-2">
                          <span
                            className={`w-2 h-2 rounded-full shrink-0 ${d.active ? 'bg-success-fg' : 'border border-line-strong'}`}
                            title={d.active ? t('status_active') : t('status_inactive')}
                            aria-hidden="true"
                          />
                          <span className="sr-only">{d.active ? t('status_active') : t('status_inactive')}</span>
                          <span className="text-xs font-mono text-fg-muted">{d.name}</span>
                        </div>
                        <span className="text-xs text-fg-subtle">{d.userCount} {t('dash_domains_users')}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          ),
        };
        const sorted = sortByOrder(['storage-ranking', 'domains-chart'], order);
        return (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {sorted.map((id) => isVisible(id) && rankSlots[id]
              ? <DraggableCard key={id} id={id}
                  cardDrag={cardDrag} cardHover={cardHover}
                  setCardDrag={setCardDrag} setCardHover={setCardHover}
                  order={order} moveWidget={moveWidget}>{rankSlots[id]}</DraggableCard>
              : null)}
          </div>
        );
      })()}

      {/* ── Error log + audit trail + attack detection ──────────────────── */}
      {anyErrorOrAudit && (() => {
        const errorSlots: Partial<Record<WidgetId, ReactElement>> = {
          'attack-events': (
            <AttackEventsWidget />
          ),
          'recent-errors': (
            <div className="card">
              <SectionTitle icon={AlertTriangle} title={t('dash_errors_title')} />
              {recentErrors.length === 0 ? (
                <div className="flex items-center gap-2 py-6 justify-center text-success-fg">
                  <CheckCircle size={16} />
                  <span className="text-sm">{t('dash_errors_empty')}</span>
                </div>
              ) : (
                <div className="space-y-2">
                  {recentErrors.map((e) => (
                    <div key={e.id} className="flex items-start gap-2.5 p-2 rounded-lg bg-surface-2 hover:bg-surface-2 transition-colors">
                      <span className={`shrink-0 mt-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded uppercase ${
                        e.level === 'ERROR' ? 'bg-danger-bg text-danger-fg' : 'bg-warning-bg text-warning-fg'
                      }`}>
                        {e.level}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-fg-muted truncate">{e.message}</p>
                        <p className="text-[11px] text-fg-subtle mt-0.5">
                          <span className="font-mono">{e.service}</span> · {timeAgo(e.timestamp)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ),
          'recent-audit': (
            <div className="card">
              <SectionTitle icon={ShieldCheck} title={t('dash_audit_title')} />
              {recentAuditEvents.length === 0 ? (
                <p className="text-xs text-fg-subtle text-center py-6">{t('dash_audit_empty')}</p>
              ) : (
                <div className="divide-y divide-line">
                  {recentAuditEvents.map((e) => (
                    <div key={e.id} className="flex items-start gap-2.5 py-2.5">
                      <div className={`shrink-0 mt-0.5 w-5 h-5 rounded-full flex items-center justify-center ${
                        e.success ? 'bg-success-bg' : 'bg-danger-bg'
                      }`}>
                        {e.success
                          ? <CheckCircle size={11} className="text-success-fg" />
                          : <XCircle    size={11} className="text-danger-fg"   />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-fg-muted">
                          <span className="font-medium">{e.actorEmail}</span>
                          <span className="text-fg-subtle"> · </span>
                          <span className="font-mono text-fg-muted">{e.action}</span>
                          {e.targetName && (
                            <span className="text-fg-subtle"> → {e.targetName}</span>
                          )}
                        </p>
                        <p className="text-[11px] text-fg-subtle mt-0.5">{e.targetType} · {timeAgo(e.timestamp)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ),
        };
        const sorted = sortByOrder(['attack-events', 'recent-errors', 'recent-audit'], order);
        return (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {sorted.map((id) => isVisible(id) && errorSlots[id]
              ? <DraggableCard key={id} id={id}
                  cardDrag={cardDrag} cardHover={cardHover}
                  setCardDrag={setCardDrag} setCardHover={setCardHover}
                  order={order} moveWidget={moveWidget}>{errorSlots[id]}</DraggableCard>
              : null)}
          </div>
        );
      })()}

      {/* ── Recent logins ────────────────────────────────────────────────── */}
      {isVisible('recent-logins') && (
        <DraggableCard id="recent-logins" cardDrag={cardDrag} cardHover={cardHover}
          setCardDrag={setCardDrag} setCardHover={setCardHover} order={order} moveWidget={moveWidget}>
          <div className="card">
            <SectionTitle icon={LogIn} title={t('dash_logins_title')} />
            {recentLogins.length === 0 ? (
              <p className="text-xs text-fg-subtle text-center py-6">{t('dash_logins_empty')}</p>
            ) : (
              <div className="divide-y divide-line">
                {recentLogins.map((l) => (
                  <div key={l.id} className="flex items-center justify-between py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-fg-muted font-medium truncate">{l.actorEmail}</p>
                      <p className="text-[11px] text-fg-subtle mt-0.5 truncate">
                        {l.ipAddress ?? '—'} · {l.userAgent.slice(0, 60) || t('dash_logins_unknown')}{l.userAgent.length > 60 ? '…' : ''}
                      </p>
                    </div>
                    <span className="text-[11px] text-fg-subtle shrink-0 ml-2">{timeAgo(l.timestamp)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DraggableCard>
      )}

      {/* ── System info strip ─────────────────────────────────────────────── */}
      {isVisible('system-strip') && (
        <DraggableCard id="system-strip" cardDrag={cardDrag} cardHover={cardHover}
          setCardDrag={setCardDrag} setCardHover={setCardHover} order={order} moveWidget={moveWidget}>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="card flex items-center gap-3 py-3">
              <div className="w-8 h-8 rounded-lg bg-info-bg flex items-center justify-center shrink-0">
                <Inbox size={14} className="text-info-fg" />
              </div>
              <div>
                <p className="text-xs text-fg-subtle">{t('dash_strip_queue')}</p>
                <p className="text-base font-bold text-fg">{fmtNum(totalQueueItems)}</p>
              </div>
            </div>
            <div className="card flex items-center gap-3 py-3">
              <div className="w-8 h-8 rounded-lg bg-success-bg flex items-center justify-center shrink-0">
                <Activity size={14} className="text-success-fg" />
              </div>
              <div>
                <p className="text-xs text-fg-subtle">{t('dash_strip_delivered')}</p>
                <p className="text-base font-bold text-fg">{fmtNum(queues.completed)}</p>
              </div>
            </div>
            <div className="card flex items-center gap-3 py-3">
              <div className="w-8 h-8 rounded-lg bg-info-bg flex items-center justify-center shrink-0">
                <UserPlus size={14} className="text-info-fg" />
              </div>
              <div>
                <p className="text-xs text-fg-subtle">{t('dash_strip_new_users')}</p>
                <p className="text-base font-bold text-fg">{fmtNum(users.newWeek)}</p>
              </div>
            </div>
            <div className="card flex items-center gap-3 py-3">
              <div className="w-8 h-8 rounded-lg bg-warning-bg flex items-center justify-center shrink-0">
                <Clock size={14} className="text-warning-fg" />
              </div>
              <div>
                <p className="text-xs text-fg-subtle">{t('dash_strip_mails_today')}</p>
                <p className="text-base font-bold text-fg">{fmtNum(messages.newDay)}</p>
              </div>
            </div>
          </div>
        </DraggableCard>
      )}

    </div>
  );
}
