### Changed
- Webmail contacts page re-laid out: a tabbed ribbon (Start / Ansicht / Hilfe) with "Neuer Kontakt" (split: Neuer Kontakt / Neue Kontaktliste), Bearbeiten, Löschen, E-Mail, Anrufen (`tel:` of the primary number, disabled with a reason when there is none) and Kategorie zuweisen; sort by Vorname / Nachname (client-side, presentation only).
- Sidebar under the user's address: "Ihre Kontakte", "Ihre Kontaktlisten", collapsible "Kategorien" (filters the list, with counts) and "Globales Adressbuch" (the existing address list, read-only, mail to an entry).
- The list shows the columns Name and Kontaktinformationen (primary e-mail / phone) with photo or initials avatars; list, sidebar and detail are cards. Listbox semantics with roving keyboard focus; a single pane at a time on phones.
- The edit / delete / e-mail buttons of the contact and contact list detail views moved into the ribbon.
- "Über CoreMail" in the Hilfe tab shows the product name and running version.

No API, schema, protocol or configuration changes; no breaking change.
