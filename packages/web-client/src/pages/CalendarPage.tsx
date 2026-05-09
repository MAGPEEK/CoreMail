import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import deLocale from '@fullcalendar/core/locales/de';
import type { DateSelectArg, EventClickArg } from '@fullcalendar/core';
import { Plus, X } from 'lucide-react';
import { api } from '../api/client.js';
import type { Calendar, CalendarEvent } from '../api/types.js';
import toast from 'react-hot-toast';

interface NewEventForm {
  summary: string;
  dtStart: string;
  dtEnd: string;
  calendarId: string;
  allDay: boolean;
}

export function CalendarPage() {
  const qc = useQueryClient();
  const [newEvent, setNewEvent] = useState<NewEventForm | null>(null);

  const { data: calendars } = useQuery({
    queryKey: ['calendars'],
    queryFn: () => api.get<Calendar[]>('/calendar'),
  });

  const { data: events } = useQuery({
    queryKey: ['calendar-events'],
    queryFn: () => api.get<CalendarEvent[]>('/calendar/events?start=2020-01-01&end=2030-12-31'),
  });

  const createMutation = useMutation({
    mutationFn: (data: NewEventForm) => api.post('/calendar/events', data),
    onSuccess: () => {
      toast.success('Termin erstellt');
      qc.invalidateQueries({ queryKey: ['calendar-events'] });
      setNewEvent(null);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/calendar/events/${id}`),
    onSuccess: () => {
      toast.success('Termin gelöscht');
      qc.invalidateQueries({ queryKey: ['calendar-events'] });
    },
  });

  const handleDateSelect = (info: DateSelectArg) => {
    const calId = calendars?.[0]?.id ?? '';
    setNewEvent({
      summary: '',
      dtStart: info.startStr,
      dtEnd: info.endStr,
      calendarId: calId,
      allDay: info.allDay,
    });
  };

  const handleEventClick = (info: EventClickArg) => {
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

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Sidebar */}
      <aside className="w-52 shrink-0 bg-gray-50 border-r border-gray-200 flex flex-col p-3 gap-3">
        <button onClick={() => setNewEvent({ summary: '', dtStart: '', dtEnd: '', calendarId: calendars?.[0]?.id ?? '', allDay: false })}
          className="btn-primary w-full justify-center">
          <Plus size={15} /> Neuer Termin
        </button>

        <div>
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Meine Kalender</p>
          {(calendars ?? []).map((cal) => (
            <div key={cal.id} className="flex items-center gap-2 py-1">
              <span className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: cal.color }} />
              <span className="text-sm text-gray-700">{cal.name}</span>
            </div>
          ))}
        </div>
      </aside>

      {/* Calendar */}
      <div className="flex-1 overflow-auto p-4">
        <FullCalendar
          plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
          initialView="timeGridWeek"
          locale={deLocale}
          headerToolbar={{ left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,timeGridDay' }}
          events={fcEvents}
          selectable
          select={handleDateSelect}
          eventClick={handleEventClick}
          height="100%"
        />
      </div>

      {/* New event dialog */}
      {newEvent && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-2xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold">Neuer Termin</h2>
              <button onClick={() => setNewEvent(null)} className="btn-ghost p-1"><X size={16} /></button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Titel</label>
                <input className="input" value={newEvent.summary}
                  onChange={(e) => setNewEvent({ ...newEvent, summary: e.target.value })} placeholder="Terminbezeichnung" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Von</label>
                  <input type="datetime-local" className="input" value={newEvent.dtStart.slice(0, 16)}
                    onChange={(e) => setNewEvent({ ...newEvent, dtStart: e.target.value })} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Bis</label>
                  <input type="datetime-local" className="input" value={newEvent.dtEnd.slice(0, 16)}
                    onChange={(e) => setNewEvent({ ...newEvent, dtEnd: e.target.value })} />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Kalender</label>
                <select className="input" value={newEvent.calendarId}
                  onChange={(e) => setNewEvent({ ...newEvent, calendarId: e.target.value })}>
                  {(calendars ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => setNewEvent(null)} className="btn-secondary">Abbrechen</button>
              <button
                onClick={() => createMutation.mutate(newEvent)}
                disabled={!newEvent.summary || !newEvent.dtStart || createMutation.isPending}
                className="btn-primary disabled:opacity-50"
              >
                {createMutation.isPending ? 'Speichern...' : 'Speichern'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
