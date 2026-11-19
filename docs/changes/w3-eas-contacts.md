# w3-eas-contacts — ActiveSync Contacts

SemVer: MINOR (compatible feature). No schema change, no removed or changed endpoint or API field.
FolderSync now lists one more folder (`contacts:default`, type 9) for every user with the webmail
"Kontakte" module on — devices that synced before learn it through Ping Status 7 / FolderSync, as
for the calendar, tasks and notes folders.

### Added

- ActiveSync: the Contacts class ([MS-ASCNTC], code pages 1 Contacts and 12 Contacts2, EAS 12.1,
  14.0 and 14.1) syncs the user's own contacts both ways. FolderSync announces the default contacts
  folder (type 9, "Kontakte"); the webmail module "Kontakte" switches it off like the other classes
  (folder gone, Sync Status 12, Ping Status 7). Contact groups are not synced (ActiveSync has no
  group item).
- Mapping: name parts, nickname, "file as" (derived when not set), company, department, job title,
  office location, Email1–3Address, the twelve phone slots, business / home / other address, web
  page, IM addresses 1–3, birthday and anniversary (local midnights in the user's region zone, dates
  without year), categories, notes as airsyncbase:Body and the contact picture (inline JPEG / PNG /
  GIF up to 48 KiB).
- Values beyond the fixed ActiveSync slots (a fourth e-mail address, a third work phone, a second
  mobile number, a second work address, PO box and extended address parts, further web pages and
  chat addresses) stay on the server: a phone edit changes only the entries it saw, keeps their
  types and vCard parameters, and never removes an entry it could not see. When the stored contact
  then shows something else than the device sent, the device gets it back as a Change.
- Phone kinds without a CoreMail type (car, radio, assistant, company main, work / home fax) keep
  their kind in the vCard TEL TYPE (`CAR`, `X-RADIO`, `X-ASSISTANT`, `X-COMPANY-MAIN`, `WORK,FAX`,
  `HOME,FAX`) and return to the same ActiveSync slot; REST shows them as `other` / `fax` as before
  and keeps the kind when the number changes. Storage: `vcardPhoneKinds()`, `ContactPhoneKind`,
  `applyContactCard(vcard, card, { phoneKinds })`.
- Every ActiveSync contact element is stored, none is dropped: Spouse, Children, AssistantName and
  ManagerName as related persons (`RELATED;TYPE=spouse|child|x-assistant|x-manager;VALUE=text`,
  vCard 3 `X-RELATED;TYPE=…`; a RELATED by reference stays untouched), the Yomi names as
  `X-PHONETIC-FIRST-NAME` / `X-PHONETIC-LAST-NAME` / `X-PHONETIC-ORG`, CustomerId / GovernmentId /
  AccountName as `X-CUSTOMER-ID` / `X-GOVERNMENT-ID` / `X-ACCOUNT-NAME`, MMS as a phone of kind mms
  (`TEL;TYPE=X-MMS`). REST and CardDAV edits keep them; a phone that ghosts them keeps them.
  Storage: `vcardRelated()` / `setVcardRelated()`, `CONTACT_TEXT_PROPERTIES`, `CONTACT_RELATED_TYPES`.
- Storage: `ensureContactUid()` moved to `contacts/contact-store.ts` and writes through `updateContactRow()`.
- Sync, GetItemEstimate, ItemOperations Fetch and Ping for the contacts folder with the per-device
  item state of the other classes (ClientId retries, no echo, airsync:Supported ghosting, truncated
  bodies); MoveItems refuses moves between the contacts folder and any other class.
- Storage: `contacts/contact-store.ts` — `createContactRow` / `updateContactRow` / `deleteContactRow`,
  the one contact row writer of REST, CardDAV and ActiveSync (vCard + derived columns, a deleted
  contact leaves its groups). `vcardText` / `setVcardText` (`OFFICE_LOCATION_PROPERTY`,
  `X-OFFICE-LOCATION`), `vcardPhoto` / `setVcardPhoto` and `photoMediaType`.
- Tests: Contacts / Contacts2 token tables and byte fixtures, the mapping round trip, overflow
  preservation, ghosting, dates, pictures (`src/pim/contacts-codec.test.ts`); Sync both ways against
  the in-memory database (`src/pim/contacts-sync.test.ts`); storage vCard helpers; e2e step
  `eas-pim` (REST contact → Sync Add, device Add → REST and CardDAV).

### Changed

- REST `/api/v1/contacts` and the CardDAV address book write contacts through the new storage
  contact writer (same data as before).
- ActiveSync notes reuse the shared category reader of the PIM layer (`deviceCategories`, no
  behaviour change).
