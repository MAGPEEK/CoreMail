### Changed
- Webmail calendar layout: the grid sits in a rounded card on the page canvas, the calendar list on the canvas beside it.
- New navigation row above the grid: "Heute", previous/next and the month/year label, which opens a date picker to jump to any date.
- Calendar ribbon defined as pure data (`lib/calendarRibbon.ts`, tabs Start / Ansicht / Hilfe) and rendered through one adapter (`components/calendar/ribbonAdapter.tsx`): "Neues Ereignis" is a split button (Ereignis / E-Mail), the time scale (5–60 minutes), calendar settings and keyboard shortcuts are reachable from the ribbon.
- Calendar list groups are named "Meine Kalender" and "Freigegebene Kalender", are collapsible, use colour dots with checkbox semantics, and open their actions also by right click.

### Removed
- The disabled "Geteilte Ansicht" placeholder in the calendar ribbon.

No backend, API or schema change; no breaking change.
