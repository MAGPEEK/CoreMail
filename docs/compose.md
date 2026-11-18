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
| 8 | Formatting toolbar (hidden in plain-text format): undo/redo, paragraph style (Normal, Überschrift 1–3, Codeblock), font (8), bold/italic/underline/strike, text colour (24 + remove), highlight (12 + remove), link (prompt; http/https/mailto only, empty removes), align left/centre/right/justify, bullet/numbered list, indent −/+, quote, inline code, horizontal line, clear formatting | Ribbon with the tabs **Nachricht**, **Einfügen**, **Format** (all of these plus font size, emoji, image, date/time) |
| 9 | Editor: Tiptap StarterKit, underline, link (no open on click), text align, text style, colour, highlight (multicolour), font family, font size, inline images incl. data: URIs, signature block | Unchanged (`hooks/useComposeEditor.ts`) plus the quote marker; paste of an image file inserts it |
| 10 | Body start: empty line, signature block (default per identity and kind new/reply), quoted original — reply: "Am <date> schrieb <from>:", forward: "Weitergeleitete Nachricht von <from>"; original sanitised (`quoteMailHtml`), text originals escaped; caret at the start; default font/size of Settings → Verfassen | Quote header block **Von / Gesendet / An / Cc / Betreff** below a separator line (`lib/composeQuote.ts`); long reply quotes are folded behind "…" |
| 11 | Signature swap on a sender change while the block is unchanged (`mayAutoSwapSignature`); signature picker (named signatures, "Keine Signatur"), also in plain-text format | Unchanged; picker in **Einfügen → Signatur** and in the "…" menu |
| 12 | Reply/forward load the original (`['message', id]`, `markRead=false`, the compose mailbox): threading (In-Reply-To / References, internal id fallback); forward attaches the original attachments as files (toast for the ones that failed) | Unchanged (`hooks/useComposeOriginal.ts`) |
| 13 | Reopened draft keeps its threading headers, sender, attachments, body | Unchanged |
| 14 | Attachments: file picker (multiple), chips with name / size / remove, counter badge on the button | Chips above the body; **Anhängen** (file / image), drag & drop on the whole compose area, max. 10 (the server limit) |
| 15 | Read receipt checkbox, shown and pre-set by Settings → Lesen | "…" → **Lesebestätigung anfordern** (checkable, same rule) |
| 16 | Discard (trash) with confirmation: waits for a running save, deletes the server draft, toast | **Verwerfen** (same) |
| 17 | Save status as live region: Speichert… / Gespeichert HH:MM / Entwurf nicht gespeichert / Wird bereits gesendet; spinner while a draft loads | "Entwurf gespeichert um HH:MM" line above the body, same live region |
| 18 | Server draft autosave (3 s idle; flush on minimise / close / send), reopen, locked (being/already sent) stops saving, superseded retried, 404 recreated, attachment ids merged after each save (toast for lost ones) | Unchanged (`lib/draft-autosave.ts`, `lib/draft-api.ts`); the saver of a draft survives switching tabs (`lib/composeRuntime.ts`) |
| 19 | Logout saves pending changes first (`registerComposeFlush`) | Unchanged, for every open draft (also the ones in the tab strip) |
| 20 | Send: needs An; forgotten-attachment check (confirm); undo hold via `queueHeldSend` (countdown toast, `z` undoes, server holds the mail, failure reopens everything written) | Unchanged; additionally invalid addresses stop the send before the server is asked |
| 21 | Schedule send: arrow menu with Morgen früh (8:00), Morgen nachmittags (13:00), Nächsten Montag (8:00) and a date/time field (≥ 30 s in the future); toast "Versand geplant für …" | **Senden ▾ → Senden planen …** popover, same presets and rule (`lib/composeRules.ts schedulePresets`) |
| 22 | Ctrl/⌘+Enter sends | Unchanged; Esc saves and closes; listed in the shortcut help |
| 23 | Plain-text format (Settings → Verfassen): toolbar hidden, only the text is sent | Default from the setting, switchable per mail ("…" → **Nur-Text-Format**) |
| 24 | Busy states (forward attachments loading, draft loading, scheduling) disable sending | Unchanged |
| 25 | Undo send / failed send reopen the mail (snapshot or server draft) | Unchanged |

Listed for 9.4 but **not present** in the pre-9.4 window (the Gmail-style redesign of 3.18.1 with
header drag, small/large modes, emoji picker, image insert and drag & drop was rolled back in
3.18.2): emoji, image insert and drag & drop are new in 9.4, and so are **importance**
(high / normal / low, stored in the draft), the **delivery receipt** (success notice per recipient),
**tables** (Tiptap table extension) and the larger font list. Not offered: per-mail **S/MIME**
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

1. **Command row** (toolbar): **Senden** (split: Senden / Senden planen …), **Verwerfen**,
   **Anhängen** (Datei anhängen / Bild einfügen), "…" (Signatur, Lesebestätigung anfordern,
   Übermittlungsbestätigung anfordern, Wichtigkeit ▸ Hoch / Normal / Niedrig, Nur-Text-Format, Als
   Entwurf speichern, In neuem Fenster öffnen); ✕ **Schließen** at the end.
   - **Wichtigkeit** is stored in the draft (`Importance` / `X-Priority` headers) and written into
     the sent mail; the reader shows "Wichtigkeit: hoch / niedrig" next to the subject for any mail
     that carries such a header (`Message.importance`, read at delivery).
   - **Übermittlungsbestätigung** asks for a delivery status notification per recipient
     (NOTIFY=SUCCESS,FAILURE): the server reports deliveries to its own mailboxes itself and passes
     the request on to the next server; one that does not support it is reported as "relayed".
2. **Ribbon** with three tabs (tab list, arrow keys), each a command bar with "…" overflow:
   - **Nachricht**: Rückgängig, Wiederholen, Fett, Kursiv, Unterstrichen, Aufzählung, Nummerierung,
     Link, Formatierung löschen.
   - **Einfügen**: Datei, Bild, Tabelle, Link, Emoji, Signatur, Datum/Uhrzeit, Trennlinie.
   - **Format**: Absatzformat, Schriftart, Schriftgrad, Fett, Kursiv, Unterstrichen,
     Durchgestrichen, Schriftfarbe, Hervorhebung, Ausrichtung (links, zentriert, rechts,
     Blocksatz), Aufzählung, Nummerierung, Einzug verringern/vergrößern, Zitat, Code,
     Formatierung löschen.
   In plain-text format only **Einfügen** with Datei, Emoji, Signatur and Datum/Uhrzeit remains.
   - **Einfügen → Tabelle**: Tabelle einfügen (3 × 3, first row a header row), Zeile oberhalb /
     unterhalb, Spalte links / rechts einfügen, Zeile / Spalte / Tabelle löschen (only offered with
     the cursor in a table). Tables carry inline styles (collapsed 1 px grid, cell padding) so other
     mail clients show the grid; tables of a quoted original are kept (pre-9.4 they were flattened).
   - **Format → Schriftart**: "Standardschrift" and three submenus — Lateinische Schriften (Arial …
     Verdana), Chinesisch/Japanisch/Koreanisch (Microsoft YaHei … Batang), Weitere Schriften
     (Leelawadee UI, Nirmala UI, Mangal, Nyala, Sylfaen); each name is shown in its own font. Every
     entry is a CSS font stack of our own (the font, close relatives, an open alternative such as
     Noto / Liberation / DejaVu, a generic family last — `lib/composeFonts.ts`). **Schriftgrad**:
     8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36 pt. New text starts with the font and size of
     Settings → Verfassen (same lists), else Calibri 11 pt.
3. **Fields**: Von (only with a choice), An with "Cc" / "Bcc" buttons, Cc, Bcc, Betreff.
   Recipients are pills: click shows the full address, ✕ (or Backspace in the empty field) removes
   one, invalid addresses are marked and stop the send.
4. **Status line**: "Entwurf gespeichert um HH:MM" (live region) and the attachment chips.
5. **Body**: a reply/forward quotes the original below a separator with Von / Gesendet / An / Cc /
   Betreff (`<blockquote data-cm-quote>`, the marker survives saving); a long reply quote (more than
   600 characters or 12 blocks) is folded behind "…" (still sent). Pasting a picture inserts it;
   pictures are raster images up to 500 KB (data: URL, like signature images) — larger ones are
   attached instead. Links are entered in a dialog (http, https, mailto only).
6. **Drag & drop**: files dropped anywhere on the compose area are attached (overlay while dragging).

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
| ←/→, Home/End | Move inside the command row, ribbon tabs and ribbon toolbar |
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
Generated MIME (drafts, Sent copies, outgoing mail) uses CRLF line ends.

## 3. Code

| File | Content |
|------|---------|
| `components/compose/ComposePane.tsx` | The compose area (inline and window) |
| `components/compose/ComposeCommandRow.tsx` | Senden / Verwerfen / Anhängen / "…" |
| `components/compose/ComposeRibbon.tsx` | Ribbon tabs Nachricht / Einfügen / Format |
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
| `lib/composeRules.ts` | Field visibility, attachment and image rules, send blockers, schedule presets, ribbon model, status text |
| `lib/composePopout.ts` | Window URL, the message protocol between window and main window, the presence protocol |
| `lib/composeFormat.ts` | Colours, paragraph styles, table styles and commands, emoji, date/time insert |
| `lib/composeFonts.ts` | Font list by script with our CSS stacks, point sizes, defaults of new text |
| `lib/importance.ts` | Importance levels and the reader badge |

Tests (`node --test`): `lib/composeTabs.test.ts`, `lib/recipients.test.ts`,
`lib/composeQuote.test.ts`, `lib/composeRules.test.ts`, `lib/composePopout.test.ts` (incl. presence and
importance), `lib/composeFonts.test.ts`, `lib/mailHtmlCss.test.ts` (tables survive the sanitiser),
`lib/errorTexts.test.ts`; server: `storage/src/importance.test.ts`, `api-gateway/src/routes/drafts.test.ts`
(importance, delivery receipt, bare envelope, CRLF), `smtp-server/src/handlers/delivery-reports.test.ts`
(CRLF, importance headers),
`lib/composeUi.test.ts` (source checks: no floating window, no components inside components,
German texts from the translation table, ARIA wiring), plus the existing compose, autosave,
conflict, flush and send-delay tests. e2e: the `webmail` step checks the draft round trip the popout
window relies on (`POST` → `GET` → `PUT` → `/compose/<id>` serves the webmail → `DELETE`), with a
table and the importance surviving load and replace.
