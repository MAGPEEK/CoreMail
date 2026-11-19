# w3-folder-permissions — changelog text (Keep a Changelog)

SemVer: MINOR (additive schema, new endpoints; existing behaviour unchanged
except IMAP SETACL/DELETEACL/LISTRIGHTS, see Changed).

### Added
- **Folder permissions** like a folder's "Permissions" in Outlook: a mailbox owner
  grants another user — or "Standard" (everyone in the organisation) — a role on
  one folder: Besitzer, Veröffentlichender Bearbeiter, Bearbeiter,
  Veröffentlichender Autor, Autor, Nicht bearbeitender Autor, Prüfer,
  Mitwirkender, Keine, or Benutzerdefiniert (create items, read, edit own / all,
  delete own / all, create subfolders, folder owner, folder contact, folder
  visible), optionally also for the subfolders. "Anonym" is always "Keine".
  Schema (additive): model `FolderPermission`, `Message.createdBy` ("own" items).
- One central access check in storage (`folder-permissions.ts`,
  `folder-access.ts`): mailbox FULL_ACCESS stays full, mailbox READ_ONLY stays a
  read floor, folder grants add rights (user entry before Default, own entry
  before an inherited one).
- Webmail: folder context menu "Berechtigungen…" (own folders; foreign folders
  with the folder owner right); folders shared with the user appear under
  "Freigegebene Postfächer" with only the granted folders (their path is shown
  but not selectable); actions follow the rights per folder.
- REST: `GET|PUT /api/v1/mail/folders/:folderId/permissions`, the same under
  `/api/v1/mail/{shared,delegated}-mailboxes/:id/folders/:folderId/permissions`;
  foreign folder lists carry `noSelect` and `myRights`;
  `GET /user/accessible-mailboxes` marks `folderScoped` mailboxes.
- Admin API + BCP ("Ordnerberechtigungen" in Postfächer / Freigegebene
  Postfächer): `GET /api/v1/admin/{mailboxes,shared-mailboxes}/:id/folder-permissions`,
  `GET|PUT …/:id/folders/:folderId/permissions` (area recipients; admin mailboxes
  Organisation Management only).
- IMAP: real ACL per folder — MYRIGHTS / GETACL / LISTRIGHTS reflect folder
  permissions, SETACL / DELETEACL set them for the owner (or a grantee with the
  folder owner right), "anyone" = Standard; folders reached through folder
  permissions appear under `Other Users/` / `Shared/`.
- Audit: every permission change as `mailbox.folder.permission.set|remove`
  (always written); foreign access stays audited as `mailbox.foreign.*`.
- e2e step `folder-permissions`.

### Changed
- IMAP SETACL / DELETEACL no longer answer `NO [NOPERM]` on the user's own
  folders: they change folder permissions. LISTRIGHTS for another identifier
  lists the grantable rights (`"" l r sw ip k xa te c d`) instead of `""`.
- Every access to a foreign folder (REST, IMAP, attachment download, reply
  headers, realtime events) is decided per folder; permission changes publish
  `permission-change`, so a revoked folder is closed in IMAP on the next command.
- Messages copied or moved into another mailbox never keep a creator claim
  (message store).

### Security
- Mailbox-level paths that do not know folder permissions (JMAP, MAPI, pre-9.3
  REST routes, recover deleted items) can never grant more than before: folder
  grants only add on top of mailbox-level grants.
