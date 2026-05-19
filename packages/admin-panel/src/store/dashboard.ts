import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// ── Widget-Katalog ──────────────────────────────────────────────────────────
// Jeder Wert muss eindeutig sein — wird als Key im localStorage gespeichert.
// Neue Widgets einfach hier ergänzen; default-on über `DEFAULT_VISIBILITY`.
export type WidgetId =
  | 'kpi-users'
  | 'kpi-domains'
  | 'kpi-messages'
  | 'kpi-storage'
  | 'queue-status'
  | 'mails-chart'
  | 'storage-ranking'
  | 'domains-chart'
  | 'recent-errors'
  | 'recent-audit'
  | 'system-strip'
  | 'server-info'
  | 'server-resources'
  | 'recent-logins'
  | 'security-stats';

export const WIDGET_CATALOG: { id: WidgetId; label: string; group: 'kpi' | 'charts' | 'lists' | 'server' }[] = [
  { id: 'kpi-users',        label: 'Benutzer',                     group: 'kpi' },
  { id: 'kpi-domains',      label: 'Domains',                      group: 'kpi' },
  { id: 'kpi-messages',     label: 'E-Mails',                      group: 'kpi' },
  { id: 'kpi-storage',      label: 'Speicher',                     group: 'kpi' },
  { id: 'queue-status',     label: 'SMTP-Queue-Status',            group: 'charts' },
  { id: 'mails-chart',      label: 'E-Mail-Aktivität (7 Tage)',    group: 'charts' },
  { id: 'storage-ranking',  label: 'Speicher-Ranking (Top 10)',    group: 'lists' },
  { id: 'domains-chart',    label: 'Domains & Benutzerverteilung', group: 'charts' },
  { id: 'recent-errors',    label: 'Letzte Fehler & Warnungen',    group: 'lists' },
  { id: 'recent-audit',     label: 'Letzte Admin-Aktionen',        group: 'lists' },
  { id: 'system-strip',     label: 'System-Info-Leiste',           group: 'kpi' },
  { id: 'server-info',      label: 'Server-Info (Uptime, Version)', group: 'server' },
  { id: 'server-resources', label: 'Server-Ressourcen (RAM, CPU)', group: 'server' },
  { id: 'recent-logins',    label: 'Letzte Anmeldungen',           group: 'lists' },
  { id: 'security-stats',   label: 'Sicherheits-Statistik (24h)',  group: 'server' },
];

const DEFAULT_VISIBILITY: Record<WidgetId, boolean> = {
  'kpi-users':        true,
  'kpi-domains':      true,
  'kpi-messages':     true,
  'kpi-storage':      true,
  'queue-status':     true,
  'mails-chart':      true,
  'storage-ranking':  true,
  'domains-chart':    true,
  'recent-errors':    true,
  'recent-audit':     true,
  'system-strip':     true,
  'server-info':      true,
  'server-resources': true,
  'recent-logins':    true,
  'security-stats':   true,
};

const DEFAULT_ORDER: WidgetId[] = WIDGET_CATALOG.map((w) => w.id);

interface DashboardStore {
  visible:       Record<WidgetId, boolean>;
  order:         WidgetId[]; // flache Reihenfolge — Dashboard sortiert pro Gruppe nach diesem Index
  toggle:        (id: WidgetId) => void;
  setAll:        (value: boolean) => void;
  resetDefaults: () => void;
  moveWidget:    (from: number, to: number) => void;
}

export const useDashboardStore = create<DashboardStore>()(
  persist(
    (set, get) => ({
      visible: { ...DEFAULT_VISIBILITY },
      order:   [...DEFAULT_ORDER],
      toggle: (id) => set({ visible: { ...get().visible, [id]: !get().visible[id] } }),
      setAll: (value) => set({
        visible: Object.fromEntries(WIDGET_CATALOG.map((w) => [w.id, value])) as Record<WidgetId, boolean>,
      }),
      resetDefaults: () => set({ visible: { ...DEFAULT_VISIBILITY }, order: [...DEFAULT_ORDER] }),
      // Semantik: `to` ist die "Insert-vor-diesem-Index"-Position.
      // Wert `to === length` = ans Ende anhängen.
      // Wichtig: wenn `from < to`, schiebt das `splice(from,1)` alle nachfolgenden
      // Indices um 1 runter, daher Korrektur per `to - 1`.
      moveWidget: (from, to) => {
        const current = get().order;
        if (from < 0 || from >= current.length) return;
        if (to < 0 || to > current.length) return;
        if (from === to || from + 1 === to) return; // kein No-Op-Move
        const next = [...current];
        const [moved] = next.splice(from, 1);
        const insertAt = from < to ? to - 1 : to;
        next.splice(insertAt, 0, moved!);
        set({ order: next });
      },
    }),
    {
      name: 'coremail-dashboard-v1',
      // Fehlende Keys (z. B. nach Update mit neuen Widgets) auf Default setzen
      merge: (persisted, current) => {
        const p = persisted as Partial<DashboardStore> | undefined;
        // Order-Migration: alle bekannten IDs erhalten, in persistierter Reihenfolge zuerst,
        // dann neue Widgets aus DEFAULT_ORDER hinten anhängen.
        const validIds = new Set<WidgetId>(DEFAULT_ORDER);
        const persistedOrder = (p?.order ?? []).filter((id): id is WidgetId => validIds.has(id as WidgetId));
        const missingFromPersisted = DEFAULT_ORDER.filter((id) => !persistedOrder.includes(id));
        const mergedOrder: WidgetId[] = [...persistedOrder, ...missingFromPersisted];
        return {
          ...current,
          ...(p ?? {}),
          visible: { ...DEFAULT_VISIBILITY, ...(p?.visible ?? {}) },
          order:   mergedOrder,
        };
      },
    },
  ),
);
