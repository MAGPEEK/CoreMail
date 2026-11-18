### Added

- **Contacts (People)**: several typed e-mail addresses, phone numbers (work, home, mobile, fax, pager, other), postal addresses, web pages and chat addresses per contact, the structured name (title, given, middle, family name, suffix), nickname, "file as", birthday and anniversary (also without year) and categories. New `contacts` columns (additive) derived from the stored vCard in one place (`@coremail/storage` `contacts/contact-vcard.ts`); the flat columns (`email`, `email2`, `phone`, `mobile` …) stay in step for JMAP, the address list and older clients. The mapping is reusable for ActiveSync contacts. See `docs/contacts.md`.
- **Contact groups ("Kontaktlisten")**: new table `contact_groups`; members are own contacts, other groups or plain addresses. REST `/api/v1/contacts/groups` (CRUD) and `/groups/:id/expand` (recipients, nested groups expanded, duplicates removed); the compose autocomplete offers groups with `?groups=1` and adds their members; "E-Mail an Liste" in the People module.
- **CardDAV**: round trip of the new fields with TYPE (`EMAIL`, `TEL`, `ADR`, `URL`, `IMPP`, `N`, `NICKNAME`, `BDAY`, `ANNIVERSARY` / `X-ANNIVERSARY` / Apple `X-ABDATE`, `CATEGORIES`); contact groups as vCard 4 `KIND:group` + `MEMBER` and in the Apple form `X-ADDRESSBOOKSERVER-KIND` / `-MEMBER`, in the same address book as the contacts. Unknown vCard properties are preserved.
- **REST contacts**: structured fields on `POST`/`PUT /api/v1/contacts` with strict validation (400 names the field), search over every contact field.
- **Notes**: categories (REST `categories`, filter `?category=`), category picker and chips in the webmail.
- **Webmail**: contact form with repeatable typed fields, contact list management in the People module.
- e2e step `contacts`.

### Changed

- A webmail edit of a contact rewrites only the vCard properties whose field changed; a changed e-mail / phone keeps the line's group and parameters (Apple labels, PREF).
- Deleting a contact (REST or CardDAV) removes it from every contact group.
- CardDAV: a PUT that would turn a contact into a group (or back) is refused with 409; vCard UIDs are unique across contacts and groups.
- `PUT/POST /api/v1/notes` validate `color` (`YELLOW BLUE GREEN PINK PURPLE`); other values are refused with 400.
- `@coremail/core/vcard` keeps only the parser (`parseVcard`, `serializeVcard`, `vcardProperty`, `splitStructured`, `countVcards`, `vcardUid`); `vcardFields`, `patchVcard`, `buildVcard` moved to `@coremail/storage` contacts (internal API).
