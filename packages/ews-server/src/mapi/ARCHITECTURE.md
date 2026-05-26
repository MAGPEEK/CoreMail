# MAPI-over-HTTP — Architektur & Implementations-Roadmap

**Status**: v4.0.0 — Foundation gelegt. ROP-Execution noch nicht funktional.

## Was ist MAPI/HTTP?

Microsofts modernes Transport-Protokoll für Outlook ↔ Exchange-Kommunikation
(seit Exchange 2013 SP1, Outlook 2013+). Es ist ein **HTTP-Wrapper um das
binäre MAPI/ROP-Protokoll** (MS-OXCMAPIHTTP + MS-OXCRPC + MS-OXCROPS).

Ablöst das ältere **Outlook Anywhere** (RPC over HTTP via `/rpc/rpcproxy.dll`,
Type=EXPR im Autodiscover). MAPI/HTTP nutzt einen einzelnen HTTPS-Endpoint:
```
POST https://<server>/mapi/emsmdb/   → Mailbox-Operationen
POST https://<server>/mapi/nspi/     → Adressbuch (Name Service Provider Interface)
GET  https://<server>/mapi/healthcheck.htm  → Connectivity-Probe (anonym, 200 OK)
```

## Warum diese Implementation

Open-Source-Alternativen wie Mailcow, Stalwart und Mox haben **keine** MAPI/HTTP-
Implementation — Outlook ist dort nur über IMAP konfigurierbar (kein Kalender,
keine Kontakte). Grommunio (Open-Source-Exchange-Clone) hat es voll
implementiert in ~80.000 Zeilen C++.

Für CoreMail ist MAPI/HTTP der Weg zu **echter Outlook-Exchange-Anbindung**
mit Mail + Kalender + Kontakte direkt in Outlook, ohne Plugins.

## Protokoll-Stack

```
┌─────────────────────────────────────────────┐
│ Outlook Client (Windows/Mac)                 │
│   - HTTPS-Layer mit Basic-/Bearer-Auth       │
│   - X-RequestType / X-ClientInfo Headers     │
│   - Cookie-basierte Session (MapiSession)    │
└──────────────────┬───────────────────────────┘
                   │ POST /mapi/emsmdb/ (binary)
                   ▼
┌─────────────────────────────────────────────┐
│ api-gateway (Port 443)                       │
│   - TLS-Termination + SNI                    │
│   - ewsAuthMiddleware (401 + WWW-Auth)       │
│   - Proxy zu ews-server                      │
└──────────────────┬───────────────────────────┘
                   │ HTTP localhost:8080/mapi/emsmdb/
                   ▼
┌─────────────────────────────────────────────┐
│ ews-server::mapi/                            │
│   - http-headers.ts   Headers-Validation     │
│   - session-store.ts  Redis-Session          │
│   - codec.ts          Binary Read/Write      │
│   - rop/              ROP-Handler-Tabelle    │
│     ├─ logon.ts       RopLogon               │
│     ├─ folder.ts      RopOpenFolder, ...     │
│     ├─ message.ts     RopOpenMessage, ...    │
│     ├─ stream.ts      RopReadStream, ...     │
│     └─ table.ts       RopGetContentsTable    │
│   - emsmdb-handler.ts Connect/Execute/Disco. │
│   - nspi-handler.ts   Bind/QueryRows/...     │
└──────────────────┬───────────────────────────┘
                   │ Prisma Queries
                   ▼
┌─────────────────────────────────────────────┐
│ PostgreSQL                                   │
│   - User, Mailbox, Folder, Message,          │
│     Attachment, Calendar, Contact, ...       │
└─────────────────────────────────────────────┘
```

## Roadmap

### v4.0.0 — Foundation (✅ aktuell)

- [x] `codec.ts` — Binary-Buffer-Reader/Writer (LE-uint8/16/32/64, ASCII/UTF-16
      null-terminated Strings, GUIDs)
- [x] `http-headers.ts` — Header-Validation, Cookie-Management
- [x] `session-store.ts` — Redis-backed Session (TTL via X-ExpirationInfo)
- [x] Refactor `emsmdb-handler.ts` auf binäres Connect/Disconnect
- [x] `nspi-handler.ts` Stub (Bind/Unbind funktional, QueryRows stub)
- [x] Feature-Flag `ENABLE_MAPI_HTTP` (Default: false)
- [x] Test-Suite für Codec (round-trip Tests)
- [ ] **ROP-Execution funktional NICHT** — Execute liefert `ecNotSupported`,
      Outlook fällt auf EWS zurück (was nicht reicht für volle Anbindung).
      Outlook wird beim Profil-Build noch nicht durchkommen.

### v4.1.0 — RopLogon + Folder-Browse (~2 Wochen)

- [ ] `rop/logon.ts` — `RopLogon` öffnet User-Mailbox, gibt MAPI_STORE-Handle
      zurück. Mappt auf Prisma `mailbox.findUnique({where:{userId}})`.
- [ ] `rop/folder.ts` — `RopOpenFolder`, `RopGetHierarchyTable`,
      `RopGetPropertiesAll` für Folder-Objekte
- [ ] `rop/table.ts` — `RopSetColumns`, `RopQueryRows`, `RopGetRowCount`
      auf Folder-Hierarchy-Tabelle
- [ ] Outlook kann sich anmelden + Folder-Liste sehen (leer = noch keine Mails
      sichtbar)

### v4.2.0 — Mail-Lesen (~2 Wochen)

- [ ] `rop/folder.ts` — `RopGetContentsTable` (Mail-Liste im Ordner)
- [ ] `rop/message.ts` — `RopOpenMessage`, `RopGetPropertiesSpecific`
- [ ] `rop/stream.ts` — `RopOpenStream` (Body), `RopReadStream`
- [ ] Property-Mapper: Prisma `Message` → MAPI Properties
      (PR_SUBJECT, PR_SENDER_NAME, PR_BODY, PR_MESSAGE_FLAGS, ...)
- [ ] Outlook zeigt Mail-Liste + kann Mails öffnen + lesen

### v4.3.0 — Mail schreiben + senden (~1 Woche)

- [ ] `rop/message.ts` — `RopCreateMessage`, `RopSaveChangesMessage`
- [ ] `rop/message.ts` — `RopSetProperties`
- [ ] `rop/stream.ts` — `RopWriteStream`, `RopCommitStream`
- [ ] `rop/submit.ts` — `RopSubmitMessage` → triggert SMTP-Submission über
      BullMQ-Queue (`smtp-outbound`)

### v4.4.0 — Attachments + Move/Delete (~1 Woche)

- [ ] `rop/attachment.ts` — `RopOpenAttachment`, `RopCreateAttachment`,
      `RopReadAttachment`, `RopWriteAttachment`
- [ ] `rop/folder.ts` — `RopMoveCopyMessages`, `RopDeleteMessages`
- [ ] MinIO-Integration für Attachment-Storage

### v4.5.0 — Notifications (~2 Wochen)

- [ ] `rop/notification.ts` — `RopRegisterNotification`, `NotificationWait` mit
      echtem Long-Polling
- [ ] Redis-pub/sub-Bridge: `coremail:mail:new` → wartende
      NotificationWait-Requests aufwecken
- [ ] Outlook bekommt Push für neue Mails ohne Polling

### v4.6.0 — Calendar (~3 Wochen)

- [ ] `rop/calendar.ts` — Termine als IPM.Appointment-Messages
- [ ] Property-Mapping `CalendarEvent` ↔ MAPI Appointment-Properties
      (PR_START_DATE, PR_END_DATE, PR_LOCATION, ...)
- [ ] Free/Busy via NSPI

### v4.7.0 — Contacts (~2 Wochen)

- [ ] NSPI `RopQueryRows` voll funktional (GAL aus User-Tabelle)
- [ ] Personal Contacts als IPM.Contact-Messages im "Contacts"-Folder
- [ ] CardDAV-Bridge: Änderungen synchron in beide Richtungen

### v4.8.0 — Search + Erweiterte ROPs (~2 Wochen)

- [ ] `RopFindRow`, `RopSearchCriteria`, `RopRestrict`
- [ ] Outlook Instant Search ↔ Prisma full-text-search

### v4.9.0 — Public Folders + Shared Mailboxes (~2 Wochen)

- [ ] Shared Mailbox als zweiter MAPI_STORE
- [ ] (Public Folders wurden in v3.18.31 entfernt — kommen nicht zurück)

### v5.0.0 — Production Hardening (~4 Wochen)

- [ ] Performance: ROP-Batch-Pipelining, Prepared Statements
- [ ] Notification-Resilience (Redis-Replica, Backoff)
- [ ] Outlook-Compat-Test-Suite (LTSC 2019, 2021, 2024, Mac)
- [ ] Reference-Dokumentation für Admins

**Geschätzter Gesamt-Aufwand**: 6-9 Monate für ein 2-Personen-Team.

## Binary-Protokoll-Details

### HTTP-Headers (MS-OXCMAPIHTTP §2.2.3)

**Request (Outlook → Server)**:

| Header             | Beschreibung                                    | Beispiel                             |
|---------------------|-------------------------------------------------|--------------------------------------|
| `X-RequestType`     | Operation: Connect/Execute/Disconnect/Bind/...  | `Connect`                            |
| `X-RequestId`       | GUID — Server MUSS exakt zurückspiegeln         | `{aabbccdd-...}`                     |
| `X-ClientInfo`      | GUID — Session-Tracking, persistent über Calls  | `{eeff0011-...}`                     |
| `X-ClientApplication` | Outlook-Version (informational)               | `Outlook/16.0.17328.20068`           |
| `X-User-Identity`   | Pflicht bei Connect: user@domain                | `admin@example.com`                  |
| `Content-Type`      | `application/mapi-http`                         |                                      |
| `Cookie`            | Session-Cookies                                 | `MapiSession=<token>`                |
| `User-Agent`        | `MAPICPL` für Outlook                           |                                      |

**Response (Server → Outlook)**:

| Header                 | Beschreibung                                    | Pflicht |
|------------------------|-------------------------------------------------|---------|
| `X-ResponseCode`       | `0` = success, sonst MAPI-Error-Code            | ✅ Pflicht (im Header, nicht im Body) |
| `X-ServerApplication`  | `Exchange/15.20.x` (Server-Version)             | ✅       |
| `X-RequestId`          | Spiegelt Client-RequestId                       | ✅       |
| `X-ExpirationInfo`     | ms bis Session abläuft                          | ✅ bei Connect |
| `X-PendingPeriod`      | ms zwischen NotificationWait-Polls              | ✅ bei NotificationWait |
| `X-ResponseTimestamp`  | Server-Zeit (ms seit epoch, optional)          |         |
| `Set-Cookie`           | `MapiSession=<token>` bei Connect-Success       | ✅ bei Connect |

### Connect Request Body (Binary, MS-OXCRPC §2.2.4.1)

```
+-------------------------------------+
| UserDn (null-terminated ASCII)      | ← LegacyDN aus Autodiscover
+-------------------------------------+
| Flags (uint32 LE)                   | ← 0x00 für Standard-Connect
+-------------------------------------+
| DefaultCodePage (uint32 LE)         | ← üblicherweise 1252 (Windows-1252)
+-------------------------------------+
| LcidString (uint32 LE)              | ← 0x0409 = en-US
+-------------------------------------+
| LcidSort (uint32 LE)                | ← 0x0409
+-------------------------------------+
| AuxBuffer (variable AUX_HEADERs)    | ← Client-Capabilities, optional
+-------------------------------------+
```

### Connect Response Body

```
+-------------------------------------+
| StatusCode (uint32 LE)              | ← 0 = success
+-------------------------------------+
| ErrorCode (uint32 LE)               | ← 0 = no error
+-------------------------------------+
| PollsMax (uint32 LE)                | ← max Long-Poll-Dauer in ms
+-------------------------------------+
| RetryCount (uint32 LE)              | ← Client-Retry-Anzahl
+-------------------------------------+
| RetryDelay (uint32 LE)              | ← Pause zwischen Retries in ms
+-------------------------------------+
| DnPrefix (null-terminated ASCII)    | ← Server-DN (z.B. "/o=CoreMail/...")
+-------------------------------------+
| DisplayName (null-terminated ASCII) | ← User-DisplayName
+-------------------------------------+
| AuxBuffer (variable)                | ← Server-Capabilities
+-------------------------------------+
```

### AUX_HEADER Block (MS-OXCRPC §2.2.2)

```
+--------+--------+--------+--------+
| Size (uint16 LE)| Version | Type  |
+--------+--------+--------+--------+
| Data (Size - 4 Bytes, type-specific)|
+-------------------------------------+
```

Wichtige Types:
- `AUX_TYPE_PERF_REQUESTID = 0x01` — Client Request-ID
- `AUX_TYPE_PERF_CLIENTINFO = 0x02` — Client-Build, Mode
- `AUX_TYPE_PERF_SERVERINFO = 0x03` — Server-Build (Response)
- `AUX_TYPE_PERF_SESSIONINFO = 0x04` — Session-GUID
- `AUX_TYPE_CLIENT_CONTROL = 0x0A` — Connection-Flags
- `AUX_TYPE_OSVERSIONINFO = 0x18` — OS-Version

### ROP-Payload (MS-OXCROPS)

Innerhalb der Execute-Request kommt ein ROP-Stream:

```
+-----------------------------+
| RopSize (uint16 LE)         | ← Anzahl Bytes des ROP-Buffers
+-----------------------------+
| ROP1 (variable)             | ← RopID + Inputs + ...
+-----------------------------+
| ROP2 (variable)             | ← ...
+-----------------------------+
| ServerObjectHandleTable     | ← Mapping ROP-Handles → Server-Objects
+-----------------------------+
```

Jedes ROP hat:
```
+-----------+----------------+---------+
| RopID (1B)| LogonId (1B)   | Handles |
+-----------+----------------+---------+
| Inputs (variable, ROP-specific)      |
+--------------------------------------+
```

Beispiel RopOpenFolder (RopID=0x02):
```
0x02                    ← RopId = RopOpenFolder
0x00                    ← LogonId = 0 (default Mailbox)
0x00                    ← InputHandleIndex
0x00                    ← OutputHandleIndex
00 00 00 01             ← FolderId (uint64 LE)
0x00                    ← OpenModeFlags
```

Beispiel RopOpenFolder Response:
```
0x02                    ← RopId
0x00                    ← OutputHandleIndex
00 00 00 00             ← ReturnValue (HRESULT)
0x00                    ← HasRules (boolean)
0x00                    ← IsGhosted (boolean)
```

### Session-Management

Outlook erwartet einen **Cookie** `MapiSession=<token>` nach Connect.
Server-seitig wird in Redis ein State pro Session gehalten:

```
Key: mapi-session:<token>
Value (JSON):
{
  userId: "cmpla8p1e...",
  email: "admin@example.com",
  lastSeen: 1729800000000,
  handleTable: { ... }  // ROP-Object-Handle-Table
}
TTL: 600 Sekunden (renew bei jedem Call)
```

NotificationWait nutzt Long-Polling: Server hält Request offen, blockiert auf
Redis-pub/sub für `coremail:mail:new:<userId>`. Wenn Event kommt → Response
mit `EventPending=true`. Bei Timeout (X-PendingPeriod) → leere Response.

## Test-Strategie

### Unit-Tests

- `codec.ts`: Round-Trip-Tests für jeden Read/Write-Pair
- `http-headers.ts`: Validation + Spiegelung
- `session-store.ts`: TTL, Concurrent-Access

### Integration-Tests

- Echte Outlook-Connect-Pcap-Analyse (Wireshark + ssldump)
- Replay bekannter Outlook-Sessions gegen unseren Server
- Vergleich mit Grommunio's Behavior als Referenz

### E2E-Tests

- Outlook LTSC 2019 in Windows-VM
- Outlook für Mac
- Outlook für Office 365 (Click-to-Run)
- Connect → Profile-Build → Mail-List → Mail-Read → Mail-Send

## Referenzen

- [MS-OXCMAPIHTTP — MAPI Extensions for HTTP](https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxcmapihttp)
- [MS-OXCRPC — Wire Format Protocol](https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxcrpc)
- [MS-OXCROPS — Remote Operations](https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxcrops)
- [MS-OXCSTOR — Store Object Protocol](https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxcstor)
- [MS-OXCMSG — Message Object Protocol](https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxcmsg)
- [MS-OXCFOLD — Folder Object Protocol](https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxcfold)
- [MS-OXNSPI — NSPI Protocol](https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxnspi)
- [Grommunio gromox source (open-source reference impl.)](https://github.com/grommunio/gromox)
- [Microsoft — MAPI over HTTP in Exchange Server](https://learn.microsoft.com/en-us/exchange/clients/mapi-over-http/mapi-over-http)
