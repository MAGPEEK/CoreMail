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
  ResponsiveContainer, Cell,
} from 'recharts';
import { api, getToken } from '../api/client.js';
import { useDashboardStore, WIDGET_CATALOG, type WidgetId } from '../store/dashboard.js';

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
  server: {
    version: string; hostname: string; platform: string; arch: string;
    nodeVersion: string; pid: number; uptimeSeconds: number; startedAt: string;
    memory: { heapUsed: number; heapTotal: number; heapLimit?: number; rss: number; systemTotal: number; systemFree: number };
    cpu:    { cores: number; model: string; load1: number; load5: number; load15: number };
  };
  activeSessions: number;
  recentLogins:   { id: string; timestamp: string; actorEmail: string; ipAddress: string | null; userAgent: string }[];
  securityHits24h: number;
  generatedAt: string;
}

interface AttackSummary {
  total24h:    number;
  total1h:     number;
  byType:      { type: string; count: number }[];
  topIps:      { ip: string;   count: number }[];
  latestEvents: {
    id: string; timestamp: string; type: string;
    ip: string; target: string | null; service: string;
    detail: Record<string, unknown>;
  }[];
  isUnderAttack: boolean;
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

function fmtUptime(sec: number): { primary: string; secondary: string } {
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  if (days > 0) return { primary: `${days} ${days === 1 ? 'Tag' : 'Tage'}`, secondary: `${hours} h ${mins} min` };
  if (hours > 0) return { primary: `${hours} h`, secondary: `${mins} min` };
  return { primary: `${mins} min`, secondary: `${sec % 60} s` };
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

// ── Mini-Bar (für RAM/CPU-Anzeige) ────────────────────────────────────────────
function MiniBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
      <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${Math.min(pct, 100)}%` }} />
    </div>
  );
}

// ── Settings-Popover mit Drag-Reorder ────────────────────────────────────────
// Native HTML5 Drag-and-Drop — kein @dnd-kit nötig, weil die Interaktion auf
// eine simple vertikale Liste begrenzt ist. Die Position innerhalb der globalen
// `order`-Liste bestimmt die Reihenfolge im Dashboard (per Gruppe sortiert).
function WidgetSettingsPopover({ onClose }: { onClose: () => void }) {
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
    kpi: 'Kennzahlen', charts: 'Diagramme & Queue', lists: 'Listen', server: 'Server',
  };

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-2 w-96 bg-white rounded-lg border border-gray-200 shadow-xl z-20"
    >
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Widgets anzeigen & anordnen</h3>
          <p className="text-[11px] text-gray-400 mt-0.5">Per Drag verschieben · Checkbox blendet ein/aus</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button onClick={() => setAll(true)}  className="text-[11px] px-2 py-0.5 rounded border border-gray-200 text-gray-600 hover:bg-gray-50">Alle</button>
          <button onClick={() => setAll(false)} className="text-[11px] px-2 py-0.5 rounded border border-gray-200 text-gray-600 hover:bg-gray-50">Keine</button>
          <button onClick={reset}               className="text-[11px] px-2 py-0.5 rounded border border-gray-200 text-gray-600 hover:bg-gray-50">Standard</button>
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
              // Firefox: ohne setData wird drag sofort abgebrochen
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
              // Nur leeren, wenn cursor wirklich die ganze Zeile verlässt
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
            className={`flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 cursor-move transition-opacity ${
              hoverIndex === i ? 'border-t-2 border-accent' : 'border-t-2 border-transparent'
            } ${draggingIndex === i ? 'opacity-40' : ''}`}
          >
            <GripVertical size={13} className="text-gray-300 shrink-0" />
            <input
              type="checkbox"
              checked={visible[w.id] ?? true}
              onChange={() => toggle(w.id)}
              onClick={(e) => e.stopPropagation()}
              draggable={false}
              className="h-4 w-4 rounded border-gray-300 text-accent focus:ring-accent shrink-0"
            />
            <span className="text-sm text-gray-700 flex-1 truncate">{w.label}</span>
            <span className="text-[10px] text-gray-400 uppercase tracking-wide shrink-0">{GROUP_LABELS[w.group]}</span>
          </div>
        ))}
        {/* End-of-list Drop-Zone — erlaubt "ans Ende ziehen" */}
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
          className={`h-3 ${hoverIndex === orderedItems.length ? 'border-t-2 border-accent' : 'border-t-2 border-transparent'}`}
        />
      </div>
    </div>
  );
}

// ── Reorder-Helper für die Dashboard-Sections ────────────────────────────────
// Sortiert eine Liste von Widget-IDs nach ihrer Position im User-`order`.
// Unbekannte IDs (nicht in der order-Liste) landen am Ende in Ursprungsreihenfolge.
function sortByOrder(ids: WidgetId[], order: WidgetId[]): WidgetId[] {
  const idx = new Map(order.map((id, i) => [id, i] as const));
  return [...ids].sort((a, b) => (idx.get(a) ?? 9999) - (idx.get(b) ?? 9999));
}

// ── DraggableCard ───────────────────────────────────────────────────────────
// WICHTIG: muss auf Modul-Ebene definiert sein. Inline in DashboardPage führt
// dazu, dass jeder Re-Render eine neue Funktion-Referenz erzeugt → React mountet
// die Karten beim ersten setState-Aufruf neu → laufender Drag bricht ab.
//
// `select-none` verhindert Text-Selektion beim Mousedown auf Text in der Karte
// (sonst startet Chrome/Firefox Text-Selektion statt Drag).
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
        cardHover === id && sameGroup ? 'ring-2 ring-accent ring-offset-2' : ''
      }`}
      title="Per Drag verschieben"
    >
      {children}
    </div>
  );
}

// ── Angriffs-Erkennungs-Widget ────────────────────────────────────────────────
// Pollt /admin/security/attacks/summary alle 30s und lauscht auf SSE-Events
// vom Typ `security:attack` für Echtzeit-Updates.
function AttackEventsWidget() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['attack-summary'],
    queryFn:  () => api.get<AttackSummary>('/admin/security/attacks/summary'),
    refetchInterval: 30_000,
  });

  // SSE-Subscription für Live-Updates
  useEffect(() => {
    const token = getToken();
    if (!token) return;
    const url = `/api/v1/events?token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);

    es.addEventListener('security:attack', () => {
      // Invalidieren reicht — Query holt sich die neuen Daten
      void queryClient.invalidateQueries({ queryKey: ['attack-summary'] });
    });

    es.onerror = () => { /* reconnect handled by browser */ };
    return () => es.close();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const typeLabel: Record<string, string> = {
    AUTH_BRUTE_FORCE: 'Brute-Force',
    IP_RATE_LIMIT:    'IP-Rate-Limit',
    OPEN_RELAY:       'Open-Relay',
    SPAM:             'Spam',
  };

  if (isLoading || !data) {
    return (
      <div className="card">
        <SectionTitle icon={Siren} title="Angriffs-Erkennung (Live)" />
        <p className="text-xs text-gray-400 text-center py-4">Lade…</p>
      </div>
    );
  }

  return (
    <div className={`card border-2 transition-colors ${data.isUnderAttack ? 'border-red-400 bg-red-50/30' : 'border-transparent'}`}>
      <div className="flex items-center justify-between mb-3">
        <SectionTitle icon={Siren} title="Angriffs-Erkennung (Live)" />
        {data.isUnderAttack && (
          <span className="flex items-center gap-1.5 text-xs font-bold text-red-600 bg-red-100 px-2.5 py-1 rounded-full animate-pulse">
            <AlertTriangle size={12} />
            UNTER ANGRIFF
          </span>
        )}
      </div>

      {/* Zähler */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className={`rounded-lg p-3 text-center ${data.total1h > 0 ? 'bg-red-50 border border-red-100' : 'bg-gray-50'}`}>
          <p className={`text-2xl font-bold tabular-nums ${data.total1h > 0 ? 'text-red-700' : 'text-gray-700'}`}>{data.total1h}</p>
          <p className="text-[11px] text-gray-500 mt-0.5">letzte Stunde</p>
        </div>
        <div className="rounded-lg p-3 text-center bg-gray-50">
          <p className="text-2xl font-bold tabular-nums text-gray-700">{data.total24h}</p>
          <p className="text-[11px] text-gray-500 mt-0.5">letzte 24 h</p>
        </div>
      </div>

      {/* Top-Angriffstypen */}
      {data.byType.length > 0 && (
        <div className="mb-4">
          <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">Angriffstypen</p>
          <div className="space-y-1.5">
            {data.byType.map((b) => (
              <div key={b.type} className="flex items-center justify-between">
                <span className="text-xs text-gray-600 font-mono">{typeLabel[b.type] ?? b.type}</span>
                <span className="text-xs font-semibold text-gray-800 tabular-nums">{b.count}×</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Top-IPs */}
      {data.topIps.length > 0 && (
        <div className="mb-4">
          <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">Top-IPs</p>
          <div className="space-y-1.5">
            {data.topIps.slice(0, 5).map((t) => (
              <div key={t.ip} className="flex items-center justify-between">
                <span className="text-xs font-mono text-gray-700">{t.ip}</span>
                <span className="text-xs font-semibold text-red-600 tabular-nums">{t.count}×</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Jüngste Ereignisse */}
      {data.latestEvents.length === 0 ? (
        <div className="flex items-center gap-2 justify-center text-green-600 py-2">
          <CheckCircle size={14} />
          <span className="text-xs">Keine Angriffe erkannt</span>
        </div>
      ) : (
        <div>
          <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-2">Letzte Ereignisse</p>
          <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
            {data.latestEvents.slice(0, 10).map((e) => (
              <div key={e.id} className="flex items-start gap-2 p-1.5 rounded bg-gray-50 hover:bg-gray-100 transition-colors">
                <span className="shrink-0 mt-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-700 whitespace-nowrap">
                  {typeLabel[e.type] ?? e.type}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-mono text-gray-700 truncate">{e.ip}</p>
                  <p className="text-[10px] text-gray-400">{e.service} · {timeAgo(e.timestamp)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Hauptkomponente ───────────────────────────────────────────────────────────
export function DashboardPage() {
  const { data, isLoading, refetch, dataUpdatedAt } = useQuery({
    queryKey: ['admin-dashboard'],
    queryFn:  () => api.get<DashboardData>('/admin/dashboard'),
    refetchInterval: 30_000,
  });
  const [showSettings, setShowSettings] = useState(false);
  const visible    = useDashboardStore((s) => s.visible);
  const order      = useDashboardStore((s) => s.order);
  const moveWidget = useDashboardStore((s) => s.moveWidget);
  const isVisible  = (id: WidgetId) => visible[id] ?? true;

  // ── Drag-State für direktes Reordern auf den Dashboard-Karten ──────────────
  const [cardDrag, setCardDrag]   = useState<WidgetId | null>(null);
  const [cardHover, setCardHover] = useState<WidgetId | null>(null);

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

  const { users, domains, messages, storage, queues, recentErrors, recentAuditEvents, server, activeSessions, recentLogins, securityHits24h } = data;
  const totalQueueItems = queues.waiting + queues.active + queues.delayed;
  const hasQueueProblem = queues.failed > 0;
  const uptime = fmtUptime(server.uptimeSeconds);
  // Heap-Budget = V8 heap_size_limit (--max-old-space-size). Fallback auf heapTotal
  // für ältere Backends, die heapLimit noch nicht liefern.
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

      {/* ── Kopfzeile ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Systemübersicht</h1>
          <p className="text-xs text-gray-400 mt-0.5">Letzte Aktualisierung: {lastUpdate} · Auto-Refresh alle 30s</p>
        </div>
        <div className="flex items-center gap-2 relative">
          <button
            onClick={() => void refetch()}
            className="btn-secondary text-xs"
            title="Jetzt aktualisieren"
          >
            <RefreshCw size={13} />
            Aktualisieren
          </button>
          <button
            onClick={() => setShowSettings((v) => !v)}
            className="btn-secondary text-xs"
            title="Widgets ein-/ausblenden"
          >
            <Settings size={13} />
            Anzeige
          </button>
          {showSettings && <WidgetSettingsPopover onClose={() => setShowSettings(false)} />}
        </div>
      </div>

      {/* ── KPI-Karten (Zeile 1) — Reihenfolge gemäß User-`order` ──────────── */}
      {anyKpi && (() => {
        const kpiSlots: Partial<Record<WidgetId, ReactElement>> = {
          'kpi-users': (
            <KpiCard
              icon={Users}  color="bg-blue-500"
              label="Benutzer gesamt"
              value={users.total}
              sub={`${users.active} aktiv · ${users.inactive} deaktiviert`}
              trend={{ value: users.newWeek, label: 'diese Woche neu' }}
            />
          ),
          'kpi-domains': (
            <KpiCard
              icon={Globe} color="bg-indigo-500"
              label="Domains"
              value={domains.total}
              sub={`${data.sharedMailboxes} geteilte Postfächer · ${data.groups} Gruppen`}
            />
          ),
          'kpi-messages': (
            <KpiCard
              icon={Mail}  color="bg-sky-500"
              label="E-Mails gesamt"
              value={messages.total}
              sub={`${fmtNum(messages.newDay)} heute · ${fmtNum(messages.newWeek)} diese Woche`}
              trend={{ value: messages.newDay, label: 'heute' }}
            />
          ),
          'kpi-storage': (
            <KpiCard
              icon={HardDrive} color="bg-violet-500"
              label="Gesamt-Speicher"
              value={fmtBytes(storage.totalUsedBytes)}
              sub={`Top-Nutzer: ${storage.topUsers[0]?.displayName ?? '—'} (${fmtBytes(storage.topUsers[0]?.usedBytes ?? 0)})`}
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

      {/* ── Server-Sektion ────────────────────────────────────────────────── */}
      {anyServer && (() => {
        const serverSlots: Partial<Record<WidgetId, ReactElement>> = {
          'server-info': (
            <div className="card">
              <SectionTitle icon={Server} title="Server" />
              <div className="space-y-3">
                <div className="flex items-end gap-2">
                  <p className="text-3xl font-bold text-gray-900 tabular-nums leading-none">{uptime.primary}</p>
                  <p className="text-sm text-gray-400 mb-0.5">{uptime.secondary}</p>
                </div>
                <p className="text-xs text-gray-500">Uptime seit {new Date(server.startedAt).toLocaleString('de-DE')}</p>
                <div className="pt-3 border-t border-gray-100 grid grid-cols-2 gap-y-1.5 gap-x-3 text-xs">
                  <span className="text-gray-400">Version</span>
                  <span className="text-gray-700 font-mono">v{server.version}</span>
                  <span className="text-gray-400">Hostname</span>
                  <span className="text-gray-700 font-mono truncate" title={server.hostname}>{server.hostname}</span>
                  <span className="text-gray-400">Plattform</span>
                  <span className="text-gray-700 font-mono">{server.platform}/{server.arch}</span>
                  <span className="text-gray-400">Node.js</span>
                  <span className="text-gray-700 font-mono">{server.nodeVersion}</span>
                  <span className="text-gray-400">PID</span>
                  <span className="text-gray-700 font-mono">{server.pid}</span>
                  <span className="text-gray-400">Sessions aktiv</span>
                  <span className="text-gray-700 tabular-nums">{fmtNum(activeSessions)}</span>
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
                    <span className="text-xs font-medium text-gray-600 flex items-center gap-1.5"><Cpu size={12} className="text-gray-400" /> CPU-Last (1 min)</span>
                    <span className="text-xs font-semibold text-gray-700 tabular-nums">{server.cpu.load1.toFixed(2)} / {server.cpu.cores} Cores</span>
                  </div>
                  <MiniBar pct={cpuPct} color={barColor(cpuPct)} />
                  <p className="text-[11px] text-gray-400 mt-1">5 min: {server.cpu.load5.toFixed(2)} · 15 min: {server.cpu.load15.toFixed(2)}</p>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-gray-600 flex items-center gap-1.5"><MemoryStick size={12} className="text-gray-400" /> System-RAM</span>
                    <span className="text-xs font-semibold text-gray-700 tabular-nums">{fmtBytes(sysMemUsed)} / {fmtBytes(server.memory.systemTotal)}</span>
                  </div>
                  <MiniBar pct={sysMemPct} color={barColor(sysMemPct)} />
                  <p className="text-[11px] text-gray-400 mt-1">Frei: {fmtBytes(server.memory.systemFree)}</p>
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-gray-600 flex items-center gap-1.5"><Activity size={12} className="text-gray-400" /> Node-Heap</span>
                    <span className="text-xs font-semibold text-gray-700 tabular-nums">{fmtBytes(server.memory.heapUsed)} / {fmtBytes(heapBudget)}</span>
                  </div>
                  <MiniBar pct={heapPct} color={barColor(heapPct)} />
                  <p className="text-[11px] text-gray-400 mt-1">Allokiert {fmtBytes(server.memory.heapTotal)} · RSS {fmtBytes(server.memory.rss)}</p>
                </div>
              </div>
            </div>
          ),
          'security-stats': (
            <div className="card">
              <SectionTitle icon={ShieldAlert} title="Sicherheit (24h)" />
              <div className="space-y-3">
                <div className="flex items-end gap-2">
                  <p className="text-3xl font-bold text-gray-900 tabular-nums leading-none">{fmtNum(securityHits24h)}</p>
                  <p className="text-sm text-gray-400 mb-0.5">DNSBL-Treffer</p>
                </div>
                <p className="text-xs text-gray-500">Anzahl blockierter oder markierter IPs in den letzten 24 Stunden</p>
                <div className="pt-3 border-t border-gray-100 grid grid-cols-2 gap-y-1.5 gap-x-3 text-xs">
                  <span className="text-gray-400">Letzte Fehler</span>
                  <span className="text-gray-700 tabular-nums">{recentErrors.length}</span>
                  <span className="text-gray-400">Audit-Events</span>
                  <span className="text-gray-700 tabular-nums">{recentAuditEvents.length}</span>
                  <span className="text-gray-400">Anmeldungen</span>
                  <span className="text-gray-700 tabular-nums">{recentLogins.length}</span>
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

      {/* ── Queue-Status + Nachrichten-Chart ─────────────────────────────── */}
      {anyQueueOrChart && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

          {/* Queue-Status */}
          {isVisible('queue-status') && (
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
          )}

          {/* Mail-Aktivitäts-Chart */}
          {isVisible('mails-chart') && (
            <div className={`card ${isVisible('queue-status') ? 'lg:col-span-2' : 'lg:col-span-3'}`}>
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
          )}
        </div>
      )}

      {/* ── Speicher-Ranking + Domain-Übersicht ──────────────────────────── */}
      {anyRankOrDomain && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

          {/* Top-10 Speichernutzer */}
          {isVisible('storage-ranking') && (
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
          )}

          {/* Domain-Übersicht */}
          {isVisible('domains-chart') && (
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
          )}
        </div>
      )}

      {/* ── Fehler-Log + Audit-Trail + Angriffs-Erkennung ───────────────── */}
      {anyErrorOrAudit && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

          {/* Angriffs-Erkennung */}
          {isVisible('attack-events') && (
            <DraggableCard key="attack-events" id="attack-events"
              cardDrag={cardDrag} cardHover={cardHover}
              setCardDrag={setCardDrag} setCardHover={setCardHover}
              order={order} moveWidget={moveWidget}>
              <AttackEventsWidget />
            </DraggableCard>
          )}

          {/* Letzte Fehler */}
          {isVisible('recent-errors') && (
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
          )}

          {/* Audit-Trail */}
          {isVisible('recent-audit') && (
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
          )}
        </div>
      )}

      {/* ── Letzte Anmeldungen ───────────────────────────────────────────── */}
      {isVisible('recent-logins') && (
        <div className="card">
          <SectionTitle icon={LogIn} title="Letzte Anmeldungen" />
          {recentLogins.length === 0 ? (
            <p className="text-xs text-gray-400 text-center py-6">Keine Anmeldungen protokolliert</p>
          ) : (
            <div className="divide-y divide-gray-50">
              {recentLogins.map((l) => (
                <div key={l.id} className="flex items-center justify-between py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-gray-700 font-medium truncate">{l.actorEmail}</p>
                    <p className="text-[11px] text-gray-400 mt-0.5 truncate">
                      {l.ipAddress ?? '—'} · {l.userAgent.slice(0, 60) || 'unbekannt'}{l.userAgent.length > 60 ? '…' : ''}
                    </p>
                  </div>
                  <span className="text-[11px] text-gray-400 shrink-0 ml-2">{timeAgo(l.timestamp)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── System-Info-Leiste ────────────────────────────────────────────── */}
      {isVisible('system-strip') && (
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
      )}

    </div>
  );
}
