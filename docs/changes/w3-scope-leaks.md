# w3-scope-leaks — changelog text (Keep a Changelog)

SemVer: PATCH (security fixes; no schema change, no removed endpoint). The
responses of domain-scoped admins change (addresses of other domains are
redacted), and the webmail folder-permission PUT no longer accepts grantees
outside the caller's address list — see Security.

### Security
- **Audit log of domain-scoped admins**: the scope filter matched only the end of
  `targetName`, so a comma-separated target name ending in an in-scope address
  showed the out-of-scope addresses before it. Entries now belong to the scope
  when an address of the scope's domains appears anywhere in the target name (on
  the domain boundary), and every address of another hosted domain in an entry —
  actor, target name, error text and every string / list element / key of
  `changes` — reads "(andere Domain)" (a run of several: "(andere Domain,
  N Adressen)"). Applies to the list and the CSV / JSON / PDF exports; the
  actor and free-text filters of a scoped admin run on the redacted entries (no
  search oracle). Statistics and anomalies stay organisation-wide only.
- **Detail views of domain-scoped admins** no longer reveal addresses of other
  hosted domains: delegation grantees, shared-mailbox permission grantees (list,
  detail, permission list), folder-permission grantees (overview, per folder,
  PUT answer), other recipients / senders / preview headers of quarantined mail
  (the quarantine search never matches a hidden sender) and message-trace rows
  incl. the CSV export (filters match the redacted rows). One helper for all of
  them (api-gateway `lib/admin-scope.ts` `addressRedactor`,
  `middleware/admin-scope.ts` `redactorOf`). External addresses and the admin's
  own address stay visible; organisation-wide admins see everything unchanged.
- **Folder permissions — no address oracle**: `PUT …/folders/:folderId/permissions`
  (own folders, foreign folders with the folder owner right, admin) answered an
  unknown address with `400 UNKNOWN_GRANTEE` but accepted any existing user,
  including users hidden from the address list. New grantees are now resolved
  only from the caller's directory — webmail: the active users of its domain
  shown in the address list; admins: the users of their scope — plus the users
  the folder's permission view already shows, the mailbox owner and the caller.
  Every other address gets the same `400 UNKNOWN_GRANTEE`, also with the role
  "Keine". The webmail picker offers address-list users only (`directorySuggestions`).
- **Folder permissions — no folder-name oracle**: a grantee with the right to
  create subfolders could probe the names of folders it cannot see through
  `409` / `[ALREADYEXISTS]`. A create or rename whose name is taken only by such
  a folder is now refused like any other forbidden change (REST `403
  NO_PERMISSION`, IMAP CREATE / RENAME `NO [NOPERM]`; storage
  `folderNameCollision`); IMAP RENAME of a folder the grantee can neither see nor
  read answers `[NONEXISTENT]` like a missing folder.

### Changed
- `GET /api/v1/admin/audit-log` of a scoped admin with an actor / free-text
  filter scans the newest 5000 entries of its scope and reports `truncated: true`
  when that cap was reached.
