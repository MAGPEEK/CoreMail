### Added
- CalDAV task list: every user has a VTODO collection "Aufgaben" in the calendar home (`/dav/calendars/<id>/tasks/`), so Apple Reminders, Thunderbird and DAVx⁵ (jtx Board, Tasks.org) sync the webmail tasks in both directions — PROPFIND, REPORT (calendar-query with VTODO comp-filter and time-range, calendar-multiget, sync-collection), GET / PUT / DELETE with ETag / If-Match. Mapping of SUMMARY, DESCRIPTION, STATUS, PERCENT-COMPLETE, DTSTART, DUE, COMPLETED, PRIORITY, CLASS, RRULE and VALARM to the task form; unknown properties (CATEGORIES, X- properties …) round-trip. Writes use the task status rules (completing a recurring task creates the next one) and announce realtime `tasks` events. The webmail module "tasks" switches the list off (not listed, 403). See `docs/caldav.md`.
- Schema (additive): `Task.uid`, `Task.icalData` (unique `userId` + `uid`), `ResourceBooking.conflicts`.
- Resource bookings store the conflicting occurrences of a meeting (`conflicts`, up to 50): the reason of a decline, or the list that comes with an acceptance when the resource does not decline conflicts (event form and mail path; visible in `GET /api/v1/admin/resources/:id/bookings`).

### Changed
- The calendar home stays reachable while the tasks module is on even when the calendar module is off; it then lists only the task list (calendars keep answering 403).
- The room booking rules (policy decision, series expansion, conflict check under the booking lock) moved from the api-gateway to storage `resource-booking-rules.ts` and are shared by the event form and the invitation mail path; the conflict horizon is the booking window, at most one year.
- Task writes moved to storage `task-store.ts`, shared by the REST task routes and CalDAV (REST behaviour unchanged).

### Fixed
- Room invitations by mail: every occurrence of a recurring meeting is now checked for conflicts (EXDATE and moved occurrences applied, recurring bookings expanded, capped at 400 occurrences), the resource settings for series, maximum duration and booking window apply as in the event form, and TZID start times are no longer read as UTC.
- Room invitations by mail: a REQUEST that carries only moved occurrences updates the stored series, a CANCEL of single occurrences frees just those slots (EXDATE) instead of deleting the whole booking.

No breaking change (SemVer MINOR): no endpoint or protocol behaviour removed; the schema change is additive.
