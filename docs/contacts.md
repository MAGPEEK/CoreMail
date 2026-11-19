# Contacts, contact groups and notes

CoreMail 9.5 stores Outlook-level contacts ("Personen"): several typed e-mail
addresses, phone numbers, postal addresses, web pages and chat addresses, the
structured name, nickname, "file as", birthday, anniversary and categories.
Contact groups ("Kontaktlisten") hold own contacts, other groups and plain
addresses and expand into recipients when composing. Notes keep their colour
and get categories.

## Data model

`vcardData` stays the **source of truth** of a contact: whatever a CardDAV
client stored is kept, and every column of the `contacts` table is derived from
it in one place — `contactColumnsFromVcard()` in
`packages/storage/src/contacts/contact-vcard.ts`. REST, CardDAV and ActiveSync
writes all go through the contact writer `contacts/contact-store.ts`
(`createContactRow` / `updateContactRow` / `deleteContactRow`), which stores the
vCard with the columns derived from it; nothing writes contact columns by hand.

| Column | Content |
|--------|---------|
| `displayName`, `email`, `email2`, `phone`, `mobile`, `company`, `department`, `jobTitle`, `notes` | flat columns (JMAP, GAL search, ActiveSync directory, older clients): `email`/`email2` = 1st/2nd e-mail, `phone` = first number that is no mobile/fax/pager, `mobile` = first mobile number |
| `uid` | vCard UID without `urn:uuid:` (group members reference it) |
| `givenName`, `familyName`, `middleName`, `namePrefix`, `nameSuffix`, `nickname`, `fileAs` | structured name |
| `birthday`, `anniversary` | `YYYY-MM-DD`, `--MM-DD` (year unknown) or empty |
| `categories` | category names (`String[]`) |
| `emails`, `phones`, `addresses`, `urls`, `ims` | JSON lists `[{type, value}]` / addresses `[{type, street, city, region, postalCode, country, poBox, extended}]` |
| `searchText` | lower-case text of all fields except the notes (phones also as digits only) — the REST search |

Type labels: e-mail / address / web page / chat `work | home | other`; phone
`work | home | mobile | fax | pager | other`. At most 20 entries per list.

Contacts stored before 9.5 keep empty structured columns until their next
write; the REST API reads the structured fields from `vcardData`, so they show
completely anyway. Search falls back to the flat columns for them.

`contact_groups`: `name`, `uid`, `vcardData` (the group's own vCard) and
`members` (JSON `[{kind: "card", uid}]` = own contact or nested group,
`[{kind: "address", address, name}]` = plain address). Members and vCard are
kept in step by `packages/storage/src/contacts/contact-groups.ts`; a deleted
contact or group leaves every group it was a member of (`detachCardFromGroups`).

`notes.categories` holds category names; `color` is one of
`YELLOW BLUE GREEN PINK PURPLE`.

### Storage modules (reuse them — e.g. for ActiveSync or MAPI contacts)

| Module | Purpose |
|--------|---------|
| `contacts/contact-card.ts` | the `ContactCard` model, type lists, limits, `applyContactPatch()` (structured fields + the legacy single slots `email`/`email2`/`phone`/`mobile`), `flatContactColumns()`, `contactSearchText()`, date normalisation, tolerant JSON readers, `photoMediaType()` |
| `contacts/contact-vcard.ts` | `contactCardFromVcard()`, `applyContactCard()` (writes only changed properties), `buildContactVcard()`, `contactColumnsFromVcard()`; properties outside the card: `vcardText()` / `setVcardText()` (e.g. `OFFICE_LOCATION_PROPERTY`), `vcardPhoto()` / `setVcardPhoto()` (inline PHOTO in the spelling of the vCard version) |
| `contacts/contact-store.ts` | the contact row writer: `createContactRow()`, `updateContactRow()` (vCard + derived columns), `deleteContactRow()` (also leaves every group) — realtime announcements stay with the caller |
| `contacts/contact-group-vcard.ts` | group vCards (both spellings), `applyContactGroup()`, `expandGroupMembers()` (pure) |
| `contacts/contact-groups.ts` | group columns, `detachCardFromGroups()`, `resolveCards()`, `expandContactGroup()`, `ensureContactUid()` |

A protocol implementation maps its item to a `ContactPatch`, applies it with
`applyContactPatch(contactCardFromRow(row), patch)`, writes
`applyContactCard(row.vcardData, card)` and stores the vCard with
`updateContactRow(row.id, vcard)` (`createContactRow` for a new one) — the same
path the REST API and CardDAV take. ActiveSync does exactly this
(`packages/activesync/src/pim/contacts.ts`, see
[activesync.md](activesync.md#contacts-w3)).

## vCard mapping

| Field | vCard 3.0 (written for new contacts) | vCard 4.0 (kept for v4 cards) | also read |
|-------|------------------|------------------|-----------|
| name | `N`, `FN` | `N`, `FN` | |
| nickname | `NICKNAME` | `NICKNAME` | |
| file as | `X-FILE-AS` | same | `X-EVOLUTION-FILE-AS` |
| company / department | `ORG` (further units kept) | `ORG` | |
| e-mail | `EMAIL;TYPE=INTERNET[,WORK\|HOME]` | `EMAIL[;TYPE=work\|home]` | |
| phone | `TEL;TYPE=WORK,VOICE` / `HOME,VOICE` / `CELL` / `FAX` / `PAGER` / `VOICE` | same, lower case | `tel:` URIs, quoted TYPE lists |
| address | `ADR[;TYPE=WORK\|HOME]` (PO box; extended; street; city; region; code; country) | same | |
| web page | `URL[;TYPE=…]` | same | Apple's escaped `http\://` |
| chat | `IMPP[;TYPE=…]:<scheme>:<handle>` | same | |
| birthday | `BDAY:1980-05-17`, year-less `BDAY;X-APPLE-OMIT-YEAR=1604:1604-05-17` | `BDAY:19800517` / `--0517` | any of these spellings, a time part |
| anniversary | `X-ANNIVERSARY` | `ANNIVERSARY` | Apple `itemN.X-ABDATE` labelled `_$!<Anniversary>!$_` |
| categories | `CATEGORIES` (one line; several lines are merged) | same | |
| office location (ActiveSync only, not in the card) | `X-OFFICE-LOCATION` | same | |
| photo (ActiveSync Picture, not in the card) | `PHOTO;ENCODING=b;TYPE=JPEG:<base64>` | `PHOTO:data:image/jpeg;base64,<base64>` | vCard 2.1 `ENCODING=BASE64`; a photo by URL is kept but not read |

A webmail edit rewrites only the properties whose field changed. Within a
list an unchanged entry keeps its line verbatim (group, `PREF`, Apple labels);
an entry whose value changed at the same position and type keeps the line's
group and parameters. Properties CoreMail does not model (`PHOTO`, `X-…`,
`PRODID`, grouped labels) are never touched; an Apple `X-ABLabel` whose
property was removed goes with it.

### Groups

Read: vCard 4 `KIND:group` + `MEMBER:urn:uuid:<uid>` / `MEMBER:mailto:<address>`,
and the Apple form `X-ADDRESSBOOKSERVER-KIND:group` +
`X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:<uid>`. Writes keep the spelling the group
already uses; a group created in the webmail uses the Apple form (the address
book announces vCard 3.0). A MEMBER carries no display name, so the name the
webmail gave an address member survives a CardDAV PUT of the group.

## CardDAV

Contacts and groups share the default address book (`/dav/addressbooks/<user>/default/<id>.vcf`):
PROPFIND, REPORT (multiget, query, sync-collection), GET, PUT and DELETE work on
both; the ctag / sync-token counts both. A PUT decides by the vCard: a group
vCard becomes a group, everything else a contact. A resource keeps its kind
(a contact PUT onto a group resource → 409), the UID is unique across contacts
and groups (409 `no-uid-conflict`). Deleting a contact or a group rewrites the
groups it was a member of (new ETag), so clients pick the change up.

## ActiveSync

The own contacts sync with phones as the folder `contacts:default` (ActiveSync
Contacts class, see [activesync.md](activesync.md#contacts-w3)); the webmail
module "Kontakte" switches it off like the REST API. ActiveSync has fixed slots
(three e-mail addresses, one phone per kind, three addresses, one web page);
values beyond them stay on the server and are never changed or removed by a
phone. Contact groups are not synced over ActiveSync (there is no group item);
a contact deleted on a phone leaves its groups like a REST or CardDAV delete.

## REST

`/api/v1/contacts` (webmail module "Kontakte"):

| Method | Path | |
|--------|------|-|
| GET | `/?q=` | own contacts (search covers every field) + address-list users; `&groups=1` adds the user's groups (`kind: "group"`, `id: "group-<id>"`, `memberCount`) |
| GET | `/:id` | contact incl. `name`, `emails`, `phones`, `addresses`, `urls`, `ims`, `birthday`, `anniversary`, `categories`, `nickname`, `fileAs` |
| POST | `/` | create; structured fields and/or the legacy `email`/`email2`/`phone`/`mobile`; optional `vcardData` (kept, fields applied on top; no group vCards) |
| PUT | `/:id` | partial update — a list replaces the list; an unchanged body writes nothing |
| DELETE | `/:id` | also leaves every group |
| GET/POST | `/groups` | list (`memberCount`) / create `{name, members}` |
| GET/PUT/DELETE | `/groups/:id` | view (members resolved: `contact`, `group`, `address`, `missing`) / change name and/or members / delete |
| GET | `/groups/:id/expand` | `{name, recipients: [{name, address}], skipped: [{reason: noEmail\|missing, name}]}` — nested groups expanded (depth 5, cycles ignored), addresses de-duplicated |

Members in a request: `{contactId}`, `{groupId}`, `{email, name?}` or `{uid}`
(keeps a reference that does not resolve). Only the user's own contacts and
groups can be members; a group never contains itself.

Validation (400 `{error, field, message}`): e-mail addresses, phone numbers
(digits and the usual separators), web pages `http(s)` only, chat addresses as
`<scheme>:<handle>` (no `javascript:`/`data:`/`vbscript:`/`file:`), dates as
`YYYY-MM-DD` or `--MM-DD`, known type labels, no control characters, list and
length limits; `emails` cannot be combined with `email`/`email2`, `phones` not
with `phone`/`mobile`. Unknown body fields are ignored (pre-9.5 clients send
whole objects). Existing data never blocks an edit: on `PUT` a field the body
repeats unchanged is dropped before validation, a list entry the contact
already holds passes as it is (a URL without scheme or an address another
client stored), and a stored list longer than the limit may keep its length.
Only new values are checked; the webmail form does the same against the form
as loaded. A row whose `vcardData` holds no vCard is read from its flat columns.
Group members read from a client vCard must be safe to write back: a `mailto:`
whose decoded address holds control characters, blanks or no `@`, or a
malformed percent-encoding, is dropped.

`/api/v1/notes`: `categories` on POST/PUT (trimmed, de-duplicated, ≤ 50 names
of ≤ 60 characters), `color` validated (the known colours in any case, stored
canonical; a colour a note already has from before 9.5 is kept when sent back
unchanged), `GET /?category=<name>` filters.

Every write announces the realtime event `contacts` / `notes`
(`announceOnWrite`); CardDAV and ActiveSync writes announce `contacts` too.

## Webmail

People module (`/contacts`): tabs "Kontakte" / "Kontaktlisten". The contact
form has the name parts, company, repeatable typed rows (e-mail, phone,
address, web page, chat), birthday / anniversary (`TT.MM.JJJJ` or `TT.MM.`),
categories from the user's category list and notes. A contact list is edited
by searching own contacts, address-list users and other lists, or by typing a
plain address; "E-Mail an Liste" opens the compose with the expanded
recipients. The recipient autocomplete offers lists too and adds their
members. Notes have a category picker and show category chips.
Logic: `web-client/src/lib/contactForm.ts`, `lib/contactGroups.ts`,
`lib/itemCategories.ts`.

## Tests

- storage: `src/contacts/contact-vcard.test.ts`, `src/contacts/contact-groups.test.ts`
- api-gateway: `src/routes/contacts.test.ts`, `src/routes/contacts-structured.test.ts`, `src/routes/notes.test.ts`
- caldav-server: `src/carddav/carddav.test.ts`
- activesync: `src/pim/contacts-codec.test.ts`, `src/pim/contacts-sync.test.ts`
- web-client: `src/lib/contactForm.test.ts`
- e2e: step `contacts` (`scripts/e2e/steps/contacts.mjs`); ActiveSync contacts in step `eas-pim`
