# w1-followups — changelog entries

### Added
- `LICENSE` file (MIT, "CoreMail contributors") as referenced by the README.
- Webmail and BCP: login, second-factor, SSO and setup screens, the webmail settings navigation and
  the BCP page titles of audit log, backups, certificates, system information, LDAP and retention
  are translated (webmail DE/EN/ES/IT, BCP DE/EN).
- Deleting a folder with subfolders: the webmail asks for confirmation with the number of
  subfolders and messages that go; the folder and all its subfolders are deleted and their mail is
  moved to the trash.
- `?recursive=true` on `DELETE /api/v1/mail/folders/:id`, `DELETE /api/v1/mail/{shared,delegated}-mailboxes/:id/folders/:folderId`
  and the compat route `DELETE /api/v1/user/shared-mailboxes/:id/folders/:folderId`: deletes the
  folder and all its subfolders; the messages of the whole subtree move to Trash through the
  message store (IMAP, JMAP and ActiveSync see the change), a system folder inside the subtree is
  never deleted (409 `PROTECTED_SUBFOLDER`). The success answer of the first two routes also carries
  `{ folders, movedToTrash, reparented }` (additive).

### Changed
- Without `?recursive=true` the own-mailbox route and the compat route keep their 9.3 answers
  (200 / 204): only the folder is deleted (its mail to Trash) and its direct subfolders move up to
  the folder's parent. The compat route used to answer 409 for a folder with subfolders and now
  deletes it this way. The shared/delegated routes keep 409 `FOLDER_HAS_SUBFOLDERS` (now with
  `{ code, subfolders, count }`). Live mail still needs `?force=true` (409 `FOLDER_NOT_EMPTY`;
  compat route: implied as before).

### Fixed
- Deleting a folder in the own mailbox left its subfolders behind at the top level (their parent
  link was cleared); they now move up to the deleted folder's parent.
- IMAP `DELETE` removed the messages of the deleted mailbox for good (the soft delete carried no
  modSeq and the folder-row cascade then deleted the rows). The messages now go to Trash through
  the message store (new UID + modSeq; expunged first when the folder is below Trash, so they stay
  recoverable), inferior names stay, folders created below it in the webmail move up to its parent.
  A mailbox with messages and no Trash folder is refused with `NO [CANNOT]`.
- Eleven api-gateway test files kept the test process alive after their last test (the shared
  Redis client reconnected forever); `closeRedis()` now disconnects a client that is not connected.

### Security
- Certificate private keys (`Certificate.keyPem`, `ServerSettings.tlsKey`) and the Let's Encrypt
  account key (`Certificate.acmeAccount`) are encrypted at rest (AES-256-GCM, `enc:v1:`), keyed by
  `MFA_ENCRYPTION_KEY` (or its `JWT_SECRET` + `PEPPER` fallback). Keys stored as plain PEM are
  still read and are encrypted once at api-gateway startup (Redis-locked, idempotent; ACME account
  keys also on their next use). Losing the key makes the stored private keys unreadable — see
  docs/certificates.md "Private keys at rest"; an unreadable ACME account key is replaced by a new
  ACME account at the next issuance.

### SemVer note
- No breaking change: the 9.3 status codes of all three folder-delete routes are kept for requests
  without `?recursive=true`; the only relaxed answer is the compat route (409 → 204 for a folder
  with subfolders). `?recursive=true` and the extra response fields are additive (MINOR).
- IMAP `DELETE` of a non-empty mailbox without a Trash folder now answers `NO [CANNOT]` instead of
  deleting the mail (bug fix: the old result was data loss).
