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
- Address book: a mailbox hidden from the address list is readable by its Minimal Entry ID
  (`GetProps`, `GetPropList`, explicit `QueryRows`) only after the session named its DN (`DNToMId`),
  or when it is the caller's own — MIDs are 31-bit hashes, a guessed MID reveals nothing.
- Address book answers are bounded: at most 100 000 cells (rows × columns) per answer (paged reads
  return fewer rows; explicit MID lists, `GetMatches`, `ResolveNames` answer `TableTooBig`), at most
  1000 names per `ResolveNames`, 256 nodes per `GetMatches` filter.

## Review notes (independent review, branch review-mapi-profile)

Verdict: accept with fixes (fixed on the branch, regression tests added).

Findings:

1. **Medium (security) — hidden mailboxes enumerable by MID.** `nspi/operations.ts` (6b50ef75:97, 212,
   222) read entries with `book.entry(mid)`, hidden ones included: explicit `QueryRows` (up to 10 000
   MIDs per request), `GetProps` and `GetPropList` let a same-domain user sweep the 31-bit MID space
   (~215 000 requests) and list every mailbox the admin hid. Fix: `AddressBook.reachable(mid,
   revealed)`; the session's `revealed` set holds its own id and the ids it named by DN.
2. **Medium (DoS) — unbounded answer size.** Columns are capped only by the 100 000-tag array limit /
   body size (~66 000 tags); explicit `QueryRows` (10 000 MIDs), `GetMatches` (up to 20 000 rows) and
   `ResolveNames` (10 000 names) multiplied that into hundreds of millions of cells in one response
   (6b50ef75:136, 181, 198). Fix: `MAX_RESULT_CELLS` = 100 000 (`fitsResult`, `pageRows`).
3. **Low (DoS) — CPU per request.** `GetMatches` rebuilt every entry's property bag per request
   (address-book.ts 6b50ef75:150) with up to 1024 filter nodes; `ResolveNames` scanned the table for
   exact addresses for each of up to 10 000 names. Fix: memoized filter bags, exact-address index,
   `MAX_FILTER_NODES` 256, `MAX_RESOLVE_NAMES` 1000.
4. **Low (resources) — one directory snapshot per session** (handler.ts 6b50ef75:63): every NSPI
   session loaded and held the whole domain directory. Fix: one snapshot (and one in-flight load) per
   domain, 60 s; failed loads are not cached.
5. **Low — a malformed Bind created a session context** before the body was checked
   (handler.ts 6b50ef75:100). Fix: the body is parsed first; malformed → X-ResponseCode 12, no session.

Checked without findings: GAL scope (own domain, active users / Shared Mailboxes / aliases, hidden
entries out of table, ANR, GetMatches, SeekEntries, CompareMIds, ResortRestriction); context cookies
(digest only, bound to user + credential key + endpoint, sequence rotation, idle expiry, `mapi`
switch off → 403 and the named session ends, LiveConnectionRegistry protocol `mapi`); wire parsing
(counts checked against limits and remaining bytes, restriction depth 32, unknown types →
WireFormatError → X-ResponseCode 12); notifications (only sessions with a logon on the changed
mailbox, one Redis subscriber per process, waiters and timers released on abort / timeout / session
end, second wait → ecRejected, queue bounded and coalesced); Autodiscover (mapiHttp only for the
Outlook schema, `X-MapiHttpCapability`, the user's `mapi` switch and trusted HTTPS; v2 answers per
domain only, no per-user oracle; no EXCH / EXPR).

Open points (not changed):

- `MAX_SESSIONS_PER_USER` (16) is shared by mailbox and address book contexts: a client binding the
  address book many times evicts its own mailbox context (same account only).
- A deactivated user stays in the address book of the domain for up to 60 s (snapshot age).
- NotificationWait / the change bus keep serving a delegated logon until the session ends; whether a
  delegate revocation ends MAPI sessions depends on the existing permission-change handling.
- Spec detail to verify against MS-OXNSPI 3.1.4.1.1: `Bind` with a STAT naming code page
  CP_WINUNICODE should be refused with InvalidCodePage; CoreMail accepts it.
