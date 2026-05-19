# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

> **Hinweis:** Aus Übersichtsgründen sind hier nur die drei jüngsten Releases gelistet.
> Die komplette Historie aller älteren Versionen ist über die git history einsehbar:
> `git log -p --follow CHANGELOG.md` oder über das GitHub-Repository.

---

## [Unreleased]

---

## [3.13.3] — 2026-05-19 — Drag&Drop REPARIERT + Shared-Mailbox-Permissions-UX

### Fixed

- **🐛 Dashboard-Drag funktionierte nicht** — der Refactor in v3.13.2 hatte `DraggableCard` als innere Funktion innerhalb von `DashboardPage` definiert
  - **Bug**: Bei jedem Re-Render von DashboardPage (z. B. nach `setCardDrag(id)` im dragStart-Handler) entsteht eine neue Funktion-Referenz für `DraggableCard`. React reconciliation sieht „neuen Komponenten-Typ" und unmountet/mountet alle Karten neu. Mid-Drag werden die DOM-Nodes vernichtet → laufender Drag bricht sofort ab
  - **Fix**: `DraggableCard` auf Modul-Ebene extrahiert (außerhalb von `DashboardPage`), nimmt drag state als Props (`cardDrag`, `cardHover`, `setCardDrag`, `setCardHover`, `order`, `moveWidget`)
- **🐛 Text-Selektion statt Drag** — wenn Mousedown auf Text-Inhalt der Karte erfolgte, startete Chrome/Firefox Text-Selektion statt Drag
  - **Fix**: `select-none` Klasse am Drag-Wrapper
- **🐛 Shared-Mailbox-Permissions ließen sich nicht hinzufügen** (`packages/admin-panel/src/pages/SharedMailboxesPage.tsx`)
  - User-Suche war case-sensitive (`u.email.includes(userSearch)`) — „stefan" matchte „Stefan@…" nicht
  - `<select size={4}>`-Listbox war verwirrend: ohne expliziten Klick blieb `userId` leer → „Hinzufügen"-Button blieb disabled, ohne Hinweis warum
  - **Fix**: case-insensitive Filter, ganze User-Liste einmalig geladen mit 60s `staleTime`, klickbare Listenelemente statt Listbox (`<button>`-basiert mit Akzent-Ring auf Selection), „Kein Benutzer gefunden"-Meldung in Amber, bereits berechtigte User werden in der Liste ausgeblendet (für Änderungen gibt's „Bearbeiten" am bestehenden Eintrag), `disabled`-Tooltip am Button erklärt warum er nicht klickbar ist, `type="button"` explizit gesetzt

### Notes

- Dies ist der canonical React-Anti-Pattern „Komponenten dürfen niemals innerhalb anderer Komponenten definiert werden", weil jede neue Funktion-Referenz von React als neuer Komponenten-Typ behandelt wird (Reconciliation per Reference Equality)
- Die Popover-Drag-Funktion war nicht betroffen — dort waren die Drag-Handler direkt auf `<div>`-Elementen, nicht in einer wrapping component

---

## [3.13.2] — 2026-05-19 — Dashboard-Drag&Drop direkt auf den Karten + Bugfixes

### Fixed

- **🐛 `moveWidget` Index-Shift-Bug** (`packages/admin-panel/src/store/dashboard.ts`)
  - Wenn `from < to`, schiebt `splice(from, 1)` alle nachfolgenden Indices um 1 runter — beim anschließenden `splice(to, 0, …)` wurde das Item dann eine Position zu weit hinten eingefügt
  - Fix: `insertAt = from < to ? to - 1 : to` korrigiert die Verschiebung. „Drop-vor-Index"-Semantik ist jetzt konsistent
- **🐛 Firefox-Drag brach sofort ab** — ohne `e.dataTransfer.setData(...)` in `dragStart` ignoriert Firefox den Drag
  - Fix: `setData('text/plain', widgetId)` + `effectAllowed = 'move'` gesetzt
- **🐛 Checkbox triggerte Drag** im Popover — Klick wurde als dragStart interpretiert
  - Fix: `onClick={(e) => e.stopPropagation()}` + `draggable={false}` an der Checkbox

### Added — Drag-and-Drop direkt auf den Dashboard-Karten

- **Karten in der Übersicht sind jetzt selber draggable** (`packages/admin-panel/src/pages/DashboardPage.tsx`)
  - Neue Hüllen-Komponente `DraggableCard` umschließt jede KPI- und Server-Widget-Karte
  - Drag-Cursor (`cursor-move`) + Tooltip „Per Drag verschieben"
  - Visuelles Feedback: Quelle wird halb-transparent + leicht skaliert (`opacity-40 scale-[0.98]`), Drop-Target bekommt Akzent-Ring (`ring-2 ring-accent ring-offset-2`)
  - Ring-Highlight erscheint nur bei Same-Group-Drops (KPI ↔ KPI, Server ↔ Server) — Cross-Group-Drag ist technisch erlaubt, modifiziert aber nur die relative Reihenfolge in der eigenen Section
- **End-of-list Drop-Zone im Popover** — ermöglicht „ans Ende ziehen" durch eine 12 px hohe Drop-Zone unter dem letzten Listenelement

### Changed

- **`moveWidget(from, to)`**: Drop-Semantik dokumentiert. `to === length` ist erlaubt = „ans Ende anhängen". Adjacent-No-Op (`from + 1 === to`) wird sauber abgefangen
- **`onDragOver`-Handler**: dropEffect explizit auf `'move'` gesetzt für korrekten Cursor

---

## [3.13.1] — 2026-05-18 — Info-Page schlanker (Top-3 + ohne Notes-Subtext)

### Changed

- **Info-Page**: Die „Letzte Versionen"-Karte zeigt jetzt nur noch die drei jüngsten Releases (statt der kompletten Historie). Pro Eintrag bleiben nur Version-Badge, Datum und Titel sichtbar — der ausführliche Notes-Text ist entfernt.
- **CHANGELOG.md**: ebenfalls auf die drei jüngsten Einträge gekürzt; ältere Releases bleiben über die git history erreichbar.
- **Info-Page „Changelog"-Resource-Karte**: Sub-Text „Keep a Changelog Format" entfernt.

### Fixed

- **`getAppVersion()`** liest jetzt `COREMAIL_VERSION`-Env **bevor** das root `package.json` als Fallback — erlaubt Runtime-Override des Version-Labels ohne Image-Rebuild.

---

> Ältere Releases (v3.13.0 und früher zurück bis v0.1) sind über `git log CHANGELOG.md`
> oder die [GitHub-Releases](https://github.com/MAGPEEK/CoreMail/releases) erreichbar.
