### Changed
- Webmail calendar: events are drawn by their "Anzeigen als" (show-as) value, Outlook style — "Beschäftigt" (and events without a value) stay a solid block in the calendar colour, "Mit Vorbehalt" is striped (diagonal stripes of the calendar colour over a light tint, solid left edge), "Frei" is outlined (surface background, border and left edge in the calendar colour), "Abwesend" is always purple with a dashed border, independent of the calendar colour. Mapping in `lib/calendarShowAs.ts`, styles `.cm-show-*` in `index.css`.
- The colour bar of the day agenda ("Tagesagenda") follows the same rule.
- Printed calendars show these events black on white; out-of-office keeps its dashed border.

No API, schema or breaking change: `GET /api/v1/calendar/events` already returned `showAs` per occurrence (now covered by a test).
