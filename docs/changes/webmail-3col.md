# Webmail: three columns (target 10.7.0, MINOR)

Changelog fragment — merge into `CHANGELOG.md` under the 10.7.0 heading. Spec:
`docs/plans/webmail-three-columns.md`. No user-facing function was removed; every former ribbon /
top-bar command and its new place is listed in `packages/web-client/src/lib/commandPlacement.ts`
(checked by `commandPlacement.test.ts`).

### Changed
- **Webmail layout**: the top bar and every ribbon (mail, calendar, contacts, the compose contextual
  tabs) are gone. The window is the app rail plus three separate rounded cards with gaps — folders,
  message list, content (reading pane or compose). Background pictures, resizers, keyboard shortcuts,
  roving focus, drag and drop, deep links, the compose pop-out and undo toasts are unchanged.
- **App rail**: brand logo mark at the top, the apps, and at the bottom the notifications bell, the
  settings gear and the avatar with the profile menu (name / e-mail, Weiteres Postfach öffnen,
  Tastenkombinationen, Über CoreMail, Abmelden — open drafts are saved first). Below 768 px the rail
  stays the bottom bar; bell and settings are entries of the avatar menu there.
- **Folder card**: "Neue E-Mail" split button at the top (E-Mail, E-Mail aus Vorlage, Ereignis,
  E-Mail aus dem eigenen Postfach); every folder row has a "…" button (hover / focus) that opens the
  folder context menu (also the context-menu key / Shift+F10).
- **List card**: header with folder name + unread count, Sync and an Ansicht menu (Unterhaltungen,
  Sortieren, Lesebereich, Dichte, Alle als gelesen markieren, Weitere Ansichtseinstellungen); the only
  search field of the webmail (scope Ordner / Alle, suggestions, operator help, chips; `/` focuses it —
  from another page it opens the mail view; `/mail?q=` still searches the whole mailbox); filter row
  that becomes a **selection bar** while messages are checked (Löschen + endgültig löschen,
  Archivieren, Verschieben, Junk / Kein Junk, Gelesen / Ungelesen, Markieren + Nachverfolgung,
  Kategorisieren, Anheften, Zurückstellen, Rückgängig, Auswahl aufheben); a status line with the
  count, the selection and a sort-direction toggle. Rows show a one-line preview as third line when
  the list API sends one.
- **Content card**: reader action row — Antworten (outlined primary), Allen antworten, Weiterleiten;
  icons Archivieren, Verschieben (recent folders), Kategorisieren, Markieren (Nachverfolgung),
  Löschen; "…" with Gelesen / Ungelesen, Anheften, Zurückstellen, Junk / Kein Junk, Drucken,
  Quelltext, Als EML herunterladen, Regel erstellen, Rückgängig. The open drafts are tabs at the top of
  the card; the compose card always shows its full header (the former contextual ribbon commands are
  in the Senden menu, the "…" menu, the formatting bar and its flyout).
- **Kalender**: "Neuer Termin" at the top of the calendar list card; the grid card has one toolbar
  row (Heute, ‹ ›, period, Tag / Arbeitswoche / Woche / Monat, Zeitskala, Filter, Tagesagenda,
  Freigeben, Drucken, "…" → Kalender-Einstellungen).
- **Kontakte**: "Neu" split button (Kontakt / Kontaktliste) in the folder card, search + sort
  (Vorname / Nachname) in the list header, action row Bearbeiten, E-Mail, Anrufen, Kategorisieren,
  Löschen in the details card.
- **MFA banners** are a slim card at the top of the canvas.
- **Default accent colour is petrol** (`#006d77`; white text 6.1:1 on it, 5.0:1 as text on every light
  surface; dark accent text `110 184 190`), in the webmail, the BCP (identical theme tokens) and as the
  server-side branding default (`BRANDING_COLOR` unset). An accent chosen in BCP → Branding or by the
  user still wins; "Petrol" is the first accent preset of the webmail.

### Added
- **Notifications panel** behind the rail bell: the new mails (sender, subject — a click opens the
  message), task / event reminders and calendar shares received in this session; empty state
  "Keine neuen Benachrichtigungen" with a link to Settings → Benachrichtigungen; unread badge.
- Translations DE / EN / ES / IT for every new text of the shell.

### Deprecated
- Roaming preference `ribbon.collapsed`: still read tolerantly and accepted by PATCH, no longer used
  (no ribbon to collapse). Removal only in the next MAJOR.
