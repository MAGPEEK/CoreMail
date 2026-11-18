# w2-compose-outlook — changelog text (webmail compose)

SemVer: MINOR (webmail UI only; the server-draft, send, undo and schedule APIs are unchanged; no
config, schema or CLI change). The webmail route `/compose/<draftId>` is new.

### Added
- Webmail: new mails, replies, reply-all, forwards and "Entwurf bearbeiten" open in the reading
  pane instead of a floating box (reading pane off: in place of the message list; below 768 px full
  screen). Several drafts can be open: a tab strip at the bottom of the mail view switches between
  them (opening a mail in the list puts the shown draft into the strip, ✕ on a tab saves and closes
  it); every draft keeps its fields, attachments and autosave across switches.
- Webmail: "In neuem Fenster öffnen" moves a draft into a browser window of its own
  (`/compose/<draftId>`, loads the server draft). Sending there hands the mail to the main window
  (undo toast there); closing the window saves and returns the draft to the tab strip; closing the
  browser window with unsaved changes asks first.
- Webmail compose: command row with **Senden** (split: Senden / Senden planen …), **Verwerfen**,
  **Anhängen** (Datei / Bild) and "…" (Signatur, Lesebestätigung anfordern, Nur-Text-Format, Als
  Entwurf speichern, In neuem Fenster öffnen), ✕ to save and close.
- Webmail compose: ribbon with the tabs **Nachricht**, **Einfügen** and **Format** — font size,
  emoji picker, insert picture (also by pasting; raster images up to 500 KB), insert date/time in
  the regional format, link dialog with "Link entfernen", font / highlight colours by name.
- Webmail compose: recipients as pills with suggestions (click shows the full address, ✕ or
  Backspace removes one, pasted lists are split, invalid addresses are marked and stop the send
  before the server is asked); "Cc" / "Bcc" buttons right of the An row.
- Webmail compose: replies and forwards quote the original below a separator with Von / Gesendet /
  An / Cc / Betreff; a long reply quote is folded behind "…" (still sent).
- Webmail compose: files dropped anywhere on the compose area are attached (max. 10, the server
  limit); plain-text format can be switched per mail; "Entwurf gespeichert um HH:MM" above the body.
- Webmail: Esc saves the draft and closes it (asks only when it cannot be saved); the shortcut help
  lists Esc, Ctrl+B and Ctrl+I of the compose area.

### Changed
- Webmail: the floating compose window (bottom right, minimise bar) is removed.
- Webmail: a mail reopened after "undo send" while another mail is being written opens in the
  draft tab strip instead of waiting until that window is closed; `n` / Ctrl+N also start a new mail
  while one is open (the open one goes to the strip), and switch to Mail when pressed on another page.
- Webmail: menus of the command bars show toggles as checkable entries (`menuitemcheckbox`).

### Fixed
- Webmail: reply all kept only the sender and the original Cc — the original An recipients were
  dropped. It now addresses the sender + the original An (Cc: the original Cc) without the user's
  own address or the mailbox composed in; a reply to an own sent mail goes to its recipients.
- Webmail: after a page reload the compose did not know the user's own address (sender label,
  reply-all lists); it is read from the profile when the session has none.
