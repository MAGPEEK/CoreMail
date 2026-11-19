### Added

- Contacts: one-time background backfill of the 9.5 structured columns (UID, name parts, nickname,
  file as, birthday / anniversary, categories, typed e-mail / phone / address / web / chat lists,
  search text) for contacts stored before 9.5. Started by the api-gateway, Redis-locked, batched,
  resumable, idempotent; `updatedAt` and `changeKey` are kept, so CardDAV / ActiveSync / MAPI clients
  see no change (storage `contacts/contact-backfill.ts`, docs/contacts.md).
- Backup: mailbox backups (single and full, ZIP) contain contact groups next to the contacts
  (`contacts/<id>.vcf`, the stored group vCard as CardDAV serves it); the manifest keeps the names of
  plain-address members and the internal date of every message. The system backup (database dump)
  already contained both tables.
- Restore: contacts and contact groups of a ZIP backup are restored into the address book of the
  target mailbox's owner — contacts first, then groups (members resolve by UID), vCards verbatim,
  idempotent (an existing UID is skipped, never overwritten). New job result counts
  `contactsImported`, `contactsDuplicates`, `contactGroupsImported`, `contactGroupsDuplicates`,
  `addressBookFailed`.

### Changed

- MBOX backups write the internal date (arrival in the mailbox) into the `From ` separator line
  instead of the Date header.
- Restore job result: `otherEntries` now counts only calendar files and other non-mail entries
  (vCard entries are restored and counted separately). The BCP job list shows the restored contacts
  and contact lists („Kontakte wiederhergestellt: n, Kontaktlisten: m, übersprungen (bereits
  vorhanden): k").
- Retention: a restored message (new column `Message.restoredAt`, set by the restore) expires at
  max(received time + retention period, restore time + 30 days), so the Managed Folder Assistant
  does not delete or archive restored mail with an old received time right after the restore.
- The CardDAV / restore UID lookup matches by vCard text only contacts whose `uid` column is still
  empty (pre-9.5 rows), instead of loading every card that contains the UID string.

### Fixed

- Restored messages keep their original received time (IMAP INTERNALDATE, webmail "received")
  instead of the restore time: ZIP manifest internal date / MBOX separator date, else the topmost
  Received header, else the Date header. A second restore still adds nothing.
