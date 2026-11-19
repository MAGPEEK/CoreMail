## Changed

- Webmail: the compose area is redesigned. The inline compose is a raised card (rounded corners, border,
  soft shadow) on the tinted reading pane; the own window and phone widths keep the same layout without
  margin and shadow. "Senden" is now a split button in the header row (its chevron or Alt+Pfeil-unten opens
  Senden, Später senden, Wichtigkeit and Nachrichtenoptionen) and the only accent-filled control; the
  attach, picture and signature buttons are quiet icons, everything else moved into the "…" menu, and the
  bottom action bar is gone. The draft status, "In neuem Fenster öffnen" and "Verwerfen" sit at the right
  edge of the header. The address block has calmer 36 px rows with recipient chips that show an avatar,
  the editor uses 15 px type with lines of at most 72 characters, and the formatting bar is an inset strip
  at the bottom of the card (now also with Link and Emoji).
- Webmail: new roaming preference `compose.composeFormatBar` (default on) remembers whether the formatting
  bar is shown ("Formatleiste ausblenden / einblenden", also the "Aa" button). Additive: older clients and
  stored preferences get the default. The saved-draft status reads "Entwurf gespeichert 10:42"; the
  schedule entry is called "Später senden …".
