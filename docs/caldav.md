# CalDAV

`packages/caldav-server` (port 8082, proxied by the api-gateway under `/dav/`) serves the
calendars and — since 9.5 — the task list of every user. Clients find it through
`/.well-known/caldav` and the `_caldavs._tcp` SRV record ([clients.md](clients.md)); they log in
with Basic (an app password for MFA accounts) or a Bearer token.

```
/dav/principals/<id>/                  principal: calendar-home-set, calendar-user-address-set
/dav/calendars/<id>/                   calendar home
/dav/calendars/<id>/<calendar>/        a calendar (VEVENT), own or shared ("[Geteilt] …")
/dav/calendars/<id>/<calendar>/<x>.ics an event
/dav/calendars/<id>/tasks/             the task list (VTODO, 9.5)
/dav/calendars/<id>/tasks/<x>.ics      a task
```

Every collection answers `PROPFIND`, `REPORT` (`calendar-query`, `calendar-multiget`,
`sync-collection`), every object `GET` / `PUT` / `DELETE` with strong ETags and `If-Match` /
`If-None-Match`. Sync tokens are collection tags (member count + newest change): an unchanged
token answers "no changes", an outdated one `403 DAV:valid-sync-token`, after which the client
resyncs in full (no tombstones are kept).

Access: the CalDAV/CardDAV protocol switch ([protocol-access.md](protocol-access.md)) and the
webmail modules ([webmail-policies.md](webmail-policies.md)). With the calendar module off the
calendars answer 403; with the tasks module off the task list answers 403. The calendar home stays
open while either module is on and lists only what is on.

## Task list (VTODO)

One task list per user, `/dav/calendars/<id>/tasks/` (display name "Aufgaben",
`supported-calendar-component-set` VTODO, `max-resource-size` 1 MiB). Its tasks are the user's
`Task` rows — the same tasks the webmail and `/api/v1/tasks` show. Apple Reminders, Thunderbird and
DAVx⁵ (jtx Board, Tasks.org) list it next to the calendars. The path segment `tasks` is reserved
in every spelling (`Tasks`, percent-encoded): `MKCALENDAR` on it answers 405; no other task lists
can be created. A calendar created over CalDAV under that name before 9.5 is no longer listed in
the calendar home (its path is the task list now; it stays usable in the webmail).

Code: `caldav-server/src/caldav/tasks.ts` (routes), `vtodo.ts` (mapping, pure),
`storage/src/task-store.ts` (writes shared with REST), `auth.ts` `davFeatureGate` (module switch).

### Mapping

| VTODO | Task |
|-------|------|
| `SUMMARY` | `subject` (max. 500 characters) |
| `DESCRIPTION` | `body` (plain text); a changed text clears the rich-text note `bodyHtml` |
| `STATUS` `NEEDS-ACTION` / `IN-PROCESS` / `COMPLETED` / `CANCELLED` | `NOT_STARTED` / `IN_PROGRESS` / `COMPLETED` / `DEFERRED` |
| `PERCENT-COMPLETE` | `percentComplete` |
| `COMPLETED` | `completedAt` (only with `STATUS:COMPLETED` or without `STATUS`) |
| `DTSTART` | `startDate` |
| `DUE` (or `DTSTART` + `DURATION`) | `dueDate` |
| `PRIORITY` 1–4 / 5 or none / 6–9 | `HIGH` / `NORMAL` / `LOW` (written as 1 / none / 9) |
| `CLASS` `PRIVATE` / `CONFIDENTIAL` | `isPrivate` |
| `RRULE` | `rrule` — `FREQ` `DAILY`, `WEEKLY`, `MONTHLY` or `YEARLY` only, anything else is refused |
| first `VALARM` (absolute, or relative to `DTSTART`, `RELATED=END`: `DUE`) | `reminder` (written as an absolute display alarm) |
| `UID` | `uid` (a webmail task's UID is its id) |

`WAITING` and `DEFERRED` have no iCalendar status: they are shown as `NEEDS-ACTION` (or
`IN-PROCESS` with a percentage) and stay as they are while a client sends that value back;
`CANCELLED` stays `CANCELLED` for a deferred task that came in cancelled. `NEEDS-ACTION` with a
percentage starts the task. Dates the webmail sets are days (UTC midnight) and are written as
`VALUE=DATE`; `DTSTART` and `DUE` always share one value type.

All status changes go through the task rules ([tasks.md](tasks.md#status-rules-storagesrctask-rulests)):
completing a recurring task — `STATUS:COMPLETED` on the task, or a `RECURRENCE-ID` override marked
completed — closes it (its `RRULE` is removed) and creates the next task, a new resource with its
own UID. Sending the completed task again (a retry, or the client's copy that still has the
`RRULE`) creates nothing and does not put the rule back; reopening it does. One task is one
occurrence: overrides are not stored.

### Round trip

The VTODO a client stored (`Task.icalData`, 9.5) is the base of every read: the task columns
replace what they map, everything else — `CATEGORIES`, `URL`, `X-` properties, further alarms,
time zones — comes back unchanged, and a property that already means the same as the column
(`PRIORITY:5`, a `DUE` with `TZID` at the same instant) is kept verbatim. `LAST-MODIFIED` moves when
a mapped property changed. A `PUT` answer carries the ETag only when the stored representation is
exactly what the client sent; otherwise the client fetches the task again.

### Preconditions

| Request | Answer |
|---------|--------|
| a `VEVENT` / `VJOURNAL` in the object | 403 `supported-calendar-component` |
| `METHOD`, several UIDs, only `RECURRENCE-ID` components, an unsupported `RRULE` | 403 `valid-calendar-object-resource` |
| more than 1 MiB | 403 `max-resource-size` |
| a UID another task of the user has | 409 `no-uid-conflict` (with its href) |
| a resource name taken by another user's task | neutral 409 |
| stale `If-Match`, `If-None-Match: *` on an existing task | 412 |

`calendar-query` evaluates `comp-filter VTODO` with a `time-range` (`DTSTART`/`DUE` span, due
date, completion date; tasks without dates match every range), `prop-filter` / `text-match` on the
rendered VTODO; a `VEVENT`-only query returns nothing.

Every write announces a realtime `tasks` event (`ids`: the task and, after a completion, the next
one), so the webmail updates at once.

Tests: `caldav-server/src/caldav/vtodo.test.ts`, `tasks.test.ts`, `auth.test.ts` (module switch);
e2e `scripts/e2e/steps/dav-tasks.mjs`.
