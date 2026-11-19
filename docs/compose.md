# Webmail compose

Since 9.4 the webmail writes mails in the reading pane (inline), like the big web mail clients do:
new mail, reply, reply all and forward open in place of the reader, several drafts can be open at
the same time (tab strip at the bottom of the mail view) and a draft can move into a window of its
own. The floating box at the bottom right of the screen (pre-9.4) is gone.

This page lists every function of the old compose window (nothing may get lost), then describes the
new model, the code layout and the tests.

## 1. Inventory of the pre-9.4 compose window

`packages/web-client/src/components/ComposeWindow.tsx` (removed in 9.4) — one floating
880 × 78 vh box at the bottom right, one compose at a time. Every row says where the behaviour lives
now.

| # | Function (pre-9.4) | 9.4 |
|---|--------------------|-----|
| 1 | Floating window bottom right with a title bar (subject or "Neue Nachricht"), **Minimieren** (288 px bar, saves the draft) and **Schließen** (saves the draft, toast "Entwurf gespeichert") | Inline in the reading pane; **Schließen** (✕, Esc) saves and closes, minimising = switching to another draft or opening a mail (tab strip) |
| 2 | Only one compose at a time; a mail reopened after "undo send" waited until the open window was closed ("send_compose_busy") | Several drafts open; a reopened mail opens as a new draft tab (in the background when another draft is being written) |
| 3 | `role="dialog"` named after the subject, `data-shortcut-scope="compose"` (global shortcuts off inside) | `role="region"` named "Nachricht verfassen: <subject>", same shortcut scope |
| 4 | **Von** select, only when there is a choice: shared mailbox with SEND_AS / FULL_ACCESS (send as) or SEND_ON_BEHALF (on behalf), default the shared identity; a reopened draft's sender is added to the options | Unchanged (`lib/mailboxContext.ts senderOptions`), field visibility rule `composeFieldVisibility` |
| 5 | **An** with autocomplete: comma-separated text, `/contacts?q=` from 1 character (220 ms debounce), max. 8 suggestions (initial, name, address, company), ↑/↓, Enter/Tab picks, Esc closes, outside click closes | Recipient pills (`RecipientField`): typed text becomes a pill on `,` `;` Enter Tab or blur, pasted lists are split, duplicates dropped, invalid addresses marked; same suggestions as an ARIA combobox |
| 6 | **CC** / **BCC** text buttons right of the An row; Cc shown for reply all with Cc, Bcc hidden by default; the revealed field gets focus | "Cc" / "Bcc" buttons right of the An row, same rules, field gets focus |
| 7 | **Betreff**; reply adds "Re: ", forward "Fwd: " unless the subject already starts with Re:/Fwd:/AW:/WG: | Unchanged (`lib/composeQuote.ts subjectFor`) |
| 8 | Formatting toolbar (hidden in plain-text format): undo/redo, paragraph style (Normal, Überschrift 1–3, Codeblock), font (8), bold/italic/underline/strike, text colour (24 + remove), highlight (12 + remove), link (prompt; http/https/mailto only, empty removes), align left/centre/right/justify, bullet/numbered list, indent −/+, quote, inline code, horizontal line, clear formatting | Formatting toolbar below the body + its chevron flyout (all of these plus font size steps, superscript/subscript, text direction, table, image); emoji, image and date/time in the action bar (the 9.4 ribbon tabs were replaced by the refine) |
| 9 | Editor: Tiptap StarterKit, underline, link (no open on click), text align, text style, colour, highlight (multicolour), font family, font size, inline images incl. data: URIs, signature block | Unchanged (`hooks/useComposeEditor.ts`) plus the quote marker; paste of an image file inserts it |
| 10 | Body start: empty line, signature block (default per identity and kind new/reply), quoted original — reply: "Am <date> schrieb <from>:", forward: "Weitergeleitete Nachricht von <from>"; original sanitised (`quoteMailHtml`), text originals escaped; caret at the start; default font/size of Settings → Verfassen | Quote header block **Von / Gesendet / An / Cc / Betreff** below a separator line (`lib/composeQuote.ts`); long reply quotes are folded behind "…" |
| 11 | Signature swap on a sender change while the block is unchanged (`mayAutoSwapSignature`); signature picker (named signatures, "Keine Signatur"), also in plain-text format | Unchanged; picker **Signatur einfügen** in the action bar |
| 12 | Reply/forward load the original (`['message', id]`, `markRead=false`, the compose mailbox): threading (In-Reply-To / References, internal id fallback); forward attaches the original attachments as files (toast for the ones that failed) | Unchanged (`hooks/useComposeOriginal.ts`) |
| 13 | Reopened draft keeps its threading headers, sender, attachments, body | Unchanged |
| 14 | Attachments: file picker (multiple), chips with name / size / remove, counter badge on the button | Chips above the body; **Anhängen** (file / image), drag & drop on the whole compose area, max. 10 (the server limit) |
| 15 | Read receipt checkbox, shown and pre-set by Settings → Lesen | "…" → **Nachrichtenoptionen** → **Lesebestätigung anfordern** (same rule) |
| 16 | Discard (trash) with confirmation: waits for a running save, deletes the server draft, toast | **Verwerfen** (same) |
| 17 | Save status as live region: Speichert… / Gespeichert HH:MM / Entwurf nicht gespeichert / Wird bereits gesendet; spinner while a draft loads | "Entwurf gespeichert um HH:MM" line above the body, same live region |
| 18 | Server draft autosave (3 s idle; flush on minimise / close / send), reopen, locked (being/already sent) stops saving, superseded retried, 404 recreated, attachment ids merged after each save (toast for lost ones) | Unchanged (`lib/draft-autosave.ts`, `lib/draft-api.ts`); the saver of a draft survives switching tabs (`lib/composeRuntime.ts`) |
| 19 | Logout saves pending changes first (`registerComposeFlush`) | Unchanged, for every open draft (also the ones in the tab strip) |
| 20 | Send: needs An; forgotten-attachment check (confirm); undo hold via `queueHeldSend` (countdown toast, `z` undoes, server holds the mail, failure reopens everything written) | Unchanged; additionally invalid addresses stop the send before the server is asked |
| 21 | Schedule send: arrow menu with Morgen früh (8:00), Morgen nachmittags (13:00), Nächsten Montag (8:00) and a date/time field (≥ 30 s in the future); toast "Versand geplant für …" | **Senden ▾ → Senden planen …** popover, same presets and rule (`lib/composeRules.ts schedulePresets`) |
| 22 | Ctrl/⌘+Enter sends | Unchanged; Esc saves and closes; listed in the shortcut help |
| 23 | Plain-text format (Settings → Verfassen): toolbar hidden, only the text is sent | Default from the setting, switchable per mail ("…" → **Zu Nur-Text wechseln** / **Zu HTML wechseln**); formatting toolbar hidden |
| 24 | Busy states (forward attachments loading, draft loading, scheduling) disable sending | Unchanged |
| 25 | Undo send / failed send reopen the mail (snapshot or server draft) | Unchanged |

Listed for 9.4 but **not present** in the pre-9.4 window (the Gmail-style redesign of 3.18.1 with
header drag, small/large modes, emoji picker, image insert and drag & drop was rolled back in
3.18.2): emoji, image insert and drag & drop are new in 9.4, and so are **importance**
(high / normal / low, stored in the draft), the **delivery receipt** (success notice per recipient),
**tables** (Tiptap table extension) and the larger font list; the 9.4 refine adds **sensitivity**
(Vertraulichkeit, stored in the draft), **Namen prüfen**, the **accessibility check**, superscript /
subscript and the text direction. Not offered: per-mail **S/MIME**
sign/encrypt (S/MIME is applied by the server from Settings → S/MIME).

## 2. The 9.4 model

### Where compose opens

- **Inline**: new mail, reply, reply all, forward and "Entwurf bearbeiten" open in the reading pane
  (reading pane off: in place of the message list). Opening a mail in the list, or another draft,
  minimises the current draft into the **tab strip** at the bottom of the mail view. Opened from
  another page (keyboard `n`/Ctrl+N outside the mail view, undo send), the webmail switches to Mail.
- **Tab strip**: one tab per open draft (subject or "(Kein Betreff)"); a click shows it, ✕ saves
  and closes it. Each draft keeps its fields, attachments and its autosave across switches.
- **Own window**: "…" → **In neuem Fenster öffnen** saves the draft and opens `/compose/<draftId>`
  in a browser window. The window loads the server draft and saves it like the inline compose.
  Sending from the window hands the send to the main window (undo toast there) and closes the
  window; closing the window (✕, Esc) saves and returns the draft to the main window's tab strip.
  Opened without a main window (link, bookmark), the window sends itself and shows the result.
  The main window confirms a handed-off send; without that answer within 1.5 s (main window reloaded
  or busy) the window sends itself — the server's send claim keeps it to one send. Windows opened
  before a reload of the main window are still recognised (by their opener). The window's address
  follows the current draft version, so reloading it loads the latest save.
  A draft written in a shared or delegated mailbox keeps that mailbox in its window
  (`/compose/<draftId>?mailbox=shared:<id>` / `delegated:<id>`): the "Von" choice (send as / on
  behalf of) and the per-identity signature swap work as inline; a handed-off send, undo and a
  draft returned to the tab strip reopen it in the same mailbox. The server re-checks the send-as
  permission on every save and send — the parameter only selects the offered choices.
  Closing the browser window with unsaved changes asks first and saves. A browser that blocks the
  new window keeps the draft inline (message "Der Browser hat das neue Fenster blockiert").
- **A draft already open in its own window** is not opened inline a second time: before loading a
  server draft inline, the webmail asks over a same-origin BroadcastChannel whether a compose window
  holds it (by every id the draft had — a save gives it a new id). That window answers and comes to
  the front, the inline tab closes ("Der Entwurf ist bereits in einem eigenen Fenster geöffnet").
  No answer within 300 ms → the draft opens inline as usual.
- **Small screens** (< 768 px): compose fills the screen.

### Compose area

Top to bottom (since the 9.4 refine — the ribbon tabs Nachricht / Einfügen / Format are gone; every
one of their commands is in one of the bars below):

1. **Command row** (toolbar): **Senden** (icon + text), **Anhängen** (split: Datei anhängen / Bild
   einfügen), **Verwerfen**, "…"; on the right **In neuem Fenster öffnen** (not in the own window)
   and ✕ **Schließen**. The "…" menu (`lib/composeToolbar.ts moreMenuCommands`):
   - **Entwurf speichern**.
   - **Absender anzeigen** — shows the Von row also when the only sender is the own address
     (read-only). With a choice of senders (send as / on behalf of a shared mailbox) Von is shown
     automatically as before and the entry is checked and disabled ("Mehrere Absender verfügbar") —
     kept because the choice matters exactly then; `lib/composeRules.ts composeFieldVisibility`.
   - **Namen prüfen** — every recipient that is not yet "Name <address>" is looked up in the address
     book (`/contacts?q=`: own contacts and the organisation's directory, at most 50 lookups):
     a valid address found there gets its display name, an unknown valid address stays (external),
     a name or partial address ("bob") with exactly one match — an exact name / address / local part
     match wins over partial ones — is replaced by it; several or no matches leave it unresolved:
     marked in its field (tooltip and screen-reader text "mehrere Treffer im Adressbuch" / "nicht im
     Adressbuch gefunden"), listed in a message, and it still stops the send as an invalid address
     (`lib/nameCheck.ts`).
   - **Wichtigkeit ›** Hoch / Normal / Niedrig — stored in the draft (`Importance` / `X-Priority`
     headers) and written into the sent mail; the reader shows "Wichtigkeit: hoch / niedrig" next to
     the subject for any mail that carries such a header (`Message.importance`, read at delivery).
     An inbox rule with the action "Wichtigkeit setzen" replaces that value at delivery (and on
     "Jetzt auf Posteingang anwenden" for existing mail, through the message store); the stored
     message octets keep their headers.
   - **Zu Nur-Text wechseln** / **Zu HTML wechseln** (the label names the target format; switching
     to plain text asks first when there is text, formatting is lost).
   - **Nachrichtenoptionen …** — dialog with **Vertraulichkeit** (Normal / Persönlich / Privat /
     Vertraulich), **Lesebestätigung anfordern** (only when Settings → Lesen offers it, pre-set from
     there) and **Übermittlungsbestätigung anfordern**; OK applies, Abbrechen / Esc keeps the
     previous values.
     - **Vertraulichkeit** is stored in the draft and sent as the `Sensitivity` header (`Personal`,
       `Private`, `Company-Confidential`; normal writes none). The reader shows "Vertraulichkeit:
       persönlich / privat / vertraulich" next to the subject for received mail with such a header
       (`Message.sensitivity`, read at delivery; also set for drafts and Sent copies).
     - **Übermittlungsbestätigung** asks for a delivery status notification per recipient
       (NOTIFY=SUCCESS,FAILURE): the server reports deliveries to its own mailboxes itself and passes
       the request on to the next server; one that does not support it is reported as "relayed".
   - **Auf Barrierefreiheitsprobleme prüfen** — a local check of the body (`lib/composeA11y.ts`,
     nothing leaves the browser): pictures without alternative text, tables without a header row,
     text colours below 4.5:1 (WCAG 2.2 AA) against their highlight or else white — the background a
     mail is usually shown on (theme contrast helper `theme/contrast.ts`), links without text, and
     four or more words in capitals in a row. The quoted original of a reply / forward is not
     checked. The dialog lists the issues; **Anzeigen** closes it and selects the picture / table or
     puts the cursor at the text.
   - **In neuem Fenster öffnen** (not in the own window).
2. **Fields**: Von (see above), An with "Cc" / "Bcc" buttons at the right, Cc, Bcc, Betreff
   (placeholder "Betreff hinzufügen"). Recipients are pills: click shows the full address, ✕ (or
   Backspace in the empty field) removes one, invalid addresses and unresolved names are marked and
   stop the send.
3. **Status line**: "Entwurf gespeichert um HH:MM" (live region) and the attachment chips.
4. **Body** with the placeholder "Nachricht hinzufügen oder Datei hierher ziehen" while it is empty
   (also `aria-placeholder`): a reply/forward quotes the original below a separator with Von /
   Gesendet / An / Cc / Betreff (`<blockquote data-cm-quote>`, the marker survives saving); a long
   reply quote (more than 600 characters or 12 blocks) is folded behind "…" (still sent). Pasting a
   picture inserts it; pictures are raster images up to 500 KB (data: URL, like signature images) —
   larger ones are attached instead. Links are entered in a dialog (http, https, mailto only).
5. **Formatting toolbar** below the body (icon buttons with their name as tooltip; hidden in
   plain-text format, `formatBarVisible`): **Schrift größer**, **Schrift kleiner** (the next size of
   the size list from the text's size, else the default of new text; disabled at 8 / 36 pt),
   **Fett**, **Kursiv**, **Unterstrichen**, **Hervorhebung** (12 colours + none), **Schriftfarbe**
   (12 colours + automatic), **Aufzählung**, **Nummerierung**, **Einzug** and a chevron flyout
   (`formatFlyout`) with, in sections: Einzug verkleinern / vergrößern · Ausrichtung › (links,
   zentriert, rechts, Blocksatz), Textrichtung › (von links nach rechts, von rechts nach links:
   `dir="rtl"` on the paragraph / heading) · Link, Link entfernen (only inside a link), Zitat, Code,
   Hochgestellt, Tiefgestellt, Durchgestrichen · Bild einfügen, Tabelle ›, Trennlinie · Absatzformat ›
   (Normal, Überschrift 1–3, Codeblock), Schriftart ›, Schriftgrad › · Rückgängig, Wiederholen,
   Formatierung löschen.
   - **Tabelle ›**: Tabelle einfügen (3 × 3, first row a header row); with the cursor in a table also
     Zeile oberhalb / unterhalb, Spalte links / rechts einfügen, Zeile / Spalte / Tabelle löschen
     (`tableCommandsFor`). Tables carry inline styles (collapsed 1 px grid, cell padding) so other
     mail clients show the grid; tables of a quoted original are kept (pre-9.4 they were flattened).
   - **Schriftart ›**: "Standardschrift" and three submenus — Lateinische Schriften (Arial …
     Verdana), Chinesisch/Japanisch/Koreanisch (Microsoft YaHei … Batang), Weitere Schriften
     (Leelawadee UI, Nirmala UI, Mangal, Nyala, Sylfaen); each name is shown in its own font. Every
     entry is a CSS font stack of our own (the font, close relatives, an open alternative such as
     Noto / Liberation / DejaVu, a generic family last — `lib/composeFonts.ts`). **Schriftgrad**:
     8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36 pt. New text starts with the font and size of
     Settings → Verfassen (same lists), else Calibri 11 pt.
6. **Header row** at the top of the card (`headerCommands`, `SEND_MENU`, `moreMenuCommands` in
   `lib/composeToolbar.ts`): the split button **Senden** (the only accent-filled control; chevron or
   Alt+↓ opens Senden, **Später senden …**, **Wichtigkeit ›**, **Nachrichtenoptionen …**), quiet icon
   buttons Anhängen, Bild (HTML only), **Signatur einfügen** (only with named signatures; also in plain
   text), "Aa" (toggles the formatting bar, HTML only) and "…" (Entwurf speichern, Absender anzeigen,
   Namen prüfen, **Datum/Uhrzeit ›**, format switch, Formatleiste ausblenden / einblenden, Barrierefreiheit,
   Emoji in plain text, Schließen). Right: draft status (live region), "In neuem Fenster öffnen" (inline
   only) and **Verwerfen**. There is no bottom action bar any more.
   The inline compose is a raised card (rounded, border, soft shadow, 12 px margin on the tinted
   `canvas` of the reading pane) from 768 px; the own window and < 768 px have no margin or shadow. The
   address block has 36 px rows (subject 40 px; 4 px less in compact density), recipient chips with a
   20 px avatar, and the editor sets 15 px / 1.6 with lines of at most 72ch. The **formatting bar**
   (inset strip at the bottom of the card) is remembered as the roaming preference
   `compose.composeFormatBar` (default on).
7. **Drag & drop**: files dropped anywhere on the compose area are attached (overlay while dragging).

All bars are the shared command bar (`components/CommandBar.tsx`): one tab stop each, ←/→ and
Home/End inside, commands that do not fit move to its "…" overflow menu, toggles announce their
state (`aria-pressed`, checkable menu entries).

### Recipients

- Reply: the sender; reply to an own sent mail: its recipients.
- Reply all: An = the sender + the original An, Cc = the original Cc — without the user's own
  address and the mailbox composed in, without duplicates (pre-9.4 the original An was dropped).
- Send is refused before the server is asked while An is empty or an address is invalid.

### Keyboard

| Keys | Action |
|------|--------|
| Ctrl/⌘+Enter | Send |
| Esc | Save the draft and close (asks only when the draft cannot be saved) |
| ←/→, Home/End | Move inside the command row, the formatting toolbar and the action bar |
| ↑/↓, Enter/Tab, Esc | Recipient suggestions |
| Backspace (empty recipient field) | Remove the last recipient |
| Ctrl+B / I / U, Ctrl+Z / Y | Editor formatting / undo (Tiptap) |

Focus: opening puts the cursor into An (new mail, forward) or the body (reply); closing returns
focus to the control that opened the compose, else to the message list.

### Server API (unchanged)

`POST/PUT/GET/DELETE /api/v1/mail/drafts[/:id]`, `POST /api/v1/mail/drafts/:id/send`
(`undoDelaySec`, `scheduledAt`, `requestReceipt`, 9.4 `requestDeliveryReceipt`) and
`POST /api/v1/mail/drafts/:id/unsend` — the popout window uses the same calls (`GET` loads the
draft into the window). 9.4 additions: drafts take and return `importance`
(`high` | `normal` | `low`, default normal; also on `POST /mail/send`); a mail's envelope
recipients are the bare addresses (a picked contact "Name <a@b>" is written to the header only).
9.4 refine: drafts and `POST /mail/send` also take `sensitivity` (`normal` | `personal` | `private` |
`confidential`, default normal; the draft routes refuse other values with 400), `GET` returns it.
Generated MIME (drafts, Sent copies, outgoing mail) uses CRLF line ends.

## 3. Code

| File | Content |
|------|---------|
| `components/compose/ComposePane.tsx` | The compose area (inline and window) |
| `components/compose/ComposeCommandRow.tsx` | Header row of the card: Senden (split), icon buttons, "…", status, popout, Verwerfen |
| `components/compose/ComposeFormatBar.tsx` | Formatting bar at the bottom of the card and its flyout |
| `components/compose/MessageOptionsDialog.tsx`, `AccessibilityDialog.tsx` | Nachrichtenoptionen, accessibility issues |
| `components/compose/ComposeFields.tsx`, `RecipientField.tsx` | Von / An / Cc / Bcc / Betreff, pills + suggestions |
| `components/compose/AttachmentChips.tsx`, `SchedulePopover.tsx`, `EmojiPopover.tsx`, `AnchoredPopover.tsx` | Pieces of the compose area |
| `components/compose/DraftTabStrip.tsx` | Tab strip of open drafts |
| `components/compose/composeRuntime.ts` | Per-draft autosave that outlives tab switches; logout flush |
| `components/compose/popoutChannel.ts` | Windows this tab opened, messages to / acknowledgements from the opening window, draft presence (BroadcastChannel) |
| `hooks/useCompose*.ts` | Editor, sender, original message, signature/body, draft lifecycle; `useComposeRouting` switches to Mail |
| `hooks/usePopoutBridge.ts`, `pages/ComposePopoutPage.tsx` | Own window and its messages to the main window |
| `lib/composeTabs.ts` | Open / switch / minimise / close drafts (state machine) |
| `lib/composeRuntime.ts` | Registry of the per-draft runtimes |
| `lib/recipients.ts` | Recipient parsing, pills, validation, reply-all lists |
| `lib/composeQuote.ts` | Subject prefix, reply/forward quote, long-quote rule |
| `lib/composeRules.ts` | Field visibility, attachment and image rules, send blockers, schedule presets, status text |
| `lib/composeToolbar.ts` | Model of the bars: formatting toolbar, flyout (by editor state), table submenu, font size steps, action bar, "…" menu, plain-text rules |
| `lib/composeA11y.ts` | Accessibility check of the body (document walk, rules, jump target) |
| `lib/nameCheck.ts` | "Namen prüfen": which entries, query, resolution, unresolved marks |
| `lib/sensitivity.ts` | Sensitivity levels and the reader badge |
| `lib/composePopout.ts` | Window URL, the message protocol between window and main window, the presence protocol |
| `lib/composeFormat.ts` | Colours, paragraph styles, table styles and commands, emoji, date/time insert |
| `lib/composeFonts.ts` | Font list by script with our CSS stacks, point sizes, defaults of new text |
| `lib/importance.ts` | Importance levels and the reader badge |
| `components/editorExtensions.ts` | Tiptap extensions of our own: font size, signature block, quote marker, superscript / subscript, text direction |

Tests (`node --test`): `lib/composeTabs.test.ts`, `lib/recipients.test.ts`,
`lib/composeQuote.test.ts`, `lib/composeRules.test.ts`, `lib/composePopout.test.ts` (incl. presence and
importance), `lib/composeFonts.test.ts`, `lib/mailHtmlCss.test.ts` (tables survive the sanitiser),
`lib/errorTexts.test.ts`, `lib/composeToolbar.test.ts` (bars, flyout state, font steps, plain-text
rules, sensitivity), `lib/composeA11y.test.ts`, `lib/nameCheck.test.ts`; server:
`storage/src/importance.test.ts`, `storage/src/sensitivity.test.ts`, `api-gateway/src/routes/drafts.test.ts`
(importance, sensitivity, delivery receipt, bare envelope, CRLF), `api-gateway/src/routes/mailbox-mgmt.test.ts`
(Sent copy headers), `smtp-server/src/handlers/delivery-reports.test.ts` (CRLF, importance and
sensitivity headers),
`lib/composeUi.test.ts` (source checks: no floating window, no components inside components,
German texts from the translation table, ARIA wiring, the order of the bars), plus the existing compose, autosave,
conflict, flush and send-delay tests. e2e: the `webmail` step checks the draft round trip the popout
window relies on (`POST` → `GET` → `PUT` → `/compose/<id>` serves the webmail → `DELETE`), with a
table, the importance and the sensitivity surviving load and replace.
