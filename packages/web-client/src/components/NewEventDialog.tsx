/**
 * 10.1: "Neue E-Mail → Ereignis" in the mail view — the calendar's own event
 * dialog (EventEditDialog, a modal) in create mode, without leaving the mail.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import type { Calendar } from '../api/types.js';
import { defaultWritableCalendarId } from '../lib/calendarPrefs.js';
import { EventEditDialog } from './EventEditDialog.js';

export function NewEventDialog({ onClose }: { onClose: () => void }) {
  const { data: calendars } = useQuery({
    queryKey: ['calendars'],
    queryFn: () => api.get<Calendar[]>('/calendar'),
  });
  if (!calendars) return null;
  const calendarId = defaultWritableCalendarId(calendars);
  return (
    <EventEditDialog
      eventId={null}
      defaults={{ calendarId }}
      calendars={calendars}
      defaultWritableCalendarId={calendarId}
      onClose={onClose}
    />
  );
}
