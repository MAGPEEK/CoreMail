### Removed

- **Webmail: the calendar scheduling assistant ("Terminplanungs-Assistent").** The event form no
  longer has the details / scheduling tab strip or the "Verfügbarkeit prüfen" link; it shows the
  details form directly. Removed with it: `components/calendar/SchedulingAssistant.tsx`,
  `lib/scheduling.ts` (+ test) and the webmail types `FreeBusyUser` / `ScheduleSuggestions`.
  The REST endpoints `POST /api/v1/calendar/freebusy` and `POST /api/v1/calendar/schedule-suggestions`
  are unchanged (other clients and the e2e suite still use them).
