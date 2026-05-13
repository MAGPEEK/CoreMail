import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import deLocale from '@fullcalendar/core/locales/de';
import { Plus, X } from 'lucide-react';
import { api } from '../api/client.js';
import toast from 'react-hot-toast';
export function CalendarPage() {
    const qc = useQueryClient();
    const [newEvent, setNewEvent] = useState(null);
    const { data: calendars } = useQuery({
        queryKey: ['calendars'],
        queryFn: () => api.get('/calendar'),
    });
    const { data: events } = useQuery({
        queryKey: ['calendar-events'],
        queryFn: () => api.get('/calendar/events?start=2020-01-01&end=2030-12-31'),
    });
    const createMutation = useMutation({
        mutationFn: (data) => api.post('/calendar/events', data),
        onSuccess: () => {
            toast.success('Termin erstellt');
            qc.invalidateQueries({ queryKey: ['calendar-events'] });
            setNewEvent(null);
        },
        onError: (err) => toast.error(err.message),
    });
    const deleteMutation = useMutation({
        mutationFn: (id) => api.delete(`/calendar/events/${id}`),
        onSuccess: () => {
            toast.success('Termin gelöscht');
            qc.invalidateQueries({ queryKey: ['calendar-events'] });
        },
    });
    const handleDateSelect = (info) => {
        const calId = calendars?.[0]?.id ?? '';
        setNewEvent({
            summary: '',
            dtStart: info.startStr,
            dtEnd: info.endStr,
            calendarId: calId,
            allDay: info.allDay,
        });
    };
    const handleEventClick = (info) => {
        if (confirm(`Termin "${info.event.title}" löschen?`)) {
            deleteMutation.mutate(info.event.id);
        }
    };
    const fcEvents = (events ?? []).map((ev) => ({
        id: ev.id,
        title: ev.summary,
        start: ev.dtStart,
        end: ev.dtEnd,
        allDay: false,
        backgroundColor: calendars?.find((c) => c.id === ev.calendarId)?.color ?? '#0078D4',
        borderColor: 'transparent',
    }));
    return (_jsxs("div", { className: "flex flex-1 overflow-hidden", children: [_jsxs("aside", { className: "w-52 shrink-0 bg-gray-50 border-r border-gray-200 flex flex-col p-3 gap-3", children: [_jsxs("button", { onClick: () => setNewEvent({ summary: '', dtStart: '', dtEnd: '', calendarId: calendars?.[0]?.id ?? '', allDay: false }), className: "btn-primary w-full justify-center", children: [_jsx(Plus, { size: 15 }), " Neuer Termin"] }), _jsxs("div", { children: [_jsx("p", { className: "text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2", children: "Meine Kalender" }), (calendars ?? []).map((cal) => (_jsxs("div", { className: "flex items-center gap-2 py-1", children: [_jsx("span", { className: "w-3 h-3 rounded-sm shrink-0", style: { backgroundColor: cal.color } }), _jsx("span", { className: "text-sm text-gray-700", children: cal.name })] }, cal.id)))] })] }), _jsx("div", { className: "flex-1 overflow-auto p-4", children: _jsx(FullCalendar, { plugins: [dayGridPlugin, timeGridPlugin, interactionPlugin], initialView: "timeGridWeek", locale: deLocale, headerToolbar: { left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,timeGridDay' }, events: fcEvents, selectable: true, select: handleDateSelect, eventClick: handleEventClick, height: "100%" }) }), newEvent && (_jsx("div", { className: "fixed inset-0 bg-black/40 flex items-center justify-center z-50", children: _jsxs("div", { className: "bg-white rounded-lg shadow-2xl w-full max-w-md p-6", children: [_jsxs("div", { className: "flex items-center justify-between mb-4", children: [_jsx("h2", { className: "text-base font-semibold", children: "Neuer Termin" }), _jsx("button", { onClick: () => setNewEvent(null), className: "btn-ghost p-1", children: _jsx(X, { size: 16 }) })] }), _jsxs("div", { className: "space-y-3", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-gray-700 mb-1", children: "Titel" }), _jsx("input", { className: "input", value: newEvent.summary, onChange: (e) => setNewEvent({ ...newEvent, summary: e.target.value }), placeholder: "Terminbezeichnung" })] }), _jsxs("div", { className: "grid grid-cols-2 gap-3", children: [_jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-gray-700 mb-1", children: "Von" }), _jsx("input", { type: "datetime-local", className: "input", value: newEvent.dtStart.slice(0, 16), onChange: (e) => setNewEvent({ ...newEvent, dtStart: e.target.value }) })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-gray-700 mb-1", children: "Bis" }), _jsx("input", { type: "datetime-local", className: "input", value: newEvent.dtEnd.slice(0, 16), onChange: (e) => setNewEvent({ ...newEvent, dtEnd: e.target.value }) })] })] }), _jsxs("div", { children: [_jsx("label", { className: "block text-sm font-medium text-gray-700 mb-1", children: "Kalender" }), _jsx("select", { className: "input", value: newEvent.calendarId, onChange: (e) => setNewEvent({ ...newEvent, calendarId: e.target.value }), children: (calendars ?? []).map((c) => _jsx("option", { value: c.id, children: c.name }, c.id)) })] })] }), _jsxs("div", { className: "flex justify-end gap-2 mt-5", children: [_jsx("button", { onClick: () => setNewEvent(null), className: "btn-secondary", children: "Abbrechen" }), _jsx("button", { onClick: () => createMutation.mutate(newEvent), disabled: !newEvent.summary || !newEvent.dtStart || createMutation.isPending, className: "btn-primary disabled:opacity-50", children: createMutation.isPending ? 'Speichern...' : 'Speichern' })] })] }) }))] }));
}
