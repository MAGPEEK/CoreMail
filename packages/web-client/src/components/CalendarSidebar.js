import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, MoreHorizontal, ChevronDown, ChevronRight, Eye, 
// Icons für Kalender-Auswahl
Calendar as CalendarIcon, Home, Briefcase, Plane, Heart, Star, Trophy, Gift, Cake, Music, Camera, Car, Bike, Bus, Train, Coffee, Utensils, Wine, ShoppingBag, ShoppingCart, Book, GraduationCap, Pencil, Brush, Stethoscope, Pill, Badge, Footprints, Dumbbell, Palette as PaletteIcon, Building, Wrench, Hammer, Code, Sun, Moon, Cloud, Umbrella, TreePine, Flower, Users, User, UserPlus, ClipboardCheck, Target, CheckSquare, Flag, AlertCircle, Bell, CreditCard, DollarSign, Wallet, Share2, Pencil as Edit3, Trash2, ArrowUp, ArrowDown, } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../api/client.js';
import { useUiPrefs } from '../store/ui.js';
import { ContextMenu } from './ContextMenu.js';
import { PromptDialog } from './PromptDialog.js';
// ─── Icon-Map: Lucide-Icon-Name → Component ───────────────────────────────────
export const ICON_MAP = {
    Calendar: CalendarIcon, Home, Briefcase, Plane, Heart, Star, Trophy, Gift,
    Cake, Music, Camera, Car, Bike, Bus, Train,
    Coffee, Utensils, Wine, ShoppingBag, ShoppingCart,
    Book, GraduationCap, Pencil, Brush, Stethoscope, Badge, Pill,
    Footprints, Dumbbell, Palette: PaletteIcon,
    Building, Wrench, Hammer, Code,
    Sun, Moon, Cloud, Umbrella, TreePine, Flower,
    Users, User, UserPlus,
    ClipboardCheck, Target, CheckSquare, Flag, AlertCircle, Bell,
    CreditCard, DollarSign, Wallet,
};
// Reihenfolge im Icon-Grid (kuratiert, gleiche Aussage wie Outlook)
const ICON_PALETTE = [
    'Plane', 'Calendar', 'Briefcase', 'Trophy', 'Home',
    'Badge', 'ShoppingBag', 'Users', 'AlertCircle', 'Music', 'Car',
    'Star', 'User', 'UserPlus', 'Utensils', 'Heart', 'Target',
    'Camera', 'Book', 'Cake', 'Code', 'Bus', 'Bell',
    'CreditCard', 'Bike', 'Train', 'GraduationCap', 'Dumbbell', 'Stethoscope',
    'Building', 'Wrench', 'Footprints', 'CheckSquare', 'ClipboardCheck', 'Flag',
];
// 16 Outlook-inspirierte Kalenderfarben
const COLOR_PALETTE = [
    '#A2433D', '#E64A19', '#F37E2F', '#FBC02D', '#8B5E3C', '#7CB342', '#388E3C', '#0EA5A4',
    '#06B6D4', '#3B82F6', '#1E40AF', '#5E35B1', '#9333EA', '#D81B60', '#EC4899', '#64748B',
];
export function CalendarSidebar({ onNewEvent, calendars, }) {
    const qc = useQueryClient();
    const { hiddenCalendarIds, toggleCalendar, showOnlyCalendar } = useUiPrefs();
    const [menu, setMenu] = useState(null);
    const [dialog, setDialog] = useState(null);
    const [expanded, setExpanded] = useState(true);
    const invalidate = () => {
        qc.invalidateQueries({ queryKey: ['calendars'] });
        qc.invalidateQueries({ queryKey: ['calendar-events'] });
    };
    const createCal = useMutation({
        mutationFn: (body) => api.post('/calendar', body),
        onSuccess: () => { invalidate(); toast.success('Kalender angelegt'); },
        onError: (e) => toast.error(e.message),
    });
    const patchCal = useMutation({
        mutationFn: ({ id, body }) => api.patch(`/calendar/${id}`, body),
        onSuccess: () => invalidate(),
        onError: (e) => toast.error(e.message),
    });
    const deleteCal = useMutation({
        mutationFn: (id) => api.delete(`/calendar/${id}`),
        onSuccess: () => { invalidate(); toast.success('Kalender gelöscht'); },
        onError: (e) => toast.error(e.message),
    });
    const reorderCal = useMutation({
        mutationFn: (ids) => api.post('/calendar/reorder', { ids }),
        onSuccess: () => invalidate(),
    });
    const sorted = useMemo(() => [...calendars].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)), [calendars]);
    const moveCalendar = (id, dir) => {
        const idx = sorted.findIndex((c) => c.id === id);
        const swap = idx + dir;
        if (idx < 0 || swap < 0 || swap >= sorted.length)
            return;
        const next = [...sorted];
        [next[idx], next[swap]] = [next[swap], next[idx]];
        reorderCal.mutate(next.map((c) => c.id));
    };
    const buildMenu = (cal) => {
        const allIds = sorted.map((c) => c.id);
        const idx = sorted.findIndex((c) => c.id === cal.id);
        const isHidden = hiddenCalendarIds.includes(cal.id);
        return [
            {
                label: 'Nur dies anzeigen',
                icon: _jsx(Eye, { size: 14 }),
                disabled: !isHidden && hiddenCalendarIds.length === sorted.length - 1,
                onClick: () => showOnlyCalendar(cal.id, allIds),
            },
            { type: 'divider' },
            {
                label: 'Teilen und Berechtigungen',
                icon: _jsx(Share2, { size: 14 }),
                onClick: () => toast('Bald verfügbar', { icon: 'ℹ️' }),
            },
            {
                label: 'Farbe',
                icon: _jsx(PaletteIcon, { size: 14 }),
                children: [
                    {
                        label: '✓ Automatisch',
                        onClick: () => patchCal.mutate({ id: cal.id, body: { color: '#0078D4' } }),
                    },
                    { type: 'divider' },
                    // 16 Farbpunkte als „Custom Render" via Icon — wir nutzen den onClick-Text als Hint
                    ...COLOR_PALETTE.map((c) => ({
                        label: c,
                        icon: _jsx("span", { className: "w-4 h-4 rounded-full block", style: { backgroundColor: c } }),
                        onClick: () => patchCal.mutate({ id: cal.id, body: { color: c } }),
                    })),
                ],
            },
            {
                label: 'Symbol',
                icon: _jsx(Star, { size: 14 }),
                children: [
                    {
                        label: 'Kein Symbol',
                        icon: _jsx(CalendarIcon, { size: 14, className: "text-gray-400" }),
                        onClick: () => patchCal.mutate({ id: cal.id, body: { icon: null } }),
                    },
                    { type: 'divider' },
                    ...ICON_PALETTE.filter((name) => ICON_MAP[name]).map((name) => {
                        const Icon = ICON_MAP[name];
                        return {
                            label: name,
                            icon: _jsx(Icon, { size: 14, style: { color: cal.color } }),
                            onClick: () => patchCal.mutate({ id: cal.id, body: { icon: name } }),
                        };
                    }),
                ],
            },
            { type: 'divider' },
            {
                label: 'Nach oben',
                icon: _jsx(ArrowUp, { size: 14 }),
                disabled: idx === 0,
                onClick: () => moveCalendar(cal.id, -1),
            },
            {
                label: 'Nach unten',
                icon: _jsx(ArrowDown, { size: 14 }),
                disabled: idx === sorted.length - 1,
                onClick: () => moveCalendar(cal.id, 1),
            },
            { type: 'divider' },
            {
                label: 'Umbenennen',
                icon: _jsx(Edit3, { size: 14 }),
                onClick: () => setDialog({ kind: 'rename', cal }),
            },
            {
                label: 'Löschen',
                icon: _jsx(Trash2, { size: 14 }),
                danger: true,
                disabled: cal.isDefault === true,
                onClick: () => {
                    if (window.confirm(`Kalender „${cal.name}" wirklich löschen? Alle Termine werden entfernt.`)) {
                        deleteCal.mutate(cal.id);
                    }
                },
            },
        ];
    };
    return (_jsxs("aside", { className: "w-60 shrink-0 bg-gray-50 dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 flex flex-col", children: [_jsx("div", { className: "p-3", children: _jsxs("button", { onClick: onNewEvent, className: "btn-primary w-full justify-center", children: [_jsx(Plus, { size: 15 }), " Neuer Termin"] }) }), _jsx("div", { className: "px-3 mb-1", children: _jsxs("button", { onClick: () => setDialog({ kind: 'create' }), className: "w-full flex items-center gap-2 px-2 py-1.5 text-sm text-accent hover:bg-accent/10 rounded transition-all duration-150 active:scale-95", children: [_jsx(Plus, { size: 15, className: "transition-transform duration-150 group-hover:rotate-90" }), _jsx("span", { className: "font-medium", children: "Kalender hinzuf\u00FCgen" })] }) }), _jsxs("div", { className: "flex-1 overflow-y-auto px-1 pb-3", children: [_jsxs("button", { onClick: () => setExpanded(!expanded), className: "w-full flex items-center gap-1 mt-2 mb-1 px-2 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wide hover:text-gray-600 dark:hover:text-gray-300", children: [expanded ? _jsx(ChevronDown, { size: 12 }) : _jsx(ChevronRight, { size: 12 }), "Meine Kalender"] }), expanded && sorted.map((cal) => {
                        const isHidden = hiddenCalendarIds.includes(cal.id);
                        const Icon = cal.icon ? ICON_MAP[cal.icon] : null;
                        return (_jsxs("div", { className: "group flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors", children: [_jsx("button", { onClick: () => toggleCalendar(cal.id), className: "shrink-0 w-4 h-4 rounded-sm border-2 flex items-center justify-center transition-all duration-150 active:scale-90", style: {
                                        borderColor: cal.color,
                                        backgroundColor: isHidden ? 'transparent' : cal.color,
                                    }, "aria-label": isHidden ? 'Kalender anzeigen' : 'Kalender ausblenden', children: !isHidden && _jsx("span", { className: "text-[10px] text-white leading-none", children: "\u2713" }) }), Icon && _jsx(Icon, { size: 14, style: { color: cal.color }, className: "shrink-0" }), _jsx("span", { className: "flex-1 text-sm text-gray-700 dark:text-gray-200 truncate", children: cal.name }), _jsx("button", { onClick: (e) => {
                                        e.stopPropagation();
                                        const r = e.currentTarget.getBoundingClientRect();
                                        setMenu({ x: r.left, y: r.bottom, items: buildMenu(cal) });
                                    }, className: "opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 transition-all duration-150 active:scale-90", "aria-label": "Optionen", children: _jsx(MoreHorizontal, { size: 14 }) })] }, cal.id));
                    })] }), menu && _jsx(ContextMenu, { x: menu.x, y: menu.y, items: menu.items, onClose: () => setMenu(null) }), dialog?.kind === 'create' && (_jsx(PromptDialog, { title: "Neuer Kalender", label: "Name", placeholder: "z. B. Privat, Sport, Reisen", confirmText: "Erstellen", onCancel: () => setDialog(null), onConfirm: async (name) => {
                    await createCal.mutateAsync({ name, color: COLOR_PALETTE[Math.floor(Math.random() * COLOR_PALETTE.length)] });
                    setDialog(null);
                } })), dialog?.kind === 'rename' && (_jsx(PromptDialog, { title: "Kalender umbenennen", label: "Neuer Name", initialValue: dialog.cal.name, confirmText: "Speichern", onCancel: () => setDialog(null), onConfirm: async (name) => {
                    if (name === dialog.cal.name) {
                        setDialog(null);
                        return;
                    }
                    await patchCal.mutateAsync({ id: dialog.cal.id, body: { name } });
                    setDialog(null);
                } }))] }));
}
