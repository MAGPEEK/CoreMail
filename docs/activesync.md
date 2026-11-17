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

A requested version the server did not announce (2.5, 12.0, 16.x, …) is answered **HTTP 400**.
The negotiated version is stored on the device whenever it changes (a device that is updated from
12.1 to 14.1 switches on its next request). Commands never compare numbers: they ask
`supports(version, feature)` for the protocol element that differs.

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
| Refused request (no device, wrong / missing policy key, wipe pending) | HTTP 449 | Status 142/144/140 in the command's WBXML | same as 14.0 |
| Blocked / not approved device | HTTP 403 (also for Provision) | Status 129 | Status 129 |
| Provision | same policy document (all its elements exist since 12.1), same RemoteWipe flow | same | + `settings:DeviceInformation` in request/response |
| SendMail / SmartReply / SmartForward | raw MIME body (`message/rfc822`), parameters in the request line, **empty HTTP 200** (errors: 400 / 403 / 507 / 500) | ComposeMail WBXML, `<Status>` response | same as 14.0 |
| Sync / ItemOperations item | Email + AirSyncBase body (Type 1/2/4, MIMESupport) | + Email2 ConversationId / ConversationIndex, + airsyncbase:Preview | same as 14.0 |
| GetItemEstimate request | `Class` and `airsync:FilterType` directly in the Collection; Class echoed | FilterType in `airsync:Options`, no Class | same as 14.0 |
| Settings | Oof, DeviceInformation, UserInformation (EmailAddresses form), DevicePassword | same | + UserInformation Accounts form, RightsManagementInformation |
| ResolveRecipients | no Availability | + Availability (Status 163: no free/busy) | same as 14.0 |
| FolderSync, Ping, Search, MoveItems, MeetingResponse, GetAttachment | identical in all three versions | | |

MeetingResponse: in every supported version the device sends the meeting reply itself; the
server-side reply path exists for 16.x only (not announced).

### 12.1 SendMail failures

12.1 has no SendMail response body, so a failure is an HTTP status: 400 for a request that cannot
succeed when repeated (malformed MIME, no recipient, unknown source item of SmartReply /
SmartForward), 403 when the From address is not one the user may send as, 507 when the mailbox is
over its send quota, 500 for a server failure (the device keeps the message and retries). 12.1 has
no ClientId, so a retried request is not recognised as a duplicate.

## WBXML

The code pages follow [MS-ASWBXML] (14.1 token tables). `src/wbxml.ts` also records which pages
and tokens a version does not define (ComposeMail and Email2 pages, Preview, Availability,
Accounts form, …): `tagsNewerThan(buffer, version)` lists the tags of an encoded response that the
version does not know. The unit tests and the e2e step assert that every response carries only
tags of the negotiated version.

## Device policy

Every command except Provision needs a provisioned device whose final policy key matches the
request ([MS-ASPROV] two-phase handshake, `src/device-policy.ts`). The remote wipe flow
(`<RemoteWipe/>` in Provision, acknowledgement stored in `remoteWipeAckAt`) is identical in all
versions.

## Tests

* `src/protocol-version.test.ts` — negotiation, feature table;
* `src/request.test.ts` — plain and base64 request lines (byte fixtures, truncation);
* `src/version-matrix.test.ts` — every command for 12.1 / 14.0 / 14.1 against the in-memory
  Prisma fake: only the version's tags, version-specific content, byte fixtures for the 12.1
  GetItemEstimate and UserInformation responses and the RemoteWipe answer;
* `src/commands/send-mail.test.ts` — the 12.1 compose form and its HTTP statuses;
* `src/device-policy.test.ts` — HTTP 449/403 for 12.1, WBXML status for 14.x;
* e2e step `eas-legacy` (`scripts/e2e/steps/eas-legacy.mjs`, see [e2e.md](e2e.md)).
