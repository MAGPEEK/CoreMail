### Changed
- Webmail: mail, calendar and contacts use one shared ribbon (`components/Ribbon.tsx`): tab row, "Menüband: Vereinfacht / Klassisch" and the collapse chevron — the roaming preferences `ribbon.layout` / `ribbon.collapsed` now apply to all three views. Calendar and contacts show their Start / Ansicht / Hilfe commands as tabs (the calendar no longer flattens all tabs into one bar).
- Webmail: the calendar and contacts panes are cards of the floating layout (`components/PaneCard.tsx` on `lib/paneLayout.ts`, translucent over a background picture); the calendar list sits on the canvas like the mail folder pane; the day agenda is a card too.
- Webmail: "Über CoreMail" is one dialog for the Hilfe tab of mail, calendar and contacts (the calendar now shows the entry).
- Webmail: "Neue E-Mail" menu: E-Mail, E-Mail aus Vorlage, Ereignis; "E-Mail aus dem eigenen Postfach" is a fourth, last entry shown only while a shared or delegated mailbox is open.
- Webmail templates: "E-Mail aus Vorlage" is wired into the mail ribbon; while the ribbon shows a draft's contextual tabs, **Einfügen → Vorlage einfügen …** and **Nachricht → Als Vorlage speichern …** run the same commands as the compose card's "…" menu.

### Security
- Profile photo and background uploads are decoded in worker threads, at most two at a time per api-gateway process (shared by both upload kinds; further uploads wait), so a large picture no longer blocks the event loop.
- Background JPEGs are decoded as RGB under a decoder memory cap of 160 MB (was 384 MB). The 12-megapixel limit stays: 12 MP camera pictures (4:2:0) are accepted; a 12 MP JPEG without chroma subsampling or in CMYK is now refused with 422 `DIMENSIONS` ("needs too much memory to decode") instead of being decoded.

No API path, schema or configuration change. Possibly noteworthy for SemVer: the background upload now refuses some large JPEGs (no chroma subsampling / CMYK above ≈ 8 MP) that 10.1 integration builds accepted — never in a released version.
