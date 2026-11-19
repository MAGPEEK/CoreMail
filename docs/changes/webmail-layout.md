## webmail-layout — new webmail layout (floating panes, ribbon, backgrounds)

SemVer: MINOR (additive schema, new routes and preference fields; nothing removed from the API).

### Added
- Webmail: floating panes — the app body below the top bar is a canvas; the ribbon, the message
  list and the reading pane (or the compose card) are rounded cards with 8 px gaps, the folder pane
  sits on the canvas (a translucent card over a picture). The resize handles are the gaps between
  the cards. Below 768 px the single-pane flow stays full width without gaps.
- Webmail: background pictures (Einstellungen → Darstellung → Hintergrund) — "Keiner", eight
  built-in pictures drawn by CoreMail (Bergsee bei Nacht, Morgendämmerung, Wald, Küste, Dünen,
  Wellen, Polarlicht, Neutral; light and dark variants) and "Eigenes Bild hochladen…" (JPEG / PNG up
  to 5 MB, re-encoded by the server, metadata removed). Tiles preview the picture live on hover /
  focus. Panes over a picture are 92 % opaque with a light blur; text contrast stays AA.
- API: `GET/PUT/DELETE /api/v1/user/background`, `GET /api/v1/user/background/info` (own picture
  only, ETag + private cache). Roaming preferences `appearance.background`, `ribbon.collapsed`,
  `ribbon.layout`, `folders.favorites`.
- BCP → Branding: "Standard-Hintergrund" — the background of users without an own choice (none or a
  built-in picture; `defaultBackground` in the branding API).
- Webmail ribbon: tab row "Start | Ansicht | Hilfe" with the layouts "Vereinfacht" / "Klassisch"
  (simplified below 1100 px) and a collapse chevron. Start: Neue E-Mail (split: E-Mail, E-Mail aus
  Vorlage when a template source is wired in, Ereignis), Löschen (split: Endgültig löschen),
  Archivieren, Verschieben in (recent folders + "Anderer Ordner …"), Junk-E-Mail, Antworten, Allen
  antworten, Weiterleiten, Alle als gelesen markieren, Gelesen/Ungelesen, Kategorisieren,
  Kennzeichnen, Drucken, Rückgängig. Ansicht: Ansichtseinstellungen, Unterhaltungen, Sortierung,
  Layout (reading pane), Dichte, Synchronisieren. Hilfe: Tastenkürzel, "Über CoreMail" (version).
- Webmail ribbon contextual tabs while a draft is shown: "Nachricht | Einfügen | Text formatieren |
  Optionen" (announced; selected when a draft opens, back to Start when it goes) — the compose
  card's own commands (formatting, attachments, signature, Senden planen, importance, receipts,
  message options, plain text / HTML); the card then keeps only Senden, the status and close.
- "Neue E-Mail → Ereignis" opens the calendar's event dialog in the mail view.
- Message list: collapsible date groups "Heute", "Gestern", "Diese Woche", "Letzte Woche", "Dieser
  Monat", "Älter" (date order without conversations; sticky headers; collapsed per folder for the
  session; keyboard: arrows reach the headers, Enter / Space / ← / → toggle); days count in the
  time zone of Settings → Region, weeks start as in Settings → Kalender.
- Folder pane: "Favoriten" (default Posteingang, Gesendete Elemente, Entwürfe, Gelöschte Elemente;
  "Zu Favoriten hinzufügen / entfernen" in the folder menu, roaming); the own mailbox section is
  headed by the user's address.

### Changed
- Unread messages: a 3 px accent bar on the left, subject and time in the accent colour (the pulsing
  dot is gone).
- Compose: opens with a short slide / fade (off with reduced motion); "Senden" stays usable without
  a recipient and explains what is missing (focus goes to "An"), and gets a soft ring once a
  recipient is there; placeholder "Nachricht verfassen …"; "Später senden …" is "Senden planen …"
  again.
- Settings: "Design" is now "Darstellung"; the settings page floats as a card on the canvas.
- Modal dialogs render into `<body>` (a blurred pane would otherwise trap their fixed overlay).
- Folder favourites flagged before 10.1 (`Folder.isFavorite`) still show; removing one clears the flag.

### Notes
- Schema (additive): `User.backgroundKey`, `User.backgroundUpdatedAt`, `Branding.defaultBackground`
  (default `"none"`).
- Profile photo storage now shares `storage/src/user-image-store.ts` with the background (no
  behaviour change).
