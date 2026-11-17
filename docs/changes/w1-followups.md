# w1-followups — changelog entries

### Added
- `LICENSE` file (MIT, "CoreMail contributors") as referenced by the README.
- Webmail and BCP: login, second-factor, SSO and setup screens, the webmail settings navigation and
  the BCP page titles of audit log, backups, certificates, system information, LDAP and retention
  are translated (webmail DE/EN/ES/IT, BCP DE/EN).
- Deleting a folder with subfolders: the webmail asks for confirmation with the number of
  subfolders and messages that go; the folder and all its subfolders are deleted and their mail is
  moved to the trash.

### Changed
- `DELETE /api/v1/mail/folders/:id` (own mailbox), `DELETE /api/v1/mail/{shared,delegated}-mailboxes/:id/folders/:folderId`
  and the compat route `DELETE /api/v1/user/shared-mailboxes/:id/folders/:folderId` follow one rule:
  a folder with subfolders needs `?recursive=true` (otherwise 409 `FOLDER_HAS_SUBFOLDERS` with
  `{ subfolders, count }`), a system folder inside the subtree is never deleted (409
  `PROTECTED_SUBFOLDER`), live mail needs `?force=true` (409 `FOLDER_NOT_EMPTY`, compat route:
  implied as before). The messages of the whole subtree move to Trash through the message store
  (IMAP, JMAP and ActiveSync see the change), then the folders are deleted deepest first. The
  success answer of the first two routes now also carries `{ folders, movedToTrash }`.

### Fixed
- Deleting a folder in the own mailbox left its subfolders behind at the top level (their parent
  link was cleared).
- Eleven api-gateway test files kept the test process alive after their last test (the shared
  Redis client reconnected forever); `closeRedis()` now disconnects a client that is not connected.

### Security
- Certificate private keys (`Certificate.keyPem`, `ServerSettings.tlsKey`) are encrypted at rest
  (AES-256-GCM, `enc:v1:`), keyed by `MFA_ENCRYPTION_KEY` (or its `JWT_SECRET` + `PEPPER`
  fallback). Keys stored as plain PEM are still read and are encrypted once at api-gateway startup
  (Redis-locked, idempotent). Losing the key makes the stored private keys unreadable — see
  docs/certificates.md "Private keys at rest".

### SemVer note
- Behaviour change on `DELETE /api/v1/mail/folders/:id`: a folder with subfolders used to be
  deleted (200, subfolders orphaned) and is now refused with 409 unless `?recursive=true` is sent.
  The shared/delegated and compat routes already answered 409 for subfolders. Clients that relied
  on the old own-mailbox behaviour must add `?recursive=true` — the lead decides whether this is
  treated as a breaking API change (MAJOR) or as a bug fix (the old result was data-structure loss).
