### Added

- MAPI over HTTP: cached mode for classic Outlook — incremental change synchronization (MS-OXCFXICS).
  Download: `RopSynchronizationConfigure` (contents and hierarchy), `RopFastTransferSourceGetBuffer`
  with partial buffers (TransferStatus Partial / Done, never split inside an atom), message changes
  with header, properties, recipients and attachment data, read-state changes (`IncrSyncRead`),
  deletions (`IncrSyncDel`: deleted, expunged, moved away, no longer matching the restriction),
  folder changes of the mailbox tree, and the final ICS state. ICS state upload and download
  (`RopSynchronizationUploadStateStreamBegin / Continue / End`, `RopSynchronizationGetTransferState`
  with checkpoint states); IDSETs as GLOBSETs. Change numbers are the message store's modSeq;
  PidTagSourceKey, PidTagChangeKey, PidTagPredecessorChangeList and PidTagChangeNumber also in online
  mode. Upload: `RopSynchronizationOpenCollector`, `RopSynchronizationImportMessageChange`
  (new messages, drafts, read state of received messages), `…ImportHierarchyChange` (new folder,
  rename / move), `…ImportDeletes`, `…ImportReadStateChanges`, `…ImportMessageMove`,
  `RopGetLocalReplicaIds`, `RopSetLocalReplicaMidsetDeleted` — every write through the message
  store; objects created offline get server IDs and the next download swaps the client's copy.
  `RopLongTermIdFromId` / `RopIdFromLongTermId`.
- MailStore: `importMessage`, `renameFolder`, local replica ID ranges and replaced client IDs
  (Redis `mapi:local-ids:<mailboxId>`, `mapi:replaced-ids:<mailboxId>`), `foreignAccess`.
- e2e step `mapi`: ICS initial and incremental synchronization of the Inbox (new mail + read
  change), a malformed state upload (`RpcFormat`), hierarchy synchronization.

### Changed

- MAPI over HTTP: the session cap of 16 per account now counts the sessions of every MAPI server
  instance (Redis index `mapi:user-ctx:<userId>`); a new session beyond it ends the least recently
  used one on whichever instance it lives.
- MAPI address book: `NspiBind` honours the client's code page — CP_WINUNICODE or a code page the
  server does not serve is refused with `InvalidCodepage` (no session); strings requested as
  `PtypString8` are converted into the request's (or the session's) code page instead of Latin-1.
- docs/mapi.md: cached mode is supported; Outlook no longer needs cached mode switched off.

### Security

- MAPI over HTTP: a deactivated (or deleted, password-reset) account loses MAPI access at once also
  on an instance that missed the invalidation message — a cached credential check older than the
  account's shared "revoke all" mark is verified again.
- MAPI over HTTP: revoking a Shared Mailbox permission or a delegation (or deactivating the owner)
  ends that mailbox's logon in open MAPI sessions at once (objects released, no further
  notifications); a permission reduced to read-only applies to the next write.
- MAPI cached mode (review): an uploaded ICS state is bounded — its decoded ranges count against
  the session memory budget (over it → `ecMAPIOOM`), all GLOBSETs of one state share one range
  budget and a repeated replica is merged once (no quadratic merging); a malformed IDSET is
  answered with `RpcFormat`. Replaced client IDs are capped at the newest 100 000 per mailbox
  (`mapi:replaced-ids`), client IDs at 256 × 0x10000 per session (`ecQuotaExceeded`). A
  FastTransfer atom that cannot fit a buffer fails the ROP instead of returning empty Partial
  buffers forever.

### Fixed

- MAPI cached mode (review): a folder renamed or moved back to an earlier name / place is sent
  again by the hierarchy synchronization (folder change numbers derive from the folder's state, so
  the final state keeps only the change numbers of the folders in scope); a folder moved out of the
  synchronized subtree is reported deleted; an unchanged special folder below the root (uploaded by
  the client with other properties) is accepted instead of `ecAccessDenied`.
- MAPI address book (review): ISO-8859-1 / ISO-8859-9 strings keep the C1 controls at 0x80–0x9F
  (the runtime decodes these labels as Windows-1252 / -1254).

SemVer: MINOR (compatible protocol additions). Behaviour change to note: an address book `Bind`
with `STAT.CodePage` = 1200 (CP_WINUNICODE) is now refused with `InvalidCodepage` (MS-OXNSPI
3.1.4.1.1: the client must not bind with CP_WINUNICODE, the server returns an error; a code page
the server does not serve → InvalidCodepage); Outlook binds with its ANSI code page.
