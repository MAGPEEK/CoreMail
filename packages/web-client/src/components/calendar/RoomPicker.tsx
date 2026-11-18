import { useQuery } from '@tanstack/react-query';
import { DoorOpen, Users } from 'lucide-react';
import { api } from '../../api/client.js';
import type { EventAttendee, RoomAvailability } from '../../api/types.js';

/**
 * 9.4: rooms and resources of the user's domain for the chosen time — free or
 * booked — to add to the meeting. Saving books them (the room answers right
 * away; a busy room declines when it is set to decline conflicts).
 */
interface Props {
  startIso: string;
  endIso: string;
  /** Selected rooms (addresses). */
  selected: string[];
  /** Stored answers of the rooms of a saved meeting. */
  answers: EventAttendee[];
  uid?: string;
  disabled?: boolean;
  onToggle: (room: RoomAvailability, add: boolean) => void;
}

const DECLINE_REASON: Record<NonNullable<EventAttendee['reason']>, string> = {
  conflict: 'belegt',
  inactive: 'nicht buchbar',
  recurring: 'keine Serien erlaubt',
  'too-frequent': 'Serie wiederholt sich zu häufig',
  duration: 'Dauer zu lang',
  window: 'außerhalb des Buchungszeitraums',
};

export function RoomPicker({ startIso, endIso, selected, answers, uid, disabled, onToggle }: Props) {
  const valid = !!startIso && !!endIso && new Date(endIso) > new Date(startIso);
  const { data: rooms = [], isLoading } = useQuery({
    queryKey: ['calendar-rooms', startIso, endIso, uid ?? ''],
    queryFn: () => api.get<RoomAvailability[]>(`/calendar/rooms?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}${uid ? `&uid=${encodeURIComponent(uid)}` : ''}`),
    enabled: valid,
    staleTime: 15_000,
  });
  if (!valid || (!isLoading && rooms.length === 0)) return null;
  const isSelected = (r: RoomAvailability) => selected.some((e) => e.toLowerCase() === r.email.toLowerCase());
  const answerOf = (r: RoomAvailability) => answers.find((a) => a.email.toLowerCase() === r.email.toLowerCase());

  return (
    <div className="flex items-start gap-3">
      <DoorOpen size={18} className="text-fg-subtle mt-1 shrink-0" aria-hidden="true" />
      <fieldset className="flex-1 min-w-0" disabled={disabled}>
        <legend className="text-xs text-fg-subtle mb-1">Räume und Ressourcen</legend>
        <ul className="space-y-1 max-h-40 overflow-y-auto">
          {rooms.map((r) => {
            const on = isSelected(r);
            const answer = answerOf(r);
            const declined = answer?.partstat === 'DECLINED';
            return (
              <li key={r.id}>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox" checked={on} onChange={(e) => onToggle(r, e.target.checked)} className="rounded" />
                  <span className="truncate text-fg">{r.displayName}</span>
                  {r.capacity !== null && <span className="inline-flex items-center gap-0.5 text-xs text-fg-subtle"><Users size={11} aria-hidden="true" />{r.capacity}</span>}
                  {r.location && <span className="text-xs text-fg-subtle truncate">{r.location}</span>}
                  <span className={`ml-auto text-xs px-1.5 py-0.5 rounded ${r.available ? 'text-success-fg bg-success-bg' : 'text-danger-fg bg-danger-bg'}`}>
                    {r.available ? 'Verfügbar' : 'Belegt'}
                  </span>
                  {on && answer && (
                    <span className={`text-xs ${declined ? 'text-danger-fg' : 'text-fg-subtle'}`}>
                      {declined ? `Abgelehnt${answer.reason ? ` (${DECLINE_REASON[answer.reason]})` : ''}`
                        : answer.partstat === 'ACCEPTED' ? 'Gebucht' : 'Wartet auf Bestätigung'}
                    </span>
                  )}
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>
    </div>
  );
}
