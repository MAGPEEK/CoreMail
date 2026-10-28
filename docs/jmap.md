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

```bash
# Session
curl -u user@example.de:APP-PASSWORT https://mail.example.de/jmap/session | jq .

# Posteingang lesen
curl -u user@example.de:APP-PASSWORT -H 'Content-Type: application/json' \
  https://mail.example.de/jmap/api -d '{
  "using": ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
  "methodCalls": [
    ["Mailbox/query", { "accountId": "ACCOUNT", "filter": { "role": "inbox" } }, "a"],
    ["Email/query", { "accountId": "ACCOUNT",
       "#filter": { "resultOf": "a", "name": "Mailbox/query", "path": "/ids" },
       "sort": [{ "property": "receivedAt", "isAscending": false }], "limit": 10 }, "b"],
    ["Email/get", { "accountId": "ACCOUNT",
       "#ids": { "resultOf": "b", "name": "Email/query", "path": "/ids" },
       "properties": ["subject", "from", "receivedAt", "preview"] }, "c"]
  ]}'
```

(`#filter` oben ist nur zur Illustration der Result-References — `Email/query` erwartet
`filter: { inMailbox: "<id>" }`.)

## Grenzen (Stand v5.7.1)

- `Email/query`: Filter `header`, `allInThreadHaveKeyword` u. ä. → `unsupportedFilter`;
  Sortierung nach `to` → `unsupportedSort`. Maximal 10 000 Treffer pro Query.
- `bodyStructure` wird aus den gespeicherten Feldern synthetisiert
  (text/plain, text/html, Anhänge) — kein 1:1-Abbild verschachtelter MIME-Bäume.
- `Mailbox` erlaubt keine Rollenänderung; Systemordner sind nicht löschbar.
- `ShareNotification` wird noch nicht erzeugt (leere Listen).
- Kalender/Kontakte per JMAP (JSCalendar/JSContact) sind nicht enthalten — dafür
  bleiben CalDAV/CardDAV zuständig.
