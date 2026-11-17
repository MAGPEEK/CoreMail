# ActiveSync (EAS)

`packages/activesync` — ActiveSync protocol versions **12.1, 14.0 and 14.1** on
`/Microsoft-Server-ActiveSync` (port 3005 behind the api-gateway). Everything here follows the
public Microsoft Open Specifications [MS-ASHTTP], [MS-ASCMD], [MS-ASWBXML], [MS-ASPROV],
[MS-ASAIRS], [MS-ASEMAIL] and [MS-ASDTYPE]. Accounts with MFA use app passwords.

## Versions and negotiation

`OPTIONS /Microsoft-Server-ActiveSync` answers

| Header | Value |
|---|---|
| `MS-ASProtocolVersions` | `12.1,14.0,14.1` |
| `MS-ASProtocolCommands` | the commands with a real handler (`src/commands.ts`) |
| `MS-Server-ActiveSync` | `14.1` |

Every request is served with one version (`src/protocol-version.ts`):

1. the version the request names — the `MS-ASProtocolVersion` header (plain request line) or the
   version byte of the base64 request line (121 / 140 / 141);
2. without one: the version the device used last (`ActiveSyncDevice.protocolVersion`);
3. without either: 14.1.

A requested version the server did not announce (2.5, 12.0, 16.x, …) is served as **14.1**, as
before 9.4 — a conforming client picks from `MS-ASProtocolVersions`, and refusing a
non-conforming one would lock its device out. The service logs a warning once per device
(`src/device-version.ts`). The negotiated version is stored on the device whenever it changes (a
device that is updated from 12.1 to 14.1 switches on its next request). Commands never compare
numbers: they ask `supports(version, feature)` for the protocol element that differs.

## Request line

Both encodings of [MS-ASHTTP] are accepted (`src/request.ts`):

* **plain**: `?Cmd=Sync&User=…&DeviceId=…&DeviceType=…` plus command parameters
  (`AttachmentName`, `CollectionId`, `ItemId`, `LongId`, `Occurrence`, `SaveInSent=T`); version and
  policy key in the `MS-ASProtocolVersion` / `X-MS-PolicyKey` headers;
* **base64**: the whole query is one base64 value — version byte, command code, locale, DeviceId,
  policy key (4 bytes, little-endian), DeviceType and tag/length/value parameters (Options bit
  0x01 = SaveInSent). A binary DeviceId (GUID) is stored as upper-case hex, an alphanumeric one as
  text. A truncated or malformed value is answered HTTP 400.

## Differences per version

| Area | 12.1 | 14.0 | 14.1 |
|---|---|---|---|
| Refused request (no device, wrong / missing policy key, wipe pending) | HTTP 449; a pending wipe on a request without policy key HTTP 403 ([MS-ASCMD] 2.2.2) | Status 142/144/140 in the command's WBXML | same as 14.0 |
| Blocked / not approved device | HTTP 403 (also for Provision) | Status 129 | Status 129 |
| Provision | same policy document (all its elements exist since 12.1), same RemoteWipe flow | same | + `settings:DeviceInformation` in request/response |
| SendMail / SmartReply / SmartForward | raw MIME body (`message/rfc822`), parameters in the request line, **empty HTTP 200** (errors: 400 / 403 / 413 / 507 / 500) | ComposeMail WBXML; success = **empty response** (9.4), failure = `<Status>` | same as 14.0 |
| Sync / ItemOperations item | Email + AirSyncBase body (Type 1/2/4, MIMESupport) | + Email2 ConversationId / ConversationIndex, + airsyncbase:Preview | same as 14.0 |
| GetItemEstimate request | `Class` and `airsync:FilterType` directly in the Collection; Class echoed | FilterType in `airsync:Options`, no Class | same as 14.0 |
| Settings | Oof, DeviceInformation, UserInformation (EmailAddresses form), DevicePassword | same | + UserInformation Accounts form, RightsManagementInformation |
| ResolveRecipients | no Availability | + Availability (Status 163: no free/busy) | same as 14.0 |
| FolderSync, Ping, Search, MoveItems, MeetingResponse, GetAttachment | identical in all three versions | | |

MeetingResponse: in every supported version the device sends the meeting reply itself; the
server-side reply path (`SendResponse`) exists for 16.x only. 16.x is not announced, but
MeetingResponse sees the version the client named, so a client that claims 16.x anyway still gets
the reply it asks for (as before 9.4).

### 12.1 SendMail failures

12.1 has no SendMail response body, so a failure is an HTTP status: 400 for a request that cannot
succeed when repeated (malformed MIME, no recipient, unknown source item of SmartReply /
SmartForward), 403 when the From address is not one the user may send as, 507 when the mailbox is
over its send quota, 413 when the message is larger than the maximum message size (9.4), 500 for a
server failure (the device keeps the message and retries).

### Sending: response, size limit, retries (9.4)

- **Success response** (14.x): [MS-ASCMD] 2.2.1.17 SendMail — "If the message was sent
  successfully, the server returns an empty response" (likewise SmartForward 2.2.1.19 and
  SmartReply 2.2.1.20): HTTP 200 with `Content-Length: 0`. A failure keeps the
  `<SendMail|SmartReply|SmartForward><Status>` body. Before 9.4 the success was
  `<Status>1</Status>`.
- **Maximum message size**: the message as it will be sent — for SmartReply / SmartForward
  including the appended original — must not exceed the configured maximum message size (the
  stricter of BCP → SMTP and BCP → Settings → Mail; one storage helper shared with REST and JMAP,
  cached 60 s). Too large: Status 115 (SendQuotaExceeded, [MS-ASCMD] 2.2.2) in 14.x, HTTP 413 in
  12.1. The ActiveSync request body itself is limited to 25 MB.
- **Retries**: a 14.x request with a `ClientId` that was already sent gets Status 118
  (MessagePreviouslySent; remembered for 3 days). Without a ClientId (always in 12.1, which has
  none) a request is recognised as a retry by the `Message-ID` header of its MIME together with the
  DeviceId, for 10 minutes — the
  retry is answered as sent (HTTP 200) and not sent again. A request without Message-ID cannot be
  recognised. A failed send releases the key, so the device's retry goes out.

## WBXML

The code pages follow [MS-ASWBXML] (14.1 token tables). `src/wbxml.ts` also records which pages
and tokens a version does not define — taken from the "Protocol versions" column of the
[MS-ASWBXML] 2.1.2.1.x code page tables (ComposeMail and Email2 pages, Preview, Availability,
Accounts form, …): `tagsNewerThan(buffer, version)` lists the tags of an encoded response that the
version does not know. The unit tests and the e2e step assert that every response carries only
tags of the negotiated version.

## Device policy

Every command except Provision needs a provisioned device whose final policy key matches the
request ([MS-ASPROV] two-phase handshake, `src/device-policy.ts`).

**Ping without policy key (9.4)**: [MS-ASPROV] "Provision Command" — the current policy key is
received "for all protocol command requests except the Autodiscover command, the Ping command,
and the HTTP OPTIONS command". A Ping **without** `X-MS-PolicyKey` (header absent, or no policy
key in the base64 request line) is therefore served when the device is known, in status OK and has
a committed final policy key. Every other case is unchanged: an empty, `0` or wrong key, an
unknown or not provisioned device (142), a blocked / pending device (129) and a pending wipe (140). The remote wipe flow
(`<RemoteWipe/>` in Provision, acknowledgement stored in `remoteWipeAckAt`) is identical in all
versions.

## Tests

* `src/protocol-version.test.ts` — negotiation (unannounced versions served as 14.1, warning once
  per device, version stored on change), feature table;
* `src/request.test.ts` — plain and base64 request lines (byte fixtures, truncation);
* `src/version-matrix.test.ts` — every command for 12.1 / 14.0 / 14.1 against the in-memory
  Prisma fake: only the version's tags, version-specific content, byte fixtures for the 12.1
  GetItemEstimate and UserInformation responses and the RemoteWipe answer;
* `src/commands/send-mail.test.ts` — the 12.1 compose form and its HTTP statuses, the empty 14.x
  success response, the size limit (115 / 413) and the Message-ID retry detection;
* `src/device-policy.test.ts` — HTTP 449/403 for 12.1 (403 also for a pending wipe without policy
  key), WBXML status for 14.x, Ping without policy key;
* e2e step `eas-legacy` (`scripts/e2e/steps/eas-legacy.mjs`, see [e2e.md](e2e.md)).
