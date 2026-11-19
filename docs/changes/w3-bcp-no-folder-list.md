### Changed
- BCP: the user detail panel no longer lists the mailbox folders with message and unread counts (unreadable for users with many folders). The API response is unchanged.
- BCP: "Ordnerberechtigungen" of user and shared mailboxes lists only folders with explicit grants ("Keine Ordnerfreigaben" when there are none); "Ordner freigeben…" opens a searchable folder picker (type-ahead over folder paths, keyboard accessible) and then the existing folder editor.
- BCP: editing a user, a shared mailbox or a domain opens in a right-side panel (full height, sticky header, tabs Allgemein / Speicher & Limits / Nachrichtenfluss / Ordnerfreigaben / Protokolle / Webmail, last tab remembered). It is not closed by a backdrop click; closing with unsaved changes asks for confirmation. Full screen below 768 px. Creating mailboxes keeps the dialog.
- BCP: the generic dialog keeps tall content inside the viewport and scrolls internally instead of cutting off the top.
- BCP: the MAPI note in the protocol switches now says MAPI over HTTP is off by default and can be enabled per level or server-wide.
