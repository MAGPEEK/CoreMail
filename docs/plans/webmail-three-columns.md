# Webmail redesign: three columns (target 10.7.0, MINOR)

Status: approved by the user 2026-11-21. Goal: the webmail must not look like a well-known desktop
mail client any more. **No function is removed** — every command keeps at least one visible place
(plus its existing shortcut / context menu). Only the arrangement and the look change.

## Layout (≥ 1100 px, mode `three`)

```
┌──┐ ┌─────────────┐ ┌────────────────┐ ┌──────────────────────────────┐
│R │ │ 1 Folders   │ │ 2 List         │ │ 3 Content (read / compose)   │
│a │ │             │ │                │ │                              │
│i │ │             │ │                │ │                              │
│l │ └─────────────┘ └────────────────┘ └──────────────────────────────┘
└──┘   canvas with 8 px gaps, rounded cards (md:rounded-xl md:border) — as today
```

- **No top bar** (`TopBar.tsx` goes away) and **no ribbon** (`Ribbon.tsx`, `MailRibbon.tsx`,
  `CalendarToolbar` ribbon, `ContactsRibbon`). The canvas starts at the top of the window.
- **Rail (left, as today, `AppRail.tsx`)**: brand logo mark at the top, then Mail, Kalender,
  Kontakte, Aufgaben, Notizen (active item = accent tint square + bar). At the bottom of the rail:
  notifications bell, settings gear (→ /settings), avatar button with the profile menu. Below
  768 px the rail stays the bottom bar (bell/settings/avatar go into an avatar menu there).
- Three separate **cards with gaps** (keep `PANE_CANVAS_CLASS` gaps, `PANE_CARD_CLASS` radius,
  background pictures and `ON_PICTURE` translucency). Resizers between cards stay.

### Card 1 — folders (`FolderTree`)
- Top: **"Neue E-Mail" split button** (full width, primary accent; menu: E-Mail, E-Mail aus
  Vorlage, Termin, aus eigenem Postfach — today's New menu, `MailCommandBar.tsx:162-169`).
- Favourites, own mailbox tree, shared mailboxes — unchanged (incl. "+", context menus, hide).
- Folder rows get a "…" button on hover/focus that opens the **same** folder context menu
  (colour, permissions, retention, empty, recover, mark all read, rename, delete, favourite).
- Bottom: `QuotaIndicator` (unchanged).

### Card 2 — list (`MessageList`)
- Header row: folder name (+ unread count), **Sync** button (refetch folders + messages, toast),
  **Ansicht** button → popover with: Unterhaltungen (toggle), Sortieren (field + direction),
  Lesebereich (rechts / unten / aus), Dichte (kompakt / normal / bequem), Alle als gelesen markieren
  (folder), Drucken is NOT here.
- **Search field** (the only search field now; was TopBar global search + folder search): scope
  toggle Ordner | Alle, suggestions + recent searches (`SearchSuggestList`), operator help
  (`SearchOperatorsHelp`), chips. `/` focuses it; `/mail?q=` deep link still works (scope Alle).
- Filter row: select-all checkbox, chips Alle / Ungelesen / Markiert / Anhang, count.
- **Selection bar**: when ≥ 1 message is checked, it replaces the filter row: "N ausgewählt",
  Löschen (split: endgültig löschen), Archivieren, Verschieben (recent folders + Anderer Ordner…),
  Junk / Kein Junk, Gelesen/Ungelesen, Markieren (split: Nachverfolgung), Kategorisieren, Anheften,
  Zurückstellen, Rückgängig, Auswahl aufheben. Overflow "…" via `CommandBar` as today.
- Rows: three lines (sender + time, subject + icons/chips, one-line preview) — density still
  applies; date groups, hover quick actions, drag, context menu unchanged.
- **Status line** at the bottom: "N Nachrichten · M ausgewählt", sort field + direction toggle.

### Card 3 — content (`MessageReader` / `ComposePane`)
- Reader action row: **Antworten** (outlined primary), Allen antworten, Weiterleiten (icons with
  labels on wide cards); right side icons: Archivieren, Verschieben, Kategorisieren, Markieren,
  Löschen, "…" (Gelesen/Ungelesen, Anheften, Zurückstellen, Junk/Kein Junk, Drucken, Quelltext,
  Als EML herunterladen, Regel erstellen, Rückgängig). Banners, header, attachments, body unchanged.
- Empty state / multi-selection state unchanged.
- **Compose** opens in card 3 as today. Open drafts become **tabs at the top of card 3**
  (`DraftTabStrip` moves from the bottom of the mail view). The compose card always shows its full
  header (Send split, attach, image, signature, "Aa", "…", pop-out, discard, close) — the former
  contextual ribbon tabs (Nachricht / Einfügen / Text formatieren / Optionen) are covered by the
  send menu, the "…" menu and the format bar + its "more" flyout; add any command that only lived
  in those ribbon tabs to the compose "…" menu or the format-bar flyout (check
  `compose/composeRibbonTabs.tsx` item by item).

### Help, profile, notifications
- Avatar menu (rail): name/e-mail, Weiteres Postfach öffnen, Tastenkombinationen (`?`), Über
  CoreMail, Abmelden (saves drafts first, as today).
- Bell: opens a small panel with the recent realtime notifications already received this session
  (new mail with sender/subject → click opens it; calendar/task reminders if present); empty state
  "Keine neuen Benachrichtigungen" + link to Settings → Benachrichtigungen. (Today the bell has no
  handler.)

## Other modules (same rail + cards, no ribbon)
- **Kalender**: card 1 = "Neuer Termin" button, `MiniCalendar`, calendar list (as `CalendarSidebar`
  today); one wide card for the grid with its own toolbar row: Heute, ‹ ›, period label, Tag /
  Arbeitswoche / Woche / Monat, Zeitskala, Filter, Tagesagenda, Freigeben, Drucken, "…"
  (Kalender-Einstellungen). Day agenda pane stays a card on the right when on.
- **Kontakte**: card 1 = "Neu" split (Kontakt / Kontaktliste) + `ContactsSidebar`; card 2 = list
  with search + sort (Vorname/Nachname) in its header; card 3 = details with action row
  (Bearbeiten, E-Mail, Anrufen, Kategorisieren, Löschen).
- **Aufgaben / Notizen**: keep their current pages but drop the top bar; header row inside the
  card as today (no further change in this release).
- **Einstellungen**: unchanged card, no top bar.

## Look
- Default accent: **petrol** (replace the current blue default `#0078d4`); branding accent still
  wins. Choose light/dark values that meet WCAG 2.2 AA (text on accent ≥ 4.5:1, accent text on
  surface ≥ 4.5:1) — check with `theme/contrast.ts` and keep web-client + admin-panel
  `theme/tokens.css` identical (theme tests). The `--header*` tokens may stay but are unused by the
  webmail shell.
- Rows, chips and buttons keep the existing token classes; no new hard-coded colours.

## Responsive
- `two` mode (768–1099): rail + list card + content card; folders card becomes the drawer
  (button in the list header) — as today.
- `single` mode (≤ 767): one card at a time with back button; the selection bar and the reader
  "…" give every command; sort / sync / print reachable (they were missing below 768 px).

## Preferences
- `ribbon.collapsed` is no longer used: keep it in the roaming field table (tolerant read), mark
  it deprecated in `lib/user-preferences.ts` and `web-client/src/lib/preferences.ts`.
- `readingPane`, `density`, conversations, sort, favourites, widths: unchanged.

## Must not break
- Keyboard shortcuts (all sets), roving focus, ARIA landmarks/labels (rail `nav`, cards `region`
  with labels), skip link, screen-reader announcements, drag-and-drop, deep links, compose
  pop-out, undo toasts, MFA banners (they move into the canvas top as a slim card).
- Theme guard / contrast tests, i18n DE/EN/ES/IT for every new string.
- No vendor names in texts.
