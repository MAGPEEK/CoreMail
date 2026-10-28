# JMAP in CoreMail

Seit **v5.7.1** enthält CoreMail einen JMAP-Server (`packages/jmap-server/`, Port 3006),
der über den api-gateway unter `/jmap/*` und `/.well-known/jmap` erreichbar ist.
JMAP (JSON Meta Application Protocol) ist der IETF-Standard für den Zugriff auf
Postfächer über HTTPS/JSON und ersetzt IMAP + SMTP-Submission für moderne Clients.

## Umgesetzte RFCs

| RFC | Inhalt | Capability |
|-----|--------|------------|
| [8620](https://www.rfc-editor.org/rfc/rfc8620) | Core: Session, Request/Response, `/get` `/changes` `/set` `/query`, Blobs, Push | `urn:ietf:params:jmap:core` |
| [8621](https://www.rfc-editor.org/rfc/rfc8621) | Mail: Mailbox, Thread, Email, SearchSnippet, Identity, EmailSubmission, VacationResponse | `urn:ietf:params:jmap:mail`, `…:submission`, `…:vacationresponse` |
| [8887](https://www.rfc-editor.org/rfc/rfc8887) | JMAP over WebSocket | `urn:ietf:params:jmap:websocket` |
| [9404](https://www.rfc-editor.org/rfc/rfc9404) | Blob-Management (`Blob/upload`, `Blob/get`, `Blob/lookup`) | `urn:ietf:params:jmap:blob` |
| [9425](https://www.rfc-editor.org/rfc/rfc9425) | Quotas | `urn:ietf:params:jmap:quota` |
| [9670](https://www.rfc-editor.org/rfc/rfc9670) | Sharing: Principal, ShareNotification | `urn:ietf:params:jmap:principals`, `…:principals:owner` |
| [9749](https://www.rfc-editor.org/rfc/rfc9749) | VAPID für Web Push | `urn:ietf:params:jmap:webpush-vapid` |

## Endpunkte

| Methode/Pfad | Zweck |
|--------------|-------|
| `GET /.well-known/jmap` | Discovery, 301 → `/jmap/session` |
| `GET /jmap/session` | Session-Resource (Capabilities, Accounts, URLs, `state`) |
| `POST /jmap/api` | Method-Calls, `Content-Type: application/json`, max. 10 MB, 64 Calls |
| `POST /jmap/upload/{accountId}/` | Blob-Upload (max. 50 MB) → `{ accountId, blobId, type, size }` |
| `GET /jmap/download/{accountId}/{blobId}/{name}?accept=` | Blob-Download |
| `GET /jmap/eventsource?types=*&closeafter=no&ping=30` | Push (Server-Sent Events) |
| `GET /jmap/ws` (Upgrade) | JMAP over WebSocket, Subprotokoll `jmap` |

Alle Pfade außer `/.well-known/jmap` verlangen Authentifizierung.

## Architektur

```
JMAP-Client (Web-App, Thunderbird, Ltt.rs, curl)
   │  HTTPS: POST /jmap/api · GET /jmap/eventsource · WSS /jmap/ws
   ▼
api-gateway (Port 3000, optional TLS-Proxy 443)
   │  Proxy /jmap/* und /.well-known/jmap, WebSocket-Upgrade durchgereicht
   ▼
jmap-server (Port 3006)
   ├─ auth.ts          Basic (App-Passwort) / Bearer (Session-JWT), 60s-Cache
   ├─ accounts.ts      eigenes Postfach · shared-<id> · delegierte Postfächer
   ├─ dispatcher.ts    Request → Method-Calls, Result-References, Fehler
   ├─ methods/         Mailbox · Email · Thread · Identity · EmailSubmission ·
   │                   SearchSnippet · VacationResponse · Quota · Blob ·
   │                   Principal/ShareNotification · PushSubscription
   ├─ mail/            Message ↔ Email-Mapper, RFC-5322-Rohdaten, Keywords, Threads
   └─ push/            Redis-Bus → EventSource · WebSocket · Web Push (VAPID)
   │
   ├─ PostgreSQL (Prisma)   Folder / Message / Attachment / User / SharedMailbox …
   ├─ MinIO                 Rohnachrichten, Anhänge, Upload-Blobs (jmap-upload/, 7 Tage)
   ├─ Redis                 mail:new / mail:update, settings:reload, EmailSubmission-Objekte
   └─ BullMQ smtp-outbound  Versand (gleicher Weg wie SMTP-Submission und Webmail)
```

JMAP ist eine zusätzliche Sicht auf dieselben Daten wie IMAP und das Webmail — es gibt
keine zweite Mail-Datenbank. Eine Änderung über JMAP (Flag, Verschieben, Entwurf) ist
sofort in IMAP-Clients und im MWA sichtbar und umgekehrt.

## Authentifizierung

- **Basic**: `E-Mail:Passwort`. Bei aktivem MFA ist nur ein **App-Passwort** gültig
  (MWA → Einstellungen → Sicherheit → App-Passwörter). LDAP-/OIDC-Konten ohne lokalen
  Hash werden über den auth-service geprüft.
- **Bearer**: Session-JWT aus `POST /auth/login` (für MWA/Web-Apps). Für EventSource
  und WebSocket, die keine Header setzen können, auch als `?access_token=…`.

## Accounts

| accountId | Postfach | Rechte |
|-----------|----------|--------|
| `<userId>` | eigenes Postfach | voll |
| `shared-<id>` | Shared Mailbox | `FULL_ACCESS` → schreibend, `READ_ONLY` → `isReadOnly` |
| `<ownerUserId>` | delegiertes Postfach (MailboxDelegate) | nach Delegationsrecht |

`primaryAccounts` zeigt für Mail/Submission/Quota/Blob/Principals auf das eigene Postfach.

## Datenmodell-Abbildung

| JMAP | CoreMail |
|------|----------|
| Mailbox | `Folder`; `role` aus dem Ordnernamen (`INBOX`→inbox, `Drafts`, `Sent`, `Trash`, `Junk`, `Archive`) |
| Email | `Message` (+ `Attachment`); `blobId = m-<id>`; eine E-Mail liegt in **genau einem** Ordner |
| keywords | IMAP-Flags: `$seen`↔`\Seen`, `$flagged`↔`\Flagged`, `$answered`, `$draft`, `$forwarded` |
| Thread | `Message.threadId` (lazy: `inReplyTo` → bekannte Nachricht → deren Thread) |
| Identity | Primäradresse `u-<userId>`, Aliase `al-<id>`, Shared Mailbox mit SEND_AS `sm-<id>`; Signatur aus den MWA-Einstellungen |
| EmailSubmission | Redis (7 Tage); Versand über die BullMQ-Queue `smtp-outbound`; `sendAt` in der Zukunft → verzögert, `undoStatus: canceled` bricht ab |
| VacationResponse | `UserSettings.oof*` (Abwesenheit) |
| Quota | `quotaBytes` / `usedBytes` (User bzw. Shared Mailbox), Ressource `octets` |
| Principal | aktive User (`individual`), Shared Mailboxes (`group`) |
| PushSubscription | Tabelle `jmap_push_subscriptions`, Verifikation per `PushVerification`-POST |

## State-Strings

- **Email/Thread**: `<maxModSeq>.<highestModSeq>.<maxCreatedMs>.<count>` — erfasst sowohl
  REST/JMAP-Änderungen (`modSeq = Date.now()`) als auch SMTP/IMAP-Zähler.
- **Mailbox**: `<count>.<maxCreatedMs>.<hash>`.
- Gelöschte Objekte haben keine Tombstones. Nach einem Hard-Delete liefert `/changes`
  `cannotCalculateChanges`; der Client lädt die Liste neu (RFC-konform).
- `*/queryChanges` ist nicht implementiert (`cannotCalculateChanges`).

## Push

- **EventSource**: `event: state` mit `StateChange`-Objekt (`Email`, `Thread`, `Mailbox`),
  `event: ping` im gewählten Intervall, `closeafter=state` beendet nach dem ersten Event.
- **WebSocket**: `{"@type":"Request",…}` → `{"@type":"Response",…}`; `WebSocketPushEnable`
  aktiviert `StateChange`-Nachrichten; Fehler als `RequestError`.
- **Web Push**: verifizierte `PushSubscription`s erhalten `StateChange` verschlüsselt
  (RFC 8291) mit VAPID-Signatur, wenn `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` gesetzt sind.
  Der Public Key steht in der Session unter `urn:ietf:params:jmap:webpush-vapid`.

Quelle der Änderungen ist der Redis-Kanal `mail:new` / `mail:update`, den SMTP-Inbound,
REST-API und der jmap-server selbst bedienen — MWA und JMAP-Clients bleiben so synchron.

## Einrichtung

1. **Schalter**: BCP → Server → Karte „JMAP“ (Standard: an). Aus → `/jmap/*` liefert 404,
   die Umschaltung greift ohne Neustart.
2. **Hostname**: Die Session-URLs werden aus BCP → Server → Hostname/HTTPS/Port gebildet.
3. **DNS (optional, RFC 8620 §2.2)**: `_jmap._tcp.example.de. SRV 0 1 443 mail.example.de.`
4. **Reverse Proxy**: Für `/jmap/ws` muss der Proxy WebSocket-Upgrades durchreichen
   (`Upgrade`/`Connection`-Header). Der integrierte TLS-Proxy tut das bereits.
5. **Umgebungsvariablen** (gesetzt in `docker-compose.yml`): `JMAP_PORT=3006`,
   `JMAP_SERVICE_URL=http://localhost:3006`; optional `VAPID_*`.

## Schnelltest

Siehe [Beispiele mit curl](#beispiele-mit-curl).

## Clients einrichten

Voraussetzungen: `https://mail.example.de/.well-known/jmap` ist von außen erreichbar
(DNS + Zertifikat), und für Konten mit MFA liegt ein **App-Passwort** vor (MWA →
Einstellungen → Sicherheit → App-Passwörter).

| Client | Einrichtung |
|--------|-------------|
| **Ltt.rs** (Android, Open Source) | Konto hinzufügen → E-Mail-Adresse + App-Passwort. Die App findet den Server über `/.well-known/jmap`. Wenn der Hostname nicht aus der Domain ableitbar ist, Session-URL `https://mail.example.de/jmap/session` manuell eintragen. |
| **Thunderbird** | JMAP-Unterstützung ist in Thunderbird in Arbeit und nicht in allen Versionen enthalten. Prüfe in deiner Version unter *Konto hinzufügen*, ob „JMAP“ als Kontotyp angeboten wird; sonst IMAP verwenden. |
| **Eigene Web-App** (`jmap-client`, `jmap-js`, Fastmail `jmap-client-ts`) | `sessionUrl: 'https://mail.example.de/jmap/session'`, Auth-Header `Authorization: Bearer <JWT>` aus `POST /auth/login` oder `Basic`. CORS ist für `/jmap/*` freigegeben. |
| **Skripte / Automatisierung** | `curl` mit Basic-Auth, siehe Beispiele unten. |

Der Server annonciert in der Session, was er kann (`capabilities`) — Clients, die eine
Erweiterung nicht kennen, ignorieren sie.

## Beispiele mit curl

Alle Beispiele nutzen `U=user@example.de:APP-PASSWORT` und `H=https://mail.example.de`.
`ACCOUNT` ist die `accountId` aus der Session (`primaryAccounts["urn:ietf:params:jmap:mail"]`).

**Session lesen**
```bash
curl -s -u "$U" "$H/jmap/session" | jq '{username, primaryAccounts, accounts: (.accounts | keys)}'
```

**Ordner und die 10 neuesten Mails im Posteingang**
```bash
curl -s -u "$U" -H 'Content-Type: application/json' "$H/jmap/api" -d '{
  "using": ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
  "methodCalls": [
    ["Mailbox/get", { "accountId": "ACCOUNT", "ids": null,
       "properties": ["id", "name", "role", "totalEmails", "unreadEmails"] }, "m"],
    ["Email/query", { "accountId": "ACCOUNT",
       "filter": { "inMailbox": "INBOX-ID" },
       "sort": [{ "property": "receivedAt", "isAscending": false }], "limit": 10 }, "e"],
    ["Email/get", { "accountId": "ACCOUNT",
       "#ids": { "resultOf": "e", "name": "Email/query", "path": "/ids" },
       "properties": ["subject", "from", "receivedAt", "preview", "keywords"] }, "g"]
  ]}' | jq .
```
(`INBOX-ID` aus dem `Mailbox/get`-Ergebnis einsetzen — der Ordner mit `"role": "inbox"`.)

**Als gelesen markieren und in den Papierkorb verschieben**
```bash
curl -s -u "$U" -H 'Content-Type: application/json' "$H/jmap/api" -d '{
  "using": ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
  "methodCalls": [[ "Email/set", { "accountId": "ACCOUNT", "update": {
    "EMAIL-ID": { "keywords/$seen": true, "mailboxIds": { "TRASH-ID": true } } } }, "s" ]]}'
```

**Mail senden (Entwurf anlegen → einreichen → in „Gesendet“ verschieben)**
```bash
curl -s -u "$U" -H 'Content-Type: application/json' "$H/jmap/api" -d '{
  "using": ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"],
  "methodCalls": [
    ["Identity/get", { "accountId": "ACCOUNT" }, "i"],
    ["Email/set", { "accountId": "ACCOUNT", "create": { "draft": {
        "mailboxIds": { "DRAFTS-ID": true }, "keywords": { "$draft": true, "$seen": true },
        "from": [{ "name": "Max Muster", "email": "user@example.de" }],
        "to":   [{ "email": "empfaenger@example.org" }],
        "subject": "Hallo per JMAP",
        "textBody": [{ "partId": "t", "type": "text/plain" }],
        "bodyValues": { "t": { "value": "Diese Mail kam über JMAP." } } } } }, "d"],
    ["EmailSubmission/set", { "accountId": "ACCOUNT",
        "create": { "sub": { "identityId": "u-USER-ID", "emailId": "#draft" } },
        "onSuccessUpdateEmail": { "#sub": {
          "mailboxIds/DRAFTS-ID": null, "mailboxIds/SENT-ID": true, "keywords/$draft": null } } }, "x"]
  ]}' | jq .
```
Die `identityId` (`u-<userId>`, `al-<aliasId>`, `sm-<sharedId>`) liefert `Identity/get`.
Der From-Header muss zur Identität passen (`forbiddenFrom`). Mit `"sendAt": "2026-11-01T08:00:00Z"`
wird verzögert gesendet; `EmailSubmission/set` mit `update: { "<id>": { "undoStatus": "canceled" } }`
bricht ab, solange `undoStatus` noch `pending` ist.

**Anhang hochladen und mitsenden**
```bash
BLOB=$(curl -s -u "$U" -H 'Content-Type: application/pdf' --data-binary @angebot.pdf \
  "$H/jmap/upload/ACCOUNT/" | jq -r .blobId)
# … dann im Email/set-create: "attachments": [{ "blobId": "'$BLOB'", "type": "application/pdf", "name": "angebot.pdf" }]
```

**Push per EventSource**
```bash
curl -N -s -u "$U" "$H/jmap/eventsource?types=Email,Mailbox&closeafter=no&ping=30"
# event: state
# data: {"@type":"StateChange","changed":{"ACCOUNT":{"Email":"…","Thread":"…","Mailbox":"…"}}}
```

**Push per WebSocket** (z. B. mit `websocat`)
```bash
websocat --protocol jmap -H "Authorization: Basic $(printf %s "$U" | base64)" "wss://mail.example.de/jmap/ws"
{"@type":"WebSocketPushEnable","dataTypes":["Email","Mailbox"]}
{"@type":"Request","id":"1","using":["urn:ietf:params:jmap:core"],"methodCalls":[["Core/echo",{"hello":"jmap"},"c"]]}
```

**Blob-Inhalt per Methode (RFC 9404) und Quota (RFC 9425)**
```bash
curl -s -u "$U" -H 'Content-Type: application/json' "$H/jmap/api" -d '{
  "using": ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:blob", "urn:ietf:params:jmap:quota"],
  "methodCalls": [
    ["Blob/get",  { "accountId": "ACCOUNT", "ids": ["m-EMAIL-ID"], "properties": ["size", "digest:sha-256"] }, "b"],
    ["Quota/get", { "accountId": "ACCOUNT" }, "q"]
  ]}' | jq .
```

## FAQ

**`/jmap/session` liefert 404.** JMAP ist im BCP ausgeschaltet (Server → „JMAP“) oder der
Reverse Proxy leitet `/jmap/*` bzw. `/.well-known/jmap` nicht an CoreMail weiter.

**401 trotz richtigem Passwort.** Für das Konto ist MFA aktiv — JMAP akzeptiert dann nur
App-Passwörter. LDAP-/OIDC-Konten ohne lokalen Hash werden über den auth-service geprüft;
dessen Erreichbarkeit im Log (`jmap:auth`) kontrollieren.

**Der Client meldet `cannotCalculateChanges`.** Gewollt: Nach einem Hard-Delete oder bei
ungültigem `sinceState` kennt der Server kein Delta und der Client lädt die Liste neu.
JMAP-Clients behandeln das standardmäßig.

**WebSocket verbindet nicht, EventSource schon.** Der vorgelagerte Proxy (Traefik, Caddy,
nginx, DSM) muss `Upgrade`/`Connection` für `/jmap/ws` durchreichen. Der integrierte
TLS-Proxy von CoreMail tut das bereits.

**Wo sind Shared Mailboxes?** Als eigene Accounts in der Session (`shared-<id>`), sobald
der User `FULL_ACCESS` oder `READ_ONLY` hat. Senden als Shared Mailbox über die Identität
`sm-<id>` (benötigt `SEND_AS` oder `FULL_ACCESS`).

**Warum sehe ich im Webmail dieselben Änderungen sofort?** JMAP schreibt in dieselben
Tabellen und veröffentlicht `mail:update` auf Redis — dieselbe Quelle, die das MWA per SSE
und der jmap-server für Push nutzen.

**Kann ich Kalender und Kontakte per JMAP lesen?** Noch nicht. JMAP for Calendars/Contacts
(JSCalendar/JSContact) sind nicht enthalten; dafür bleiben CalDAV/CardDAV zuständig.

**Unterschied zu IMAP?** Ein HTTPS-Endpunkt statt zweier Protokolle (IMAP + SMTP), JSON
statt Textprotokoll, gebündelte Aufrufe, echter Push statt IDLE/Polling, und ein
Zustandsmodell (`state`), mit dem Clients effizient synchronisieren.

## Grenzen (Stand v5.7.1)

- `Email/query`: Filter `header`, `allInThreadHaveKeyword` u. ä. → `unsupportedFilter`;
  Sortierung nach `to` → `unsupportedSort`. Maximal 10 000 Treffer pro Query.
- `bodyStructure` wird aus den gespeicherten Feldern synthetisiert
  (text/plain, text/html, Anhänge) — kein 1:1-Abbild verschachtelter MIME-Bäume.
- `Mailbox` erlaubt keine Rollenänderung; Systemordner sind nicht löschbar.
- `ShareNotification` wird noch nicht erzeugt (leere Listen).
- Kalender/Kontakte per JMAP (JSCalendar/JSContact) sind nicht enthalten — dafür
  bleiben CalDAV/CardDAV zuständig.
