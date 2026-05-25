import { useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import deLocale from '@fullcalendar/core/locales/de';
import enLocale from '@fullcalendar/core/locales/en-gb';
import esLocale from '@fullcalendar/core/locales/es';
import itLocale from '@fullcalendar/core/locales/it';
import type { DateSelectArg, EventClickArg } from '@fullcalendar/core';
import { X } from 'lucide-react';
import { api } from '../api/client.js';
import type { Calendar, CalendarEvent, Task } from '../api/types.js';
import { useUiPrefs } from '../store/ui.js';
import { useLanguageStore } from '../store/language.js';
import { useT } from '../i18n/useT.js';
import { CalendarSidebar } from '../components/CalendarSidebar.js';
import { CalendarToolbar, type CalendarView } from '../components/CalendarToolbar.js';
import toast from 'react-hot-toast';

const LOCALE_MAP = { de: deLocale, en: enLocale, es: esLocale, it: itLocale };

interface NewEventForm {
  summary: string;
  dtStart: string;
  dtEnd: string;
  calendarId: string;
  allDay: boolean;
  classification: 'PUBLIC' | 'PRIVATE' | 'CONFIDENTIAL';
}

export function CalendarPage() {
  const qc = useQueryClient();
  const t = useT();
  const lang = useLanguageStore((s) => s.lang);
  const { calendarShowWeekNumbers, hiddenCalendarIds } = useUiPrefs();
  const [newEvent, setNewEvent] = useState<NewEventForm | null>(null);
  const [view, setView] = useState<CalendarView>('dayGridMonth');
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const calendarRef = useRef<FullCalendar | null>(null);

  const changeView = (v: CalendarView) => {
    setView(v);
    const fcApi = calendarRef.current?.getApi();
    if (!fcApi) return;
    if (v === 'workWeek') fcApi.changeView('timeGridWeek');
    else if (v === 'split') return;
    else fcApi.changeView(v);
  };

  const handleSelectDate = (d: Date) => {
    setSelectedDate(d);
    calendarRef.current?.getApi()?.gotoDate(d);
  };

  // hiddenDays/locale memoizen, damit FullCalendar nicht bei jedem Re-Render neue Props bekommt
  const hiddenDays = useMemo(() => (view === 'workWeek' ? [0, 6] : []), [view]);
  const fcLocale = useMemo(() => LOCALE_MAP[lang] ?? deLocale, [lang]);

  const { data: calendars } = useQuery({
    queryKey: ['calendars'],
    queryFn: () => api.get<Calendar[]>('/calendar'),
    // v3.18.17: SSE-Push via useMailEvents() invalidiert den Cache live —
    // 60s-Polling als Sicherheits-Fallback (falls SSE-Verbindung tot ist)
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    refetchInterval: 5 * 60_000,
  });

  const { data: events } = useQuery({
    queryKey: ['calendar-events'],
    queryFn: () => api.get<CalendarEvent[]>('/calendar/events?start=2020-01-01&end=2030-12-31'),
  });

  const { data: tasks } = useQuery({
    queryKey: ['tasks', 'all'],
    queryFn: () => api.get<Task[]>('/tasks'),
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

  // Default-Kalender für neue Events: bevorzugt eigener Default, dann erster eigener.
  // Geteilte READ-only Kalender niemals als Default verwenden.
  const defaultWritableCalId = useMemo(() => {
    const writable = (calendars ?? []).filter((c) => c.permission !== 'READ' && !c.shared);
    return writable.find((c) => c.isDefault)?.id ?? writable[0]?.id ?? '';
  }, [calendars]);

  const handleDateSelect = (info: DateSelectArg) => {
    setNewEvent({
      summary: '',
      dtStart: info.startStr,
      dtEnd: info.endStr,
      calendarId: defaultWritableCalId,
      allDay: info.allDay,
      classification: 'PUBLIC',
    });
  };

  const handleEventClick = (info: EventClickArg) => {
    if (info.event.id.startsWith('task-')) {
      toast(`Aufgabe: ${info.event.title.replace(/^[✓📋] /, '')}`, { icon: '📋' });
      return;
    }
    // Permission-Check: Event darf nur in WRITE/OWNER-Kalendern gelöscht werden
    const eventCalId = (info.event.extendedProps as { calendarId?: string })?.calendarId;
    const cal = (calendars ?? []).find((c) => c.id === eventCalId);
    if (cal && cal.permission === 'READ') {
      toast.error(t('cal_share_no_write_perm'));
      return;
    }
    if (confirm(`Termin "${info.event.title}" löschen?`)) {
      deleteMutation.mutate(info.event.id);
    }
  };

  const taskEvents = (tasks ?? [])
    .filter((t) => !!t.dueDate)
    .map((t) => ({
      id: `task-${t.id}`,
      title: (t.status === 'COMPLETED' ? '✓ ' : '📋 ') + t.subject,
      start: t.dueDate as string,
      allDay: true,
      backgroundColor: t.status === 'COMPLETED' ? '#9ca3af' : '#f59e0b',
      borderColor: 'transparent',
      textColor: '#ffffff',
      classNames: t.status === 'COMPLETED' ? ['opacity-60'] : [],
    }));

  const fcEvents = [
    ...(events ?? [])
      .filter((ev) => !hiddenCalendarIds.includes(ev.calendarId))
      .map((ev) => {
        const cal = calendars?.find((c) => c.id === ev.calendarId);
        const isReadOnly = cal?.permission === 'READ';
        return {
          id: ev.id,
          title: ev.summary,
          start: ev.dtStart,
          end: ev.dtEnd,
          allDay: false,
          backgroundColor: cal?.color ?? '#0078D4',
          borderColor: 'transparent',
          // READ-Shares: per-event editable=false (verhindert Drag/Resize)
          editable: !isReadOnly,
          startEditable: !isReadOnly,
          durationEditable: !isReadOnly,
          extendedProps: { calendarId: ev.calendarId, isReadOnly },
        };
      }),
    ...taskEvents,
  ];

  return (
    <div className="flex flex-1 overflow-hidden">
      <CalendarSidebar
        calendars={calendars ?? []}
        selectedDate={selectedDate}
        onSelectDate={handleSelectDate}
      />

      {/* Hauptbereich: Toolbar + FullCalendar */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <CalendarToolbar
          view={view}
          onChangeView={changeView}
          onNewEvent={() => setNewEvent({
            summary: '',
            dtStart: '',
            dtEnd: '',
            calendarId: defaultWritableCalId,
            allDay: false,
            classification: 'PUBLIC',
          })}
          onShare={() => toast('Wähle einen Kalender und klicke Teilen über das ⋯-Menü', { icon: 'ℹ️' })}
          onPrint={() => window.print()}
        />

        <div className="flex-1 overflow-auto p-4">
          <FullCalendar
            ref={calendarRef}
            plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
            initialView="dayGridMonth"
            locale={fcLocale}
            weekNumbers={calendarShowWeekNumbers}
            weekNumberCalculation="ISO"
            weekText={t('cw_short')}
            firstDay={1}
            hiddenDays={hiddenDays}
            headerToolbar={{ left: 'prev,next today', center: 'title', right: '' }}
            events={fcEvents}
            selectable
            select={handleDateSelect}
            eventClick={handleEventClick}
            height="100%"
          />
        </div>
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
                  {(calendars ?? [])
                    .filter((c) => c.permission !== 'READ')
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}{c.shared ? ` (${t('cal_share_shared_by').replace('{name}', c.ownerDisplayName ?? c.ownerEmail ?? '?')})` : ''}
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('cal_event_classification')}</label>
                <select className="input" value={newEvent.classification}
                  onChange={(e) => setNewEvent({ ...newEvent, classification: e.target.value as 'PUBLIC' | 'PRIVATE' | 'CONFIDENTIAL' })}>
                  <option value="PUBLIC">{t('cal_event_class_public')}</option>
                  <option value="PRIVATE">{t('cal_event_class_private')}</option>
                  <option value="CONFIDENTIAL">{t('cal_event_class_confidential')}</option>
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
