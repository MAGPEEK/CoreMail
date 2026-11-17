# w1-webmail-layout — changelog text (webmail phase 3)

SemVer: MINOR (UI only, no API, config or schema change).

### Added
- Webmail: app rail on the left (Mail, Kalender, Kontakte, Aufgaben, Notizen; Einstellungen at the
  end) with tooltips on hover/focus (Escape hides them), `aria-current` and arrow-key navigation;
  below 768 px it becomes a bottom bar with visible captions. It replaces the text tabs in the header.
- Webmail: mail command bar above the message list and reading pane — "Neue E-Mail" (split button;
  in a shared mailbox the compose window offers the From choice, the menu also starts a mail from the
  own mailbox), Löschen, Archivieren, Verschieben, Junk / Kein Junk, Kennzeichnen, Gelesen /
  Ungelesen, Kategorisieren, Anheften, Rückgängig and Ansicht (reading pane, density, conversations).
  It acts on the checked messages or the open one and replaces the multi-select bar; commands that do
  not fit move into a "…" menu. Read-only shared mailboxes show the commands disabled with the reason.
- Webmail: reading-pane action bar — Antworten, Allen antworten, Weiterleiten as buttons; Drucken,
  Quelltext, EML, Regel erstellen, Gelesen/Ungelesen, Kennzeichnen, Anheften, Schlummern,
  Verschieben (folder dialog), Archivieren, Junk and Löschen under "…".
- Webmail: shared page frame (title row, gutters, content padding) for Mail, Kalender, Kontakte,
  Aufgaben and Notizen.

### Changed
- Webmail header: logo and product name left, the search centred (with the search-operator help
  next to it, `/` still focuses it), notifications, settings and profile right.
- Calendar ribbon now uses the shared command bar (same keyboard behaviour and "…" overflow).
- Toolbars follow the toolbar keyboard pattern: one tab stop, ←/→ between commands, Home/End;
  menus opened from a toolbar take focus and support ↑/↓, → into submenus and ← back.

### Fixed
- Webmail: the task list scrolls when it is longer than the window.
