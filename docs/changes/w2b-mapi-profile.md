### Added

- **Classic Outlook can create an "Exchange" account against CoreMail** (MAPI over HTTP, online
  mode; docs/mapi.md has the setup guide). Implemented from the public Open Specifications
  (MS-OXCMAPIHTTP, MS-OXNSPI, MS-OXOABK, MS-OXCNOTIF, MS-OXCROPS, MS-OXCRPC, MS-OXDSCLI, MS-OXCDATA).
- **Address book endpoint `/mapi/nspi`**: all 19 request types — `Bind` / `Unbind` (own session
  contexts, cookies `NspiContext` / `NspiSequence` on `/mapi/nspi`, sequence-checked like Execute),
  `GetSpecialTable` (the Global Address List, hierarchy version 1), `QueryRows` (paged, STAT
  positioning incl. fractional), `SeekEntries`, `UpdateStat`, `CompareMIds`, `ResortRestriction`,
  `GetMatches` (restriction filter with 32-bit counts, ANR on `PidTagAnr`, `TableTooBig`),
  `ResolveNames` (ANR: exact address / alias, else name, word and local-part prefixes), `DNToMId`,
  `GetProps` (permanent or ephemeral EntryIDs), `GetPropList`, `QueryColumns`, `GetMailboxUrl` /
  `GetAddressBookUrl`; `ModProps` / `ModLinkAtt` NotSupported, `GetTemplateInfo` NotFound. The GAL
  holds the active users and Shared Mailboxes of the account's own domain with their aliases
  (`PidTagAddressBookProxyAddresses`), addressed as `EX` with their legacy DN; mailboxes hidden from
  the address list are not listed or found by name but still resolve by DN. Minimal Entry IDs are
  stable (derived from the directory id).
- **MAPI notifications**: `RopRegisterNotification` subscriptions and open hierarchy / contents
  tables get NewMail, folder ObjectModified (total / unread counts) and TableChanged events from
  Redis `mailbox:changes` (every client and protocol); `NotificationWait` returns as soon as an event
  is queued (typically within a second), the next `Execute` (also an empty one) carries them as
  `RopNotify` / `RopPending`; tables opened with `NoNotifications` get none.
- **Autodiscover mapiHttp**: v1 (Outlook schema) adds `<Protocol Type="mapiHttp" Version="1">`
  (MailStore + AddressBook URLs) when the client sends `X-MapiHttpCapability`, the account's `mapi`
  switch is on and HTTPS has a trusted certificate; v2 answers `Protocol=MapiHttp` (domain level).
  IMAP / SMTP blocks stay; EXCH / EXPR are never sent.
- Storage `mapi-endpoints.ts`: `mapiEndpointsFor()` (the public MAPI URLs from the webmail URL /
  public host name), `isTrustedHttpsCertificate()`, `mapiHttpsTrusted()`; environment
  `MAPI_HTTPS_TRUSTED` for deployments whose external TLS terminator presents a trusted certificate.
- e2e step `mapi`: Autodiscover with / without the switch, NTLM header → Basic challenge, address
  book Bind / GetSpecialTable / QueryRows / ResolveNames / DNToMId / Unbind, NotificationWait woken
  within 3 s by a new mail with RopNotify NewMail on the next Execute.

### Changed

- **NotificationWait**: a second outstanding wait of the same session is now answered at once with
  `ecRejected` (0x7EE, MS-OXCRPC 3.3.4.1) instead of ending the first one.
- The `/mapi/nspi` endpoint no longer answers 16 "Endpoint Disabled".
- Restriction parsing (`props/restriction.ts`) and property value reading take the serialization
  variant (ROP buffers: 16-bit counts; address book: 32-bit counts); `evaluateRestriction` accepts an
  override for nodes the caller evaluates itself. Internal API, no behaviour change for ROPs.

### Security

- MAPI and its Autodiscover entry point authenticate with **Basic over TLS only**: no NTLM /
  Negotiate is offered, a client sending one gets the Basic challenge. NTLM would need a
  password-equivalent NT hash on the server (CoreMail stores only bcrypt(sha256(password + pepper))
  and keeps it that way); Kerberos / Negotiate needs an AD realm and is out of scope. Autodiscover
  announces MAPI only with a trusted HTTPS certificate, so Outlook never sends Basic credentials to an
  untrusted endpoint.
