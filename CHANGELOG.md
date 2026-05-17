# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

---

## [Unreleased]

---

## [2.1.41] — 2026-05-17 — SMTP-Banner: benutzerdefinierter Text wird jetzt verwendet

### Fixed

- **SMTP-Banner ignoriert Admin-Panel-Einstellung** — `session.ts` verwendete immer den hardcodierten Text `220 mail.local ESMTP CoreMail`; `SmtpSettings.bannerText`/`bannerOverride` wurde nie gelesen
- `bannerText` in `SmtpSessionConfig` ergänzt; SMTP-Session liest jetzt den konfigurierten Text
- **Live-Update ohne Neustart**: Banner als Getter implementiert — Änderung im Admin-Panel wirkt sofort bei der nächsten Verbindung

---

## [2.1.40] — 2026-05-17 — Ausgehende Zustellung: MX direkt oder Smarthost

### Added

- **Outgoing Delivery Settings** in ECP → SMTP & Routing → „Ausgehende Mail": Wahl zwischen direkter MX-Zustellung und Smarthost/Relay
- **Smarthost-Konfiguration**: Host, Port, STARTTLS, Implizites TLS, Benutzername, Passwort (maskiert)
- **Port-Schnellauswahl**: 25 SMTP, 587 Submission, 465 SMTPS, 2525 Alt — setzt automatisch die passende TLS-Option
- **9 Provider-Presets** (Schnellauswahl): SendGrid, Mailjet, Mailgun, Postmark, Amazon SES, Gmail, Office 365, IONOS, Strato
- **Verbindungstest** `POST /api/v1/admin/smtp-config/test-smarthost` — prüft SMTP-Verbindung ohne E-Mails zu senden
- **`outboundMode`**, **`smarthostHost/Port/Tls/ImplicitTls/Username/Password`** in `SmtpSettings` (Prisma-Schema + DB)
- **relay.ts** unterstützt jetzt Smarthost-Delivery neben MX-Lookup; Config wird 60s gecacht (kein DB-Hit pro Mail); `invalidateOutboundConfigCache()` für sofortige Aktualisierung nach Settings-Änderung

---

## [2.1.39] — 2026-05-17 — SMTP/IMAP/POP3 TLS-Zertifikat auto-Generierung

### Fixed

- **SMTP-Ports 25, 465, 587 nicht erreichbar** — `createSmtpServer: implicitTls=true but config.tls is not set` — SMTP-Server konnte nicht starten weil kein TLS-Zertifikat konfiguriert war; die Exception brach die gesamte `reloadListeners`-Schleife ab, sodass auch Ports 25 und 587 nicht starteten
- **IMAP Port 993 ohne TLS** — `createImapServer()` verwendete für alle Ports (inkl. 993) nur `net.createServer()` statt `tls.createServer()`; Port 993 war faktisch Plaintext
- **POP3 Port 995 ohne TLS** — TLS-Zertifikat wurde nur über `TLS_CERT_PATH` / `TLS_KEY_PATH` Umgebungsvariablen geladen, die nie gesetzt waren; Port 995 fiel auf Plaintext zurück

### Added

- **TLS-Zertifikat DB-Speicherung** — `ServerSettings` um Felder `tlsCert String?` und `tlsKey String?` erweitert (PEM-kodiert); Zertifikat ist über das Admin-Panel austauschbar
- **Automatische Self-Signed-Zertifikat-Generierung** — beim ersten Start generiert SMTP-Server automatisch ein RSA-2048 Zertifikat (gültig 10 Jahre, SAN: Hostname + localhost) via `openssl req -x509` und speichert es in der DB; IMAP und POP3 laden dasselbe Zertifikat
- **Per-Listener Error-Isolation** — `reloadListeners()` in SMTP, IMAP und POP3 fängt Fehler einzelner Ports in einem `try/catch` pro Port; ein fehlerhafter Port (z.B. fehlendes Cert) blockiert nicht mehr andere Ports
- **`generateSelfSignedCert()` + `tlsPemToBuffers()`** — neue Exports in `@coremail/core` (Paket `core/src/tls/index.ts`)
- **TLS-Cert-Reload bei Settings-Änderung** — `CHANNEL_SETTINGS_RELOAD` Redis-Event lädt nun auch das TLS-Zertifikat neu und startet betroffene Listener neu (Cert-Rotation ohne Container-Neustart)

---

## [2.1.38] — 2026-05-17 — Wartungsmodus: Banner + Login-Enforcement

### Fixed

- **Wartungsmodus hatte keinerlei Wirkung** — Toggle speicherte zwar in der DB, wurde aber nirgendwo ausgewertet

### Added

- **Login-Enforcement** (`auth-service/router/auth.ts`): Bei aktivem Wartungsmodus wird `POST /auth/login` für alle Nicht-Admin-Rollen mit `503 { error: 'maintenance', message: '...' }` blockiert. Ausnahmen: `ORGANIZATION_MANAGEMENT` und `SERVER_MANAGEMENT` (Admins müssen sich anmelden können, um den Modus wieder zu deaktivieren)
- **Öffentlicher Maintenance-Endpunkt** `GET /api/v1/maintenance` — kein Auth nötig, gibt `{ maintenanceMode, maintenanceMessage }` zurück; wird von OWA beim Laden abgefragt
- **Wartungsbanner in OWA-LoginPage** — amber Banner am oberen Bildschirmrand mit dem konfigurierten Wartungstext + Hinweis „Nur Administratoren können sich anmelden"; wird live beim Laden der Seite abgefragt; Login-Fehlermeldung zeigt den Wartungstext statt generischem Fehler

---

## [2.1.37] — 2026-05-17 — RFC 6749 OAuth 2.0 vollständige Implementierung

### Added

- **Client Credentials Grant** (RFC 6749 §4.4) — `grant_type=client_credentials`; Server-zu-Server-Auth ohne User-Kontext; client_id + client_secret Pflicht
- **Resource Owner Password Credentials Grant** (RFC 6749 §4.3) — `grant_type=password`; Benutzer-Credentials direkt an Token-Endpoint; für Legacy-Clients
- **Client Authentication via HTTP Basic** (RFC 6749 §2.3.1) — `Authorization: Basic base64(client_id:client_secret)` am Token-Endpunkt neben client_secret_post
- **Token Introspection** (RFC 7662 §2) — `POST /oauth2/token/introspect`; liefert `active`, `scope`, `sub`, `exp`, `iss`, `client_id`; erfordert Client-Authentifizierung
- **OIDC ID Token** (OIDC Core §3.1.3.3) — im Token-Response enthalten wenn `openid` Scope angefordert; HS256-signiert via `signIdToken()` in `@coremail/core`
- **CORS-Header** auf allen OAuth-Endpunkten — `Access-Control-Allow-Origin: *`, `Cache-Control: no-store`, `Pragma: no-cache` gemäß RFC 6749 §5.1
- **Scope-Validierung** (RFC 6749 §3.3) — angeforderte Scopes werden gegen `client.allowedScopes` geprüft; `invalid_scope`-Fehler wenn Schnittmenge leer
- **Scope-Einschränkung bei Refresh** (RFC 6749 §6) — neuer Scope ≤ ursprünglicher Scope; `invalid_scope` wenn versucht wird, mehr Scopes zu erhalten
- **Consent-Tracking** — neues Prisma-Modell `OAuthConsent`; nicht-trusted Clients werden beim ersten Aufruf in DB gespeichert; Consent widerrufbar
- **`POST /oauth2/consent`** — Frontend kann Consent erteilen oder verweigern; Widerruf revoziert alle aktiven Tokens
- **`GET/DELETE /api/v1/admin/oauth/consents`** — Admin-Verwaltung aller erteilten Consents
- **`pkceRequired` Flag** auf `OAuthClient` — Public Clients (SPAs, native Apps) ohne Client-Secret; PKCE S256 Pflicht; Secret wird leer gespeichert
- **`BASE_URL` aus DB** (`ServerSettings.publicHostname`) statt `AUTODISCOVER_BASE` Env-Variable — gilt für Issuer, Discovery Document und ID Token `iss`-Claim
- **`nonce`-Parameter** in Authorization Code Flow — wird in den Code gespeichert und an OWA weitergegeben (OIDC-Replay-Schutz)

### Changed

- **RFC 6749 §5.2 Fehlerformat** — alle Fehler haben `WWW-Authenticate: Basic realm="CoreMail OAuth2"` Header bei 401; konsistente `{ error, error_description }` Antworten
- **Token Rotation bei Refresh** — altes Refresh Token wird nach Verwendung widerrufen (Rotation nach RFC 6749 Best Practices)
- **PKCE-Enforcement** — für Clients mit `pkceRequired=true` ist `code_challenge` Pflicht beim Authorization Request; Fehler wenn fehlend
- **Admin OAuth-Client Create** — `pkceRequired`-Parameter; Public Clients erhalten kein `clientSecret` (leerer String intern)
- **Discovery Document** — `grant_types_supported` enthält jetzt `client_credentials` und `password`; `introspection_endpoint` ergänzt

---

## [2.1.36] — 2026-05-17 — Hostname aus Admin-Panel (DB-backed) + RFC 8314/6409/1730/1939 Ports

### Changed

- **`MAIL_HOSTNAME` aus `.env` entfernt** — der Mailserver-Hostname wird jetzt primär im Admin-Panel unter „Server-Einstellungen → Hostname" konfiguriert und in `ServerSettings.publicHostname` (Datenbank) gespeichert. Gilt global für SMTP-EHLO-Banner, IMAP-Begrüßung (RFC 3501 §7.1), POP3-Begrüßung (RFC 1939 §3) und Autodiscover.
  - **Migration**: Falls `MAIL_HOSTNAME` noch in der `.env` gesetzt ist, wird der Wert beim ersten Start automatisch in die DB übernommen — danach kann die Variable entfernt werden.
- **`SMTP_HOSTNAME`, `IMAP_HOSTNAME` aus `docker-compose.yml` / `docker-compose.synology.yml` entfernt** — Hostname-Routing erfolgt ausschließlich über DB
- **`WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN`, `EWS_URL`, `OWA_URL`, `EAS_URL`, `AUTODISCOVER_BASE` aus compose-Dateien entfernt** — diese Werte werden aus `ServerSettings.publicHostname` abgeleitet

### Added

- **`CHANNEL_SETTINGS_RELOAD = 'settings:reload'`** (Redis Pub/Sub) — neuer Channel in `@coremail/core`; wird nach jedem PUT `/api/v1/admin/servers/settings` veröffentlicht; SMTP, IMAP und POP3 subscriben darauf und laden den Hostname sofort live nach (kein Neustart nötig)
- **Live-Hostname-Update** in SMTP-, IMAP- und POP3-Server:
  - SMTP: `_hostname`-Variable + `get hostname()` Getter in `SmtpSessionConfig` → neue Verbindungen erhalten sofort den aktualisierten Banner
  - IMAP: `setImapHostname()` in `server/index.ts` → Greeting `* OK [CAPABILITY …] <hostname> IMAP4rev1 ready`
  - POP3: `setPop3Hostname()` in `session.ts` → Greeting `+OK <hostname> POP3 ready`
- **`Received:` Header in `submission/handler.ts`** — RFC 6409 §6.1: jede eingereichte Mail erhält einen `Received:` Header mit IP des Senders, authentifiziertem User, Hostname und RFC 2822 Datum-Zeit

### Fixed

- **RFC 8314**: Port 465 = implizites TLS (SMTPS), Port 587 = STARTTLS (Submission)
- **RFC 6409**: Port 587 Submission — `Received:` Header Pflicht (§6.1) nun implementiert
- **RFC 3501/1730**: IMAP-Begrüßung enthält jetzt korrekten Hostname gemäß RFC
- **RFC 1939**: POP3-Begrüßung enthält jetzt korrekten Hostname gemäß RFC

---

## [2.1.35] — 2026-05-17 — SMTP: RFC 5321-konformer State Machine (Postfix-Architektur)

### Changed

- **`smtp-server` npm-Paket entfernt** — vollständig ersetzt durch eigene TCP-Implementierung nach Postfix-Vorgaben und RFC 5321

### Added

- **`SmtpSession` (core/session.ts)** — RFC 5321-konformer State Machine:
  - States: `INIT → READY → MAIL → RCPT → DATA → QUIT` (+ `AUTH_WAIT` während AUTH)
  - **EHLO**: korrekte Multiline-Antwort mit `250-` / `250`, Extensions: `SIZE`, `PIPELINING`, `8BITMIME`, `SMTPUTF8`, `ENHANCEDSTATUSCODES`, `STARTTLS` (wenn TLS konfiguriert), `AUTH PLAIN LOGIN` (nur Submission-Ports)
  - **AUTH PLAIN** (RFC 4954): Inline `AUTH PLAIN <base64>` und zweistufig `AUTH PLAIN` → `334 ` → base64-Antwort; Format `[authzid]\0authcid\0passwd`
  - **AUTH LOGIN** (mehrstufig): `334 VXNlcm5hbWU6` → Username (base64) → `334 UGFzc3dvcmQ6` → Password (base64)
  - **AUTH-Abbruch**: `*` → `501 5.7.0 Authentication cancelled`
  - **STARTTLS** (RFC 3207): `tls.TLSSocket`-Wrapping, State-Reset auf `INIT` nach TLS-Handshake
  - **MAIL FROM**: RFC 5321 Adresssyntax, `SIZE=`-Parameter, Null-Sender `<>` erlaubt, `530 5.7.0 Authentication required` wenn `requireAuth=true`
  - **RCPT TO**: Max-Empfänger-Check (100), Adressvalidierung
  - **DATA**: Dot-Stuffing (RFC 5321 §4.5.2), Size-Tracking, `552 5.3.4` bei Überschreitung
  - **Timeouts** (RFC 5321 §4.5.3.2): Greeting 5 min, Command 5 min, DATA 10 min → `421 4.4.2 Timeout`
  - **Max-Line-Length**: 1000 Zeichen (RFC §4.5.3.1) → `500 5.5.6 Line too long`
  - **RSET**: Reset Transaction (authUser bleibt erhalten per RFC)
  - **VRFY**: `252 2.5.2 Cannot VRFY user, but will accept message`
  - **EXPN**: `502 5.5.1 EXPN not supported`
- **`core/factory.ts`** — `createSmtpServer()`: wrappt `net.createServer` / `tls.createServer`, ruft `onConnect` auf, startet `SmtpSession`
- **`auth/verifier.ts`** — `verifySmtpCredentials()`: reguläres Passwort (bcrypt + Pepper) + App-Passwörter (`lastUsedAt` Update)
- **`inbound/handler.ts`** — Port-25-Handlers: Connection-Policy (DNSBL via Security-Filter), Empfänger-Verifikation, Content-Scan, Gruppen-Expansion, Resource-Mailbox Auto-Accept/Decline, Quarantäne
- **`submission/handler.ts`** — Port-465/587-Handlers: Anti-Spoofing FROM-Check (eigene Adresse oder Shared-Mailbox `SEND_AS`/`FULL_ACCESS`), lokale Zustellung + Outbound-Queue für externe Empfänger

---

## [2.1.34] — 2026-05-17 — SMTP AUTH: 535 Authentication not implemented behoben

### Fixed

- **`535: Authentication not implemented`** beim Mailversand mit User + Passwort — Der bisherige `createInboundServer()` hatte `authOptional: true` aber keinen `onAuth`-Handler. Das `smtp-server`-Paket antwortet in diesem Fall mit `535 Authentication not implemented` auf jeden AUTH-Versuch.

### Added

- **Neuer `createSubmissionServer()`** für Ports 465 (SMTPS, implizites TLS) und 587 (STARTTLS). Features:
  - `onAuth`-Handler mit vollständiger Passwort-Prüfung:
    1. Reguläres Passwort gegen `User.passwordHash` (bcrypt + Pepper via `verifyPassword`)
    2. App-Passwörter (für Clients ohne MFA) — `lastUsedAt` wird aktualisiert
  - Anti-Spoofing in `onMailFrom`: FROM-Adresse muss mit dem authentifizierten User übereinstimmen (Exception: Shared-Mailbox-Berechtigung `SEND_AS` oder `FULL_ACCESS`)
  - Intelligente Zustellung: lokale Empfänger direkt in Mailbox, externe Empfänger über Outbound-Queue
- **Port-25-Inbound** bleibt unverändert (`authOptional: true`) — externe MTAs authentifizieren sich nicht

---

## [2.1.33] — 2026-05-17 — Setup: E-Mail-Feld folgt Domain automatisch

### Fixed

- **Erstkonfiguration: Administrator-E-Mail wird nicht vollständig synchronisiert** — Die bisherige Logik `!email.includes('@')` brach nach dem ersten getippten Zeichen ab: Sobald `admin@s` gesetzt war, enthielt das Feld `@` → Bedingung false → kein weiteres Update. Beim Screenshot war die Domain `stefanwuestner.de`, das E-Mail-Feld zeigte aber nur `admin@s`.
- **Fix** (`SetupPage.tsx`): Neuer `emailEdited`-State-Flag. Solange der Nutzer das E-Mail-Feld nicht manuell bearbeitet hat, folgt es der Domain in Echtzeit (`admin@<domain>`). Sobald der Nutzer die E-Mail manuell ändert, wird `emailEdited = true` gesetzt und die Auto-Synchronisation stoppt.

---

## [2.1.32] — 2026-05-17 — Postgres Startup-Fix + Definitiver Port-Close

### Fixed

- **coremail-app startet nicht beim Neuaufsetzen (Synology NAS)** — `nc -z` prüft nur TCP-Erreichbarkeit (Port akzeptiert Verbindungen), nicht ob PostgreSQL die DB-Initialisierung abgeschlossen hat. Auf Synology-Volumes (langsames Storage) läuft `initdb` noch bis zu 2 Minuten, nachdem `nc -z` true meldet. `prisma db push` schlug deshalb beim ersten Start fehl — das Skript ignorierte den Fehler und startete supervisord trotzdem. Alle Services crashten, `startretries=10` war nach ~2 Minuten erschöpft, supervisord beendete sich, Docker-Container stoppte. Beim manuellen Neustart war PostgreSQL bereits fertig → alles funktionierte.
- **Fix**: `entrypoint-app.sh` — `prisma db push` mit Retry-Schleife (60 Versuche × 5 s = 5 min). Erst wenn `db push` erfolgreich ist, startet supervisord. Kein Hard-Timeout für den TCP-Check — unbegrenzte Wartezeit mit Progress-Log alle 10 s.
- **Ports lassen sich nicht ab/anschalten (definitiver Fix)** — `server.close()` gibt den OS-Port via `_handle.close()` **synchron** frei. Der optionale Callback feuert erst wenn alle `_connections` auf null sinken — was bei IMAP IDLE (30-min-Timeout) oder TLS-Verbindungen nie passierte. Die bisherige Lösung wartete auf den Callback (3-Sekunden-Timeout als Fallback), was zwar `resolve()` aufrief, aber die Ports blieben gebunden wenn Verbindungen existierten.
- **Fix**: Close-Funktion in allen drei Servern (SMTP, IMAP, POP3) ist jetzt **vollständig synchron**:
  1. Alle getrackten Sockets per `socket.destroy()` sofort beenden
  2. `server.close()` aufrufen (gibt OS-Port synchron frei — kein Warten auf Callback)
  3. `_handle` direkt schließen als Nuklear-Option (falls `server.close()` den Handle nicht freigegeben hat)
- `reloadListeners()` wartet nicht mehr auf einen async Close-Promise — der Port ist nach dem Funktionsaufruf sofort frei.

---

## [2.1.31] — 2026-05-17 — Port-Close Root-Cause-Fix: Socket-Tracking + Reload-Mutex

### Fixed

- **Root Cause: Ports ließen sich nicht schließen (Toggle, Löschen, Bearbeiten)** — `net.Server.closeAllConnections()` existiert **nicht** auf `net.Server` / `tls.Server` — diese Methode gibt es nur auf `http.Server` / `https.Server`. Der bisherige Aufruf `(server as any).closeAllConnections?.()` war dank optionalem Chaining überall ein stiller No-Op. `server.close(done)` wartete dann auf aktive Verbindungen (z. B. IMAP IDLE mit 30-Minuten-Timeout) — der 3-Sekunden-Fallback feuerte `resolve()`, der Map-Eintrag war bereits davor gelöscht worden, und der Port blieb dauerhaft gebunden.
- **Fix**: Alle drei Server (SMTP, IMAP, POP3) tracken jetzt jeden eingehenden Socket manuell in einem `Set<net.Socket>`. Beim Schließen eines Listeners werden alle Sockets per `socket.destroy()` sofort beendet — danach feuert `server.close(done)` sofort, da keine Verbindungen mehr existieren.
- **Reload-Mutex** — Redis-Signal und 10-Sekunden-Poll konnten `reloadListeners()` gleichzeitig starten. Neue `scheduleReload()`-Funktion mit `_reloading`/`_pendingReload`-Flags stellt sicher, dass immer nur ein Reload läuft und ein eventuell eintreffender zweiter direkt im Anschluss ausgeführt wird.

### Changed

- `closeSmtpServer`, `closeImapServer`, `closePop3Server` arbeiten jetzt mit einem `TrackedXxxServer`-Interface (`{ server, sockets }`).
- `createTrackedXxxServer()`-Fabrikfunktionen bauen das Tracking beim Erstellen jedes Listeners auf:
  - **SMTP**: `'connection'`-Listener auf dem internen `net.Server` (`(smtp as any).server`)
  - **IMAP**: `'connection'`-Listener auf dem `net.Server` des `createImapServer()`-Returns
  - **POP3**: direkte Integration im Socket-Handler (kein zweiter Listener nötig)
- Alle drei Server verwenden `scheduleReload()` statt `void reloadListeners()` für Mutex-geschützte Reloads.
- Logging: `remaining: tracked.sockets.size` im Timeout-Warning für bessere Diagnose.

---

## [2.1.30] — 2026-05-17 — Listener-Reload bei DELETE/PUT/POST + Standard-Ports wiederherstellen

### Fixed

- **Listener löschen/bearbeiten → Port bleibt aktiv** — `DELETE` und `PUT /listeners/:id` publizierten kein Redis-Reload-Signal. Nur `PATCH /toggle` sendete das Signal. Beim Löschen oder Bearbeiten eines Listeners blieb der Port bis zum nächsten 10-Sekunden-Poll offen. Fix: alle drei Operationen (`POST`, `PUT`, `DELETE`) rufen jetzt nach dem DB-Schreibvorgang `publishReload(service)` auf.
- **Neuer Listener erscheint in netstat, aber inaktiv deaktivierter Port bleibt offen** — gleiche Ursache. Durch den fehlenden Reload-Trigger bei `POST` wurde ein neu angelegter Listener erst beim Poll aktiviert; beim Löschen blieb er bis zum Poll aktiv.

### Added

- **„Standards"-Button** in der Listener-Tabelle (SMTP Inbound / IMAP / POP3): Stellt die Standard-Ports sofort wieder her, falls Listener gelöscht oder falsch konfiguriert wurden. Bestehende Listener der Service-Gruppe werden komplett ersetzt durch die Defaults (SMTP: 25, 465, 587 · IMAP: 143, 993 · POP3: 110, 995, alle mit `active=true`). Anschließend wird ein Redis-Reload-Signal gesendet, sodass die Ports sofort starten.
- **Neuer API-Endpunkt** `POST /api/v1/admin/services/listeners/:service/restore-defaults`.
- **Übersicht-Hinweis** auf korrekte dynamische Beschreibung aktualisiert (v2.1.29 macht Ports wirklich dynamisch).

---

## [2.1.29] — 2026-05-17 — Services Port-Toggle: Startup liest DB-Zustand

### Fixed

- **Root Cause des Port-Toggle-Problems** — Startup-Code öffnete Ports **immer** aus Env-Vars (25, 465, 587, 143, 993, 110) ohne DB zu befragen. Der 10-Sekunden-Interval-Poll las dann die DB (alle Ports `active=false` da vom User deaktiviert) und schloss alle Ports sofort wieder. Danach öffnete der nächste Container-Neustart alles erneut → Ping-Pong zwischen Startup und Poll.
- **Fix**: Startup ruft jetzt `reloadListeners()` auf, statt Ports hardcodiert zu öffnen. Beim absolut ersten Start (keine DB-Einträge vorhanden) werden Defaults automatisch geseedet (`active=true`). Nach dem ersten Start bestimmt ausschließlich die DB welche Ports offen sind.
- **Geister-Eintrag IMAP Port 994** — Staler DB-Eintrag aus Testsitzungen entfernt. Der Interval-Poll startete diesen Port fälschlicherweise und stoppte gleichzeitig 143/993.
- **POP3-Server** — Von Top-Level-Code auf `async main()`-Muster umgestellt (konsistent mit SMTP/IMAP).

---

## [2.1.28] — 2026-05-17 — Postfach anlegen: nur aktive Domains

### Changed

- **Domain-Dropdown (BCP → Postfächer → Neu anlegen)** — Zeigt ausschließlich aktive Domains. Deaktivierte Domains werden im Dropdown ausgeblendet, damit kein Postfach unter einer inaktiven Domain erstellt werden kann.
- **Hinweistext** — Wenn alle Domains deaktiviert sind, erscheint statt des generischen "Keine Domains"-Texts der spezifische Hinweis "Alle Domains sind deaktiviert — bitte zuerst eine Domain aktivieren."

---

## [2.1.27] — 2026-05-17 — SMTP/IMAP/POP3 Port-Toggle zuverlässig

### Fixed

- **Services Port-Toggle — Port bleibt nach Deaktivierung aktiv** — Drei überlagerte Bugs:
  1. `server.close(cb)` und `closeAllConnections()` wurden **sequenziell** aufgerufen: `closeAllConnections` lief zuerst, dann `server.close(cb)`. Das Fenster zwischen beiden Aufrufen erlaubte neue Verbindungen, die dann den Callback blockierten. Fix: beide Aufrufe **gleichzeitig** in einer Promise.
  2. `servers.delete(port)` wurde **nach** dem `await` aufgerufen. Bei parallelen Reload-Aufrufen (Redis-Signal + 10-s-Fallback) versuchten beide Aufrufe denselben Port zu schließen. Fix: Port sofort aus der Map entfernen, **bevor** geclosedt wird.
  3. Kein Fallback wenn das Redis-Signal verloren geht. Fix: `setInterval` alle 10 Sekunden als Belt-and-Suspenders.
- **Kein Timeout beim Close** — Wenn `server.close(cb)` dennoch nicht feuerte (z. B. durch eine widerspenstige Verbindung), hing die `async`-Funktion ewig. Fix: 3-Sekunden-Timeout der den Close immer auflöst.

### Changed

- SMTP-, IMAP- und POP3-Server haben jetzt je eine `closeXxxServer()`-Hilfsfunktion für robustes Port-Schließen.
- Graceful-Shutdown nutzt `Promise.all` statt sequenzielle Schleife.

---

## [2.1.26] — 2026-05-17 — bcryptjs statischer Import + smtp-server Property-Fix

### Fixed

- **`bcrypt.hash is not a function`** — `bcryptjs` ist ein CommonJS-Modul; `await import('bcryptjs')` in ESM gibt `{ default: module }` zurück, nicht das Modul direkt. Dynamischer Import durch statischen `import bcrypt from 'bcryptjs'` ersetzt — Postfach anlegen und Login funktionieren wieder.
- **SMTP Port-Toggle — Port bleibt aktiv** — `smtp-server` (nodemailer) legt den internen `net.Server` unter `this.server` ab (nicht `this._server`). Der Zugriff über `._server` lieferte `undefined` → `closeAllConnections()` wurde nie aufgerufen → Port blieb trotz Toggle aktiv. Property-Name auf `.server` korrigiert. IMAP und POP3 nutzen `net.Server` direkt, `(server as any).closeAllConnections?.()` bleibt unverändert.

---

## [2.1.25] — 2026-05-17 — bcrypt-Fix + Port-Toggle sofortig wirksam

### Fixed

- **bcrypt fehlende Runtime-Dependency** — `bcrypt` war nur als `@types/bcrypt` in `devDependencies` vorhanden, nie als tatsächliche Laufzeit-Abhängigkeit. Import von `bcrypt` schlug im Container mit `Cannot find package 'bcrypt'` fehl, was Postfach-Erstellung und Login unmöglich machte. Gewechselt auf `bcryptjs` (pure JavaScript, keine nativen Bindings, kein node-gyp nötig) — vollständig API-kompatibel.
- **Services Port-Toggle — Port blieb laut netstat aktiv** — `server.close()` akzeptiert keine neuen Verbindungen mehr, wartet aber auf bestehende Verbindungen (z. B. Health-Check-Polls) bevor der Callback feuert. Das `await` hing → Port blieb am System registriert. Jetzt wird vor `close()` explizit `closeAllConnections()` (Node.js 18.2+) aufgerufen, das alle offenen Sockets sofort terminiert. SMTP nutzt `server._server.closeAllConnections()` (da `smtp-server`-Paket `net.Server` intern kapselt), IMAP und POP3 direkt.

### Changed

- **`@coremail/core`** — `bcryptjs ^2.4.3` als Runtime-Dependency hinzugefügt, `@types/bcrypt` durch `@types/bcryptjs ^2.4.6` ersetzt.

---

## [2.1.24] — 2026-05-17 — Postfach-Erstellung Fix + Services Port-Toggle

### Fixed

- **Postfach anlegen (BCP)** — `POST /admin/mailboxes` hatte kein `try-catch`; Prisma-Fehler führten zu hängenden Requests in Express v4. Jetzt werden alle Fehler abgefangen und als verständliche Fehlermeldung zurückgegeben. E-Mail-Adresse wird jetzt beim Erstellen normalisiert (Lowercase).
- **Services Port-Toggle** — Toggle in der UI speicherte nur den DB-Zustand; der laufende SMTP/IMAP/POP3-Dienst blieb am Port aktiv. Jetzt wird nach dem Toggle ein Redis-Signal (`service:listeners:reload`) publiziert. SMTP-, IMAP- und POP3-Server subscriben diesen Channel und starten/stoppen den entsprechenden Port dynamisch ohne Neustart.

### Changed

- **SMTP/IMAP/POP3-Server** — Listener werden in einer `Map<port, Server>` verwaltet; `reloadListeners()` synchronisiert die laufenden Ports mit der DB-Konfiguration.
- **`@coremail/core`** — Neuer Pub/Sub-Channel `CHANNEL_SERVICE_LISTENERS_RELOAD = 'service:listeners:reload'` exportiert.

---

## [2.1.23] — 2026-05-17 — BCP Server-Seite bereinigt

### Removed

- **Mail-Protokolle (BCP → Server → Virtuelle Verzeichnisse)** — Sektion mit IMAP/POP3/SMTP Host, Port und TLS-Toggle entfernt; diese Konfiguration gehört zu den Protokoll-Listenern unter Services, nicht zu den Autodiscover-Einstellungen
- **Organisationsname (BCP → Server → Virtuelle Verzeichnisse)** — doppeltes Feld entfernt; Organisationsname wird bereits an anderer Stelle verwaltet

---

## [2.1.22] — 2026-05-17 — ECP Theme-Unabhängigkeit + MFA TOTP für OWA

### Added

- **MFA TOTP Login-Flow (OWA)** — Zweistufige Anmeldung nach RFC 6238: nach E-Mail/Passwort erscheint bei aktivierter 2FA ein 6-stelliger OTP-Eingabe-Dialog mit Auto-Focus, Paste-Support und Zurück-Button; `login()` in `api/client.ts` gibt nun Union-Typ `{ accessToken, refreshToken } | { mfaRequired, challengeToken, method }` zurück
- **MFA TOTP Verwaltung (OWA-Einstellungen → Sicherheit)** — Vollständige inline TOTP-Verwaltung ersetzt Platzhalter-Link: QR-Code anzeigen, Secret manuell kopieren, Code bestätigen, Backup-Codes generieren/kopieren, Backup-Codes neu generieren, 2FA deaktivieren; Status-Badge (Aktiv/Inaktiv) mit verbleibendem Backup-Code-Zähler
- **`GET /auth/mfa/status`** — Neuer Endpunkt im auth-service: gibt `totpEnabled`, `webauthnCount`, `backupCodesCount` zurück (nur für authentifizierte User)

### Changed

- **ECP Akzentfarbe — immer Microsoft Blau** — `--color-accent` im Admin-Panel ist auf `0 120 212` hardcodiert; ändert sich nicht mehr wenn im OWA-Frontend eine andere Akzentfarbe gewählt wird
- **ECP Dark Mode — unabhängig vom OWA** — Admin-Panel nutzt eigenen `coremail-ecp-theme` localStorage-Key (vorher `coremail-theme`); kein Cross-Tab-Sync mehr mit OWA; Light/Dark/System kann im ECP separat gesteuert werden
- **ECP Theme-Store** — `accentRgb` und `setAccent` entfernt; nur noch `theme` + `setTheme` im Store; `ACCENT_COLORS` und `ACCENT_RGB`-Konstante aus `store/theme.ts` entfernt

---

## [2.1.21] — 2026-05-17 — ECP TopBar: Angemeldeter User + Theme-Toggle

### Added

- **TopBar im Admin-Panel (ECP)** — Neue horizontale Kopfzeile über Sidebar + Content: zeigt angemeldeten Benutzer (E-Mail aus JWT-Payload, Rolle als Badge) mit Avatar-Initialen und Dropdown für Abmelden; Theme-Umschalter (System → Hell → Dunkel) als Icon-Button direkt in der TopBar
- **Theme-Store (ECP)** — Zustand-Store `useThemeStore` in `admin-panel/store/theme.ts`; nutzt denselben `coremail-theme` localStorage-Key wie OWA; Cross-Tab-Sync via StorageEvent; `ThemeApplier` reagiert auf Store-Änderungen statt direktem localStorage-Read

### Changed

- **Sidebar** — Header-Block (Logo + Titel) und Logout-Button entfernt; beides ist jetzt in der TopBar

---

## [2.1.20] — 2026-05-17 — Toggle-Fix, Dark Mode ECP, Rspamd-Auth, Navigation

### Fixed

- **Schutzfilter — Toggle-Schalter** — Knob-Position bei aktivem Zustand korrigiert (`translate-x-[22px]` statt `translate-x-5`); Knob bleibt im Dark Mode weiß (inline style verhindert CSS-Override)
- **Rspamd offline im ECP** — `secure_ip` in `worker-controller.inc` ergänzt: Docker-RFC-1918-Netze dürfen die Controller-API ohne Passwort aufrufen; Status-Check nutzt `/ping` statt `/auth-pflichtigem /stat`
- **Passwort ändern** — Pepper beim `bcrypt.compare` und `bcrypt.hash` im `change-password`-Endpoint ergänzt

### Added

- **Dark Mode Admin-Panel (ECP)** — `darkMode: 'class'` in Tailwind-Config; `ThemeApplier` liest `coremail-theme` aus localStorage (geteilt mit OWA); CSS-Overrides für alle häufigen Utility-Klassen ohne JSX-Änderungen an den 30+ Seiten

### Changed

- **Navigation** — „SMTP-Konfiguration" umbenannt in „SMTP & Routing"

---

## [2.1.19] — 2026-05-17 — Observability-Stack entfernt

### Removed

- **Grafana**, **Prometheus**, **Alertmanager**, **Tempo**, **Loki**, **OTEL Collector** vollständig aus dem Docker-Stack entfernt — der `--profile observability` Abschnitt existiert nicht mehr
- Entsprechende Docker-Volumes (`prometheus-data`, `alertmanager-data`, `grafana-data`, `tempo-data`, `loki-data`) aus `docker-compose.yml` entfernt

### Changed

- `docker-compose.yml` — auf v2.1.19 aktualisiert, Observability-Block entfernt, Kommentar-Header bereinigt
- `docker-compose.synology.yml` — auf v2.1.19 + Image `magpeek/coremail-app:2.1.19` aktualisiert; **rspamd und clamav ergänzt** (fehlten bisher im Synology-Compose)
- README.md — Observability-Abschnitt entfernt, Feature-Tabelle angepasst
- CLAUDE.md — Observability-Sektion durch Logging-Sektion ersetzt

---

## [2.0.19] — 2026-05-16 — Passwort ändern & Design-Einstellungen

### Added

- **OWA Passwort ändern (Einstellungen → Konto → Passwort)** — Neuer Abschnitt in den OWA-Benutzereinstellungen:
  - Formular mit aktuellem Passwort, neuem Passwort und Bestätigung
  - Echtzeit-Stärkemeter (4-stufig: Schwach / Mittel / Gut / Stark) mit farbiger Balkenanzeige
  - Passwort-Sichtbarkeit-Toggle für aktuelles und neues Passwort
  - Inline-Fehlermeldung bei nicht übereinstimmendem Passwort
  - Schaltfläche nur aktiv wenn Formular vollständig und gültig
- **OWA Design-Einstellungen (Einstellungen → Allgemein → Design)** — Neuer Abschnitt für Erscheinungsbild:
  - **Farbschema-Auswahl** — 3 Karten mit Live-Vorschau: Hell / Dunkel / System (folgt OS-Präferenz automatisch)
  - **6 Akzentfarben** — Microsoft Blau, Teams Lila, Grün, Orange, Türkis, Pink; sofortige Anwendung ohne Reload
  - Persistente Speicherung in `localStorage` via Zustand `persist` Middleware
  - Dark-Mode via `dark`-Klasse auf `<html>` (Tailwind `darkMode: 'class'`)
  - Accent-Farbe über CSS-Variable `--color-accent` auf `<html>`, Tailwind-Config auf RGB-Variable-Muster umgestellt (opacity modifiers `bg-accent/10` bleiben voll funktionsfähig)
- **API `POST /api/v1/user/change-password`** — Passwort-Änderung mit bcrypt-Verifikation des aktuellen Passworts, Stärkeprüfung (min. 8 Zeichen), bcrypt-Hash (cost 12) des neuen Passworts
- **`ThemeApplier`-Komponente** in `App.tsx` — setzt `dark`-Klasse und `--color-accent` CSS-Variable bei Laden und bei Änderungen; reagiert auf OS-Farbschema-Änderungen beim `system`-Modus

---

## [1.9.19] — 2026-05-16 — SSO & LDAP / Active Directory

### Added

- **SSO-Verwaltung (ECP → Infrastruktur → SSO)** — Sub-Navigation mit 3 Bereichen:
  - **OIDC-Anbieter** — Liste aller konfigurierten OIDC/OAuth2-Provider; Hinzufügen mit Schnellauswahl (Azure AD, Google Workspace, Keycloak, Authentik, Okta, GitHub); Discovery-URL-Test (Verbindung + Issuer-Verifikation); Aktivieren/Deaktivieren; Auto-Provisionierung pro Provider; Bearbeiten + Löschen
  - **SAML 2.0** — SP-Metadaten (Entity ID, ACS-URL, SLO-URL, Metadata-XML); Liste unterstützter IdPs (Azure Entra, Okta, OneLogin, ADFS, Shibboleth, Google Workspace); Hinweis auf Konfiguration via Umgebungsvariablen
  - **Einstellungen** — Lokale Anmeldung als Fallback, SSO-Button auf Login-Seite, automatische Weiterleitung, Redirect-URIs-Referenz
- **LDAP / Active Directory-Verwaltung (ECP → Infrastruktur → LDAP / Active Dir.)** — Sub-Navigation mit 4 Bereichen:
  - **Verbindungen** — Tabelle aller konfigurierten LDAP-Verbindungen (Domain, Host, BaseDN, Sync-Status, letzter Sync); Neue Verbindung, Bearbeiten, Löschen, manueller Sync je Verbindung
  - **Konfigurationsformular** — Host/Port/LDAPS, Base DN, Bind DN + Passwort, User DN, Benutzerfilter mit `{{username}}`-Platzhalter, Gruppenfilter, Sync-Toggle; Verbindungstest (TCP-Erreichbarkeit)
  - **Synchronisation** — Übersicht aller Verbindungen mit Status und letztem Sync; „Jetzt synchronisieren"-Button je Domain
  - **Attributzuordnung** — Mapping LDAP-Attributname → CoreMail-Feld (mail, displayName, givenName, sn, uid) mit AD/OpenLDAP-Hinweisen
- **API `GET|POST|PUT|DELETE /api/v1/admin/sso/providers`** — OIDC-Provider-CRUD
- **API `POST /api/v1/admin/sso/providers/:id/test`** — Discovery-URL + Issuer testen
- **API `GET /api/v1/admin/sso/domains`** — verfügbare Domains
- **API `GET|PUT|DELETE /api/v1/admin/ldap/:domainId`** — LDAP-Konfig CRUD
- **API `POST /api/v1/admin/ldap/:domainId/test`** — TCP-Verbindungstest
- **API `POST /api/v1/admin/ldap/:domainId/sync`** — manuellen Sync triggern
- **Sidebar** — SSO und LDAP/Active Dir. als separate Einträge unter Infrastruktur; Info-Eintrag ans Ende der gesamten Navigation verschoben (unterhalb Einstellungen)
- **README.md** — vollständig aktualisiert: Version 1.9.19, 6-Container-Architektur, aktualisierte Feature-Tabellen, Versionsverlauf-Tabelle, neue API-Beispiele

---

## [1.8.19] — 2026-05-16 — Message Queue Management

### Added

- **ECP Warteschlangenverwaltung** — vollständige Neuentwicklung mit dunkler Sub-Navigation (5 Bereiche):
  - **Übersicht** — 5 Stat-Cards (Wartend/Aktiv/Wiederholung/Dead Letter/Zugestellt), Queue-Verteilung als Balkenchart, klickbare Karten navigieren direkt zum jeweiligen Bereich, Dead-Letter-Warnbanner mit Link
  - **Ausgehend** — Tabelle wartender + aktiver Nachrichten: Absender, Empfänger, Zeitstempel mit Altersanzeige, Versuche-Badge (farbig), expandierbare Detailzeile (Job-ID, Message-ID, DKIM-Domain, Stacktrace), Löschen
  - **Wiederholung** — Retry-Queue (exponential Backoff): Nächster-Versuch-Spalte, manuelles Retry und Löschen pro Nachricht
  - **Dead Letter** — fehlgeschlagene Nachrichten: Fehlerursache + Stacktrace im Detailpanel, Einzelrestart, „Alle wiederholen", Queue leeren
  - **Einstellungen** — Retention, Retry, Auto-Flush, Benachrichtigung
- **Einstellungen (QueueSettings)**:
  - Max. Wiederholungsversuche (1–50, Standard 10) mit Zeitplan-Vorschau (exponential Backoff)
  - Basis-Backoff-Delay (10–3600 Sek., Standard 60 s) — verdoppelt sich pro Versuch
  - Dead-Letter-Aufbewahrung (1–365 Tage, Standard 7 Tage)
  - Ausgehende Queue Aufbewahrung (1–720 Stunden, Standard 48 h)
  - Zugestellte Nachrichten Aufbewahrung (1–720 Stunden, Standard 24 h)
  - Automatische Dead-Letter-Bereinigung (Toggle)
  - Warnung bei neuen Dead Letters (Toggle)
  - RFC 5321 § 4.5.4.1 Hinweis (min. 120 Stunden / 5 Tage empfohlen)
- **Prisma-Modell `QueueSettings`** — Singleton-Modell mit 8 Konfigurationsfeldern
- **BullMQ-Integration in api-gateway** — direkte Queue-Abfragen über BullMQ `Queue`-Klasse (statt Raw-Redis-Listen):
  - `GET /api/v1/admin/queues/stats` — Zähler je State (waiting/active/delayed/failed/completed)
  - `GET /api/v1/admin/queues/jobs` — Paginierte Job-Liste filterbar nach State
  - `POST /api/v1/admin/queues/jobs/:id/retry` — Einzelnen fehlgeschlagenen Job wiederholen
  - `POST /api/v1/admin/queues/retry-failed` — Alle fehlgeschlagenen Jobs auf einmal wiederholen
  - `DELETE /api/v1/admin/queues/jobs/:id` — Einzelnen Job entfernen
  - `POST /api/v1/admin/queues/flush` — Queue nach State leeren (failed/delayed/completed)
  - `GET/PUT /api/v1/admin/queues/settings` — Queue-Einstellungen CRUD

### Changed

- **QueuesPage** — komplett neu gebaut (ersetzt die einfache Redis-List-Ansicht)
- **SMTP-Outbound-Queue API** — nutzt jetzt BullMQ `Queue`-Klasse direkt (kein Raw-`LRANGE` mehr)

---

## [1.7.19] — 2026-05-16 — Quarantine Detail-View & Compliance Info

### Added

- **Quarantine Detail-Ansicht** — vollständige Quarantäne-Verwaltung mit Slide-over-Panel (600 px):
  - Klickbare Stat-Cards (Ausstehend/Virus/Spam/Richtlinie/Freigegeben/Gesamt) — filtern direkt die Tabelle
  - Suchleiste (Absender/Empfänger/Betreff), Reason-Dropdown, Released/Pending/Alle-Tabs
  - Bulk-Selektion mit Checkboxen + Massen-Lösch-Aktionsleiste
  - Detailpanel pro Eintrag: E-Mail-Metadaten, Filter-Details als JSON, geparste E-Mail-Header (From/To/Subject/Date/Message-ID/X-Spam-Score/Authentication-Results etc.), Body-Vorschau (2000 Zeichen aus MinIO)
  - Release/Löschen direkt im Detailpanel; Virus-Nachrichten können nicht freigegeben werden
  - `CleanupModal` — Massen-Bereinigung nach Alter (1–365 Tage) und optional nur freigegebene Einträge
  - Nummernpagination (Erste/Zurück/Nummern/Weiter/Letzte)
- **API `GET /api/v1/admin/quarantine/:id`** — liefert Einzel-Eintrag mit MIME-Vorschau aus MinIO (geparste Header + bereinigter Body-Text)
- **Compliance → Info** — Versionshistorie auf `1.7.19` aktualisiert, Einträge für v1.6.19 und v1.7.19 ergänzt
- **`api.deleteWithBody`** — neue Methode im API-Client für DELETE-Anfragen mit Body (für Bulk-Bereinigung)

---

## [1.6.19] — 2026-05-16 — ECP: SMTP-Infrastruktur-Konfiguration

### Added

- **SMTP-Konfiguration** — neue ECP-Seite unter Infrastruktur mit 6 Unterbereichen:
  - **ESMTP-Befehle** — Tabelle aller ESMTP-Erweiterungen (STARTTLS, AUTH PLAIN/LOGIN/CRAM-MD5, PIPELINING, SIZE, 8BITMIME, ENHANCEDSTATUSCODES, SMTPUTF8, DSN, CHUNKING) mit RFC-Referenz, Risiko-Badge (Standard/Vorsicht/Erweitert) und Einzel-Toggle; Sicherheitshinweise bei Deaktivierung sicherheitsrelevanter Extensions
  - **Lokale Zustellung** — Allow/Disallow lokal; visuelle Vergleichskarte für aktiviert vs. deaktiviert (Postfächer/Verteilergruppen/Ressourcen vs. reiner Relay-Modus)
  - **SMTP-Banner** — Override des Standard-Banners (`hostname CoreMail ESMTP`); Freitextfeld, Live-Vorschau als Terminal-Mockup (220-Response + EHLO-Dialog), RFC-Hinweis zu Security through obscurity
  - **Greylisting** — Aktivierungs-Toggle, Wartezeit (Sek.), Whitelist-TTL (Std.), Ablauf-Illustration (3-Schritte), IP/CIDR-Whitelist mit Quick-Add für lokale Netze
  - **Relaying** — Allow/Deny Relay; Relay-Domains-Liste; vertrauenswürdige IP-Ranges (Relay ohne Auth); Auth-Pflicht-Toggle; Open-Relay-Warnung; Quick-Add für RFC 1918 Netze
  - **Verbindungseinstellungen** — Max. Verbindungen gesamt/je IP, Max. Empfänger/Nachricht, Max. Auth-Fehlversuche, Max. Nachrichtengröße (MB), Verbindungs-Timeout (RFC 5321 min. 300s), Greeting Delay (gegen Spam-Bots)
- **Prisma-Modell `SmtpSettings`** — 27 Felder für alle SMTP-Konfigurationsparameter
- **API `GET/PUT /api/v1/admin/smtp-config/settings`**

---

## [1.5.19] — 2026-05-16 — Rspamd 4.0 + ClamAV + Compliance-Info

### Added

- **Rspamd 4.0 als separater Docker-Container** (`rspamd/rspamd:4.0.0`) — vollständige Anti-Spam-Engine mit Bayes-Klassifikator, DKIM/SPF/DMARC, URL-Reputationsprüfung, Fuzzy-Hashing
- **ClamAV als separater Docker-Container** (`clamav/clamav:stable`) — freie Open-Source Antivirus-Engine (GPL) mit automatischen Signatur-Updates via freshclam
- **ECP Schutzfilter-Seite** — komplett neu mit Sub-Navigation (7 Bereiche):
  - **Übersicht**: Live-Container-Status (Rspamd + ClamAV online/offline), Statistiken (gescannt/spam/ham/uptime), Schutzmaßnahmen-Tabelle
  - **Rspamd 4.0**: Aktions-Schwellwerte (Greylist/Spam/Reject), Echtzeit-Statistiken, Bayes-Training (Spam/Ham), Modul-Übersicht (10 aktive Module)
  - **Antivirus**: ClamAV-Status, Version, freshclam-Info, Aktivierungs-Toggle
  - **DNSBL**: Zone-Verwaltung (hinzufügen/entfernen), Quick-Add für bekannte Blacklisten (Spamhaus, SpamCop, Barracuda, SORBS…)
  - **Greylisting**: Wartezeit, Whitelist-TTL, Erklärung des Ablaufs
  - **Länderfilter**: Modus (Disabled/Whitelist/Blacklist), Länderauswahl mit Suche (80+ Länder)
  - **Anhänge-Filter**: Max. Größe, blockierte Dateiendungen (hinzufügen/entfernen), Quick-Add
- **Prisma-Modell `SecuritySettings`** — 14 Felder für alle Filtereinstellungen (Greylisting, DNSBL, GeoIP, Anhänge, Rspamd-Scores, ClamAV)
- **API `GET/PUT /api/v1/admin/security/settings`** — CRUD für SecuritySettings
- **API `GET /api/v1/admin/security/status`** — Live-Status von Rspamd + ClamAV
- **API `GET /api/v1/admin/security/rspamd/stat`** — Rspamd-Statistiken
- **API `POST /api/v1/admin/security/rspamd/learn/:type`** — Bayes-Training (spam/ham)
- **Compliance → Info** — neue Seite mit Versionsnummer, Build-Datum, Links zu GitHub/Changelog/Releases/Issues, Technologie-Stack-Badge, Versionshistorie

### Changed

- **Docker Compose** — Rspamd und ClamAV als Pflicht-Abhängigkeiten des coremail-Containers; eigene Volumes (`rspamd-data`, `clamav-data`)
- **`coremail`-Image** aktualisiert auf `magpeek/coremail-app:1.5.19`

---

## [1.4.19] — 2026-05-16 — OWA: Signaturen, Automatische Antworten, Speicher

### Added

- **Signaturen (OWA-Einstellungen)** — Tiptap Rich-Text-Editor für die E-Mail-Signatur; Toggles „Automatisch bei neuen E-Mails einfügen" (`autoNew`) und „Automatisch bei Antworten einfügen" (`autoReply`); gespeichert über `PUT /api/v1/user/signature`
- **Automatische Antworten / OOF (OWA-Einstellungen)** — Vollständiger Abwesenheitsassistent: Aktivierungs-Toggle, optionaler Zeitraum (Start/Ende mit Uhrzeit stündlich), interne Nachricht, externe Nachricht mit „Nur an Kontakte"-Option; bei gesetztem Zeitraum wird automatisch ein Kalender-Event (`oof-<userId>`) erstellt/aktualisiert
- **Speicher (OWA-Einstellungen)** — Quotaanzeige, gestapeltes farbiges Balkendiagramm pro Ordner, Tabelle mit Ordner/Größe/Nachrichten und „Leeren"-Button mit Inline-Bestätigung
- **Auto-Signatur im Compose-Fenster** — Signatur wird beim Öffnen einer neuen Mail automatisch eingefügt wenn `autoNew=true`, bei Antworten wenn `autoReply=true`
- **`GET /api/v1/user/storage`** — Aggregiert Speichernutzung pro Ordner via Prisma `groupBy` (`rawSize`, Nachrichtenanzahl)
- **`DELETE /api/v1/user/folders/:id/empty`** — Leert einen Ordner (Soft-Delete aller Nachrichten, Counter zurückgesetzt)

### Changed

- **Prisma-Schema `UserSettings`** — 9 neue Felder: `signatureAutoNew`, `signatureAutoReply`, `oofEnabled`, `oofInternal`, `oofExternal`, `oofExternalEnabled`, `oofExternalOnlyContacts`, `oofUseTimeRange`, `oofStart`, `oofEnd`
- **`FolderTree`** — Feste Reihenfolge der System-Ordner: Posteingang → Entwürfe → Gesendete Elemente → Gelöschte Elemente → Junk-E-Mail → Archiv; deutsche Anzeigenamen
- **`SettingsPage` (OWA)** — Komplett überarbeitet mit OWA-Stil-Navigation (Konto: E-Mail-Konto / Automatische Antworten / Signaturen / Speicher; Allgemein: Sicherheit)

---

## [1.3.19] — 2026-05-16 — ECP: Connectors (Send/Receive) entfernt

### Removed

- **Send Connectors und Receive Connectors** komplett entfernt — für einen einfachen Mailserver ohne Relay-Infrastruktur nicht nötig; Sendeconnectors = Routing-Regeln, Empfangsconnectors = IP-Autorisierung, beides nicht standard-relevant

### Changed

- **`ServicesPage`** — übernimmt jetzt die Listener-Verwaltung (SMTP Inbound / IMAP / POP3) mit Übersicht und Sub-Navigation
- **Sidebar** — „Connectors" aus Nachrichtenfluss entfernt, „Services" in Infrastruktur verschoben
- **`/connectors` Route** — Redirect zu `/services`

---

## [1.3.18] — 2026-05-16 — ECP: Services bereinigt (SMTP Sending entfernt)

### Changed

- **`ConnectorsPage` → Services** — „SMTP Sending" aus den Listener-Services entfernt: Sendeconnectors sind Routing-Regeln, keine Listener. Services zeigen jetzt nur noch die drei echten Protokoll-Listener: **SMTP Inbound** (25/465/587), **IMAP** (143/993), **POP3** (110/995)
- **Services-Übersicht** — Karten-Layout auf 3 Spalten angepasst, Port-Nummern unter dem Label angezeigt

---

## [1.3.17] — 2026-05-16 — ECP: Services und Connectors zusammengeführt

### Changed

- **`ConnectorsPage`** — Services-Verwaltung (Protokoll-Listener) direkt in die Connectors-Seite integriert. Neue linke Sub-Navigation mit zwei Bereichen: **Connectors** (Alle / Sendeconnectors / Empfangsconnectors) und **Services** (Übersicht / SMTP Receiving / SMTP Sending / IMAP / POP3). Standard-Ansicht beim Öffnen ist „Alle Connectors"
- **`Sidebar`** — Eintrag „Services" aus dem Infrastruktur-Bereich entfernt (Services sind jetzt unter Connectors → Nachrichtenfluss erreichbar)
- **`/services` Route** — Redirect zu `/connectors` (Rückwärtskompatibilität)

---

## [1.3.16] — 2026-05-16 — Bugfix: API-Response-Mismatch domains (Objekt statt Array)

### Fixed

- **`MailboxesPage`, `GroupsPage`, `ResourcesPage`, `SharedMailboxesPage`** — `GET /admin/domains` gibt ein paginiertes Objekt `{ domains, total, page, limit }` zurück, aber alle vier Pages haben die Antwort direkt als `Domain[]`-Array verwendet → `N.map is not a function`-Crash. Alle Queries verwenden jetzt `.then(r => r.domains)` um das Array korrekt zu extrahieren
- **`SharedMailboxesPage` User-Suche** — `GET /admin/mailboxes` gibt ein Plain-Array zurück, aber die Query erwartete `{ items: User[] }` und rief `.items` darauf auf → `undefined`. Jetzt mit korrektem Array-Handling + clientseitigem Filter

---

## [1.3.15] — 2026-05-16 — Bugfix: Null-sichere Filter-Funktion in MailboxesPage + GroupsPage

### Fixed

- **`MailboxesPage`: `filter`-Funktion crashte bei null `displayName`/`email`** — `u.displayName.toLowerCase()` und `u.email.toLowerCase()` warfen `TypeError: Cannot read properties of null` wenn ein User-Datensatz null-Felder enthielt. Mit `(u.displayName ?? '').toLowerCase()` und `(u.email ?? '').toLowerCase()` abgesichert
- **`GroupsPage`: identisches Problem** — `g.displayName.toLowerCase()` und `g.email.toLowerCase()` im Filter ebenfalls null-sicher gemacht

---

## [1.3.14] — 2026-05-16 — Bugfix: React Error Boundary + Null-sichere MailboxesPage

### Fixed

- **React Error Boundary** — ohne Error Boundary führt jeder Render-Fehler in einer Seite zu einer komplett weißen Seite (React demontiert den gesamten Baum). Neue `ErrorBoundary`-Klasse um `<main>` im AdminLayout gewickelt: zeigt Fehlermeldung + Stack-Trace + „Seite neu laden"-Button statt Blank-Page
- **`MailboxesPage`: null-sichere `displayName`-Behandlung** — `u.displayName.charAt(0)` crashte mit `TypeError` wenn `displayName` null war (z.B. ältere Datenbankeinträge). Jetzt mit `(u.displayName ?? u.email ?? '?').charAt(0)` abgesichert
- **Sidebar Logout-Redirect** — `window.location.href = '/login'` (falscher absoluter Pfad) auf `/ecp/login` korrigiert

---

## [1.3.13] — 2026-05-16 — Bugfix: Auth-Middleware 401 + Virtuelle Verzeichnisse Fehlerbehandlung

### Fixed

- **`requireAuth`-Middleware** — `jwt.verify()` kann synchron `TokenExpiredError` werfen; war bislang außerhalb des try-catch-Blocks → Express propagierte den Fehler als unkontrollierter 500-Fehler statt 401. Jetzt vollständig in try-catch gewickelt; abgelaufene Tokens und ungültige Tokens geben immer HTTP 401 zurück
- **Admin-Panel: Virtuelle Verzeichnisse-Tab** (`ServersPage.tsx`) — zeigte bei HTTP-Fehler (z.B. 500 durch den obigen Auth-Bug) endlos den Lade-Spinner. Jetzt: explizite `isError`-Behandlung mit roter Fehlerkarte, Fehlermeldung und „Erneut versuchen"-Button
- **Admin-Panel: 401-Redirect** (`client.ts`) — `window.location.href = '/login'` verwies auf einen falschen absoluten Pfad. Korrigiert auf `/ecp/login` (korrekte Basis-URL des BrowserRouter `basename="/ecp"`)

---

## [1.3.12] — 2026-05-16 — Bugfix: SMTP-Server-Crash (BullMQ + Thread-Erschöpfung)

### Fixed

- **Thread-Erschöpfung beim Start** — `pids_limit: 200` war zu niedrig für 12 gleichzeitig startende Node.js-Services (jeder ~10 Threads); führte zu `pthread_create: Resource temporarily unavailable` → Prisma-Tokio-Runtime-Panic (`futures-timer: timer has gone away`). Limit auf 500 erhöht
- **`CAP_KILL` fehlte** — supervisord (root) konnte kein SIGTERM an node-User-Child-Prozesse senden → `supervisorctl stop` schlug mit `PermissionError: Operation not permitted` fehl. `KILL`-Capability in `cap_add` aufgenommen
- **BullMQ Worker `maxRetriesPerRequest: null`** — gemeinsam genutzter `getRedisClient()` lieferte IORedis-Instanz mit `maxRetriesPerRequest: 3`; BullMQ-Worker verweigern das. Neue dedizierte `createBullMqConnection()` in `packages/core/src/redis/index.ts` mit `maxRetriesPerRequest: null`, verwendet in `smtp-server/outbound/queue.ts` und `api-gateway/dashboard.ts`

---

## [1.3.11] — 2026-05-16 — Bugfix: BullMQ Queue-Name + Prisma $queryRaw Tabellenname

### Fixed

- **BullMQ Queue-Name** — `smtp:outbound` enthielt einen Doppelpunkt, den BullMQ v5 nicht erlaubt. Der synchrone Fehler in `new Queue()` unterbrach den Async-Flow des SMTP-Servers und hinterließ die Prisma/Tokio-Runtime ohne sauberes Shutdown → Rust-Panic `timer has gone away`. Korrigiert auf `smtp-outbound`
- **Prisma `$queryRaw` Tabellenname** — `"Message"` (PascalCase) → `"messages"` (snake_case lowercase); Prisma-Migrationen legen Tabellen in Kleinbuchstaben an, PascalCase erzeugte PostgreSQL-Fehler 42P01 (`relation does not exist`)

---

## [1.3.10] — 2026-05-16 — Bugfix: Multi-Port SMTP/IMAP + Auth-Service Portkonflikt

### Fixed

- **SMTP/IMAP Multi-Port** — Startup-Fehler beim Binden mehrerer Ports (25/465/587 bzw. 143/993) behoben
- **Auth-Service Portkonflikt** — Ports bereinigt, kein Konflikt mehr beim parallelen Start der Services
- **Redis-Container** — startet jetzt direkt als `redis`-User (UID/GID 999:999); Docker-`command`-Syntax und Capabilities für den Redis-Container korrigiert

---

## [1.3.9] — 2026-05-16 — Security Hardening (OWASP, Container-Härtung)

### Added

- **Helmet HTTP-Security-Header** (OWASP A05) — alle Antworten erhalten:
  - `Content-Security-Policy` (kein eval, kein fremdes CDN, kein iframe)
  - `Strict-Transport-Security` (HSTS, 1 Jahr, includeSubDomains, preload)
  - `X-Content-Type-Options: nosniff` — MIME-Sniffing verhindert
  - `X-Frame-Options: DENY` — Clickjacking verhindert
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `X-DNS-Prefetch-Control: off`, `Permissions-Policy`
- **Rate-Limiting** (OWASP A07 — Brute Force) — `express-rate-limit`:
  - Globales Limit: 500 Requests / 15 min / IP
  - Auth-Endpunkte (`/auth/*`): max. 20 Versuche / 15 min / IP
  - Setup-Endpunkt: max. 5 Versuche / Stunde
  - Admin-Mutations: 200 mutierende Calls / 15 min / IP
- **Suspicious-Input-Guard** — blockt CRLF-Injection (Header-Splitting), Null-Bytes in Headern, Path-Traversal (`../`), Oversized-Headers (> 16 KB)
- **Request-ID** — jede Antwort erhält `X-Request-Id` (UUID) für Logging/Tracing
- **trust proxy** in Express konfiguriert — korrektes Rate-Limiting bei Reverse-Proxy-Einsatz

### Security

- **Mass-Assignment verhindert** (OWASP A04) — `PATCH /messages/:id` im Storage-API akzeptiert nur Whitelist-Felder (`flags`, `changeKey`, `modSeq`, `deletedAt`); direkte `req.body → data: req.body`-Übergabe an Prisma vollständig entfernt
- **Input-Validierung Storage-API** — alle Endpunkte validieren IDs (CUID-Format), Typen und Längen; Path-Traversal in MinIO-Keys geblockt; `PATCH /folders`, `POST /mailboxes`, `POST /messages` mit expliziter Feld-Whitelist
- **Storage-API bindet auf 127.0.0.1** — nicht mehr auf `0.0.0.0`; von außen unerreichbar
- **Cache-Control für HTML-Dateien** — `no-cache, no-store, must-revalidate` auf `index.html` (verhindert Caching veralteter SPAs)
- **ACME-Token-Validierung** — Nur `[a-zA-Z0-9_-]{1,128}` als Token akzeptiert
- **Dockerfile** — `setcap 'cap_net_bind_service=+eip'` auf dem Node-Binary; Laufzeit-Verzeichnisse gehören `node:node`
- **supervisord** — alle 11 Node.js-Prozesse laufen jetzt als `user=node` (UID 1000), nicht mehr als root
- **docker-compose.yml** — Container-Härtung für alle 4 Services:
  - `cap_drop: ALL` auf allen Containern — keine Capabilities außer den explizit benötigten
  - `coremail`: `cap_add: [NET_BIND_SERVICE, SETUID, SETGID, CHOWN, DAC_OVERRIDE]`
  - `postgres/minio`: `cap_add: [CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID]`
  - `redis`: kein `cap_add` — bindet nur auf Port 6379 (kein privilegierter Port)
  - `pids_limit` für jeden Container (200 / 100 / 50 / 100)
  - `tmpfs: /tmp` mit `noexec,nosuid,size=256m` (kein Code-Ausführen aus /tmp)
  - `no-new-privileges:true` für postgres, redis, minio (und alle Observability-Container)
  - Observability-Container (Prometheus, Grafana, Loki, Tempo) ebenfalls gehärtet

---

## [1.3.8] — 2026-05-16 — Cleanup + Status & Monitoring

### Added

- **ECP „Status & Monitoring"** — neue Sidebar-Gruppe mit:
  - **Warteschlangen** — vollständige Queue-Ansicht mit Mail-Details:
    - Summary-Karten für alle 4 Queues (Ausgehend / Retry / Dead Letter / Eingehend) mit Live-Zähler (5s Refresh)
    - Klick auf Karte öffnet Detail-Panel mit tabellarischer Mail-Liste
    - Spalten: Absender, Empfänger, Betreff, Eingestellt, Versuche
    - Aufklappbare Detailzeile: vollständige Felder inkl. Fehlermeldung
    - Einzelne Mail löschen, Queue leeren (Dead Letter)
    - Seitenweise Paginierung (50 Mails/Seite)
  - **Server & Health** — Server-Status und Einstellungen (ehemals unter Infrastruktur)

### Changed

- **README.md**: Alle Erwähnungen von „Microsoft Exchange" / „Exchange 2019" durch „Coremail der OpenSource Mailserver für kleine Umgebungen" ersetzt; Protokollnamen (EWS, ActiveSync, ECP) behalten aber ohne „Exchange"-Branding
- **README.md + CLAUDE.md**: Alle „Phase 5" – „Phase 10" Annotationen entfernt
- **ECP Sidebar**: „Mobile Geräte" entfernt; „Status & Monitoring" als neue Gruppe mit Warteschlangen + Server & Health
- **Warteschlangen**: Aus Gruppe „Nachrichtenfluss" in neue Gruppe „Status & Monitoring" verschoben

### Removed

- **ECP „Mobile Geräte"** (`/ecp/#/mobile`) — Seite aus Navigation entfernt

---

## [1.3.7] — 2026-05-16 — Feature: Audit-Log + OAuth2-Clients + SMTP-Gateway + Öffentliche Ordner + Notizen (OWA)

### Added

- **ECP „Audit-Log"** (`/ecp/#/audit-log`) — vollständige Admin-Aktionsprotokollierung:
  - Filterbares Log: Aktion, Zieltyp, Zeitraum (von/bis), Erfolg/Fehlschlag
  - Farbkodierte Action-Badges (CREATE=grün, DELETE=rot, UPDATE/PUT=blau, LOGIN=violett)
  - Aufklappbare Detailzeilen: Ziel-ID, Akteur-ID, Fehlermeldung, Änderungen als JSON
  - Paginierung (100 Einträge/Seite), CSV-Export, Bereinigungsfunktion (>90 Tage)
- **ECP „OAuth2-Clients"** (`/ecp/#/oauth-clients`) — OAuth2-Client-Verwaltung:
  - Tabelle: Client-ID, Name, Scopes, Trusted-Badge, Aktionen
  - Client erstellen: Name, Beschreibung, Redirect-URIs (mehrzeilig), Scope-Auswahl (8 Scopes), Trusted-Flag
  - Secret-Anzeige als 15s-Toast nach Erstellen und Secret-Rotation
  - Tab „Aktive Tokens": Token-Übersicht mit User, Scopes, Ablauf, Widerruf-Aktion
- **ECP „SMTP-Gateway"** (`/ecp/#/gateway`) — ausgehende Mails über vorgelagerten SMTP-Relay:
  - Toggle: Gateway aktivieren/deaktivieren
  - Upstream-Konfiguration: Host, Port, TLS, Benutzername, Passwort (leer = unverändert)
  - Verbindungstest mit Inline-Ergebnis (CheckCircle2 / XCircle)
  - Relay-Domains (leer = alle Domains), filterBeforeRelay-Option
- **ECP „Öffentliche Ordner"** (`/ecp/#/public-folders`) — Öffentlicher Ordner-Baum:
  - Rekursive Baumansicht (bis 3 Ebenen tief), aufklappbar/einklappbar
  - Stammordner und Unterordner erstellen, bearbeiten, löschen
  - Pro Ordner: Nachrichten-Zähler, Berechtigungsverwaltung (ACL)
  - ACL-Dialog: Benutzer per E-Mail hinzufügen, Berechtigung wählen (READ/WRITE/FULL), Einträge entfernen
- **OWA „Notizen"** (`/owa/#/notes`) — Sticky-Note-Verwaltung:
  - Farbige Notizkarten (YELLOW / BLUE / GREEN / PINK / PURPLE) im Grid-Layout
  - Volltext-Suche in Echtzeit (Debounce via Query-Key)
  - Notiz-Editor: Betreff, Textinhalt (mehrzeilig), Farb-Picker im Header
  - Erstellen / Bearbeiten / Löschen (Hover-Aktionen)
- **TopBar (OWA)**: „Notizen"-Tab mit StickyNote-Icon
- **Sidebar (ECP)**: „Öffentl. Ordner" unter Empfänger, „SMTP-Gateway" unter Nachrichtenfluss, „OAuth2-Clients" unter Infrastruktur, „Audit-Log" als eigenständiger Eintrag

---

## [1.3.6] — 2026-05-16 — Feature: Externe Kontakte + RBAC + eDiscovery + Journaling + Aufbewahrung im ECP

### Added

- **ECP „Externe Kontakte"** (`/ecp/#/ext-contacts`) — Admin-verwaltete externe E-Mail-Kontakte in der GAL:
  - Tabelle: Anzeigename, E-Mail, Unternehmen, Telefon, GAL-Sichtbarkeit
  - Volltext-Suche über Name, E-Mail, Unternehmen
  - Erstellen/Bearbeiten: Vor-/Nachname, Anzeigename, E-Mail, Unternehmen, Abteilung, Telefon, Mobil, Notizen, GAL ausblenden
- **ECP „Berechtigungen (RBAC)"** (`/ecp/#/rbac`) — Rollenzuweisung für alle Benutzer:
  - Tabelle aller User mit aktueller Rolle und Status
  - Inline-Dropdown: 8 Exchange-kompatible Rollen (OrganizationManagement, RecipientManagement, ServerManagement, ComplianceManagement, HygieneManagement, HelpDesk, ViewOnlyOrg, User)
  - Rollenbeschreibungs-Übersicht + Filter nach Rolle/Nur Admins
- **ECP „eDiscovery"** (`/ecp/#/ediscovery`) — Cross-Mailbox-Suche und Legal Hold:
  - Suchen: Erstellen, Starten (POST /run), Exportieren (POST /export), Löschen
  - Suchkriterien: Stichwörter, Betreff, Absender, Empfänger, Datum von/bis
  - Aufklappbare Kriteriendetails pro Suche, Status-Polling alle 5s
  - Legal Holds: Erstellen (Name, Postfach-IDs), Aufheben, Status-Anzeige
- **ECP „Journaling-Regeln"** (`/ecp/#/journaling`) — Compliance-Archivierung nach RFC 3462:
  - Tabelle: Regelname, Journal-Adresse, Scope, Gilt-für, Status-Toggle
  - Erstellen/Bearbeiten: Name, Journal-Adresse, Scope (ALL/INBOUND/OUTBOUND/INTERNAL), Empfängertyp, wrapAsReport-Option
- **ECP „Aufbewahrungsrichtlinien"** (`/ecp/#/retention`) — Automatisches Archivieren/Löschen:
  - Tabelle: Name, Aufbewahrungsdauer (lesbare Darstellung), Aktion-Badge, Scope, Zuweisungen, Status-Toggle
  - Erstellen/Bearbeiten: Tage (mit lesbarer Vorschau), Aktion (ARCHIVE/DELETE/MOVE_TO_FOLDER), Scope, Legal-Hold-Beachten
- **Backend `adminExternalContactsRouter`** — CRUD für externe Mail-Kontakte (`/api/v1/admin/contacts`)
- **Prisma-Modell `ExternalMailContact`** — `email`, `displayName`, `firstName`, `lastName`, `company`, `department`, `phone`, `mobile`, `hiddenFromGal`, `notes`
- **Sidebar-Sektion „Compliance"** — eDiscovery, Journaling, Aufbewahrung
- Sidebar-Eintrag **„Berechtigungen"** (ShieldHalf-Icon) und **„Ext. Kontakte"** (BookUser-Icon)

---

## [1.3.5] — 2026-05-16 — Feature: Verteilergruppen + Ressourcenpostfächer im ECP

### Added

- **ECP „Verteilergruppen"** (`/ecp/#/groups`) — vollständige Verwaltung statischer und dynamischer Gruppen:
  - Tabelle: Anzeigename, E-Mail, Typ-Badge (Statisch/Dynamisch), Mitgliederzahl, Status-Toggle, GAL-Sichtbarkeit
  - Aufklappbare Mitgliederliste pro Gruppe (Expand/Collapse)
  - Mitglieder hinzufügen: E-Mail + Typ (User / Shared Mailbox / Gruppe / Extern), Enter-Kürzel
  - Mitglieder entfernen per Hover-Icon
  - Dynamische Gruppen: LDAP-Filter-Feld statt manueller Mitgliederliste
  - Optionen: requireSenderAuth, allowExternal, moderationEnabled, hiddenFromGal
  - Filter: Alle / Statisch / Dynamisch + Freitextsuche
  - Erstellen / Bearbeiten / Löschen (mit Bestätigungsdialog)
- **ECP „Ressourcenpostfächer"** (`/ecp/#/resources`) — Raum- und Geräteverwaltung:
  - Tab-Umschaltung Räume / Geräte (je mit Anzahl-Badge)
  - Tabelle: Icon, Name, E-Mail, Standort, Kapazität (Räume), Auto-Accept-Status, Status-Toggle
  - Aufklappbarer Buchungskalender pro Ressource mit Datumsbereichsfilter
  - Buchungen anzeigen: Zeitraum, Organisator, Betreff, Status-Badge (ACCEPTED/PENDING/DECLINED)
  - Buchungen stornieren per Admin
  - Ressource erstellen: Typ, E-Mail, Domain, Anzeigename, Standort, Kapazität, Telefon, max. Dauer, Buchungsfenster, Auto-Accept/Decline/Recurring/Approval
  - Ressource bearbeiten / löschen (inkl. alle Buchungen)
- Sidebar-Eintrag **„Verteilergruppen"** (Users-Icon) und **„Ressourcen"** (Building2-Icon) in der Sektion „Empfänger"

---

## [1.3.4] — 2026-05-16 — Feature: Nachrichtenfluss-Connectors + Organisation + Adresslisten

### Added

- **ECP „Connectors"** (`/ecp/#/connectors`) — Sende-/Empfangsconnectors verwalten:
  - Separate Tabellen für Send- und Receive-Connectors mit Priority, Host:Port, TLS-Badge, Enabled-Status
  - Create/Edit-Modal: Name, Typ (SEND/RECEIVE), Host, Port, TLS, Require-TLS, Source-IPs, Ziel-Domains, Benutzername/Passwort, Priorität
  - PATCH `/:id/toggle` — Aktivieren/Deaktivieren ohne Reload
  - Passwort nie in API-Antworten enthalten (serverseitig ausgeblendet)
- **ECP „Organisation"** (`/ecp/#/organisation`) — 3 Tabs:
  - **Freigaberichtlinien** — Kalender-/Kontaktfreigabe für externe Domains (isDefault-Radio-Semantik, CalendarDetail-Level: FREEBUSY/LIMITED/FULL)
  - **Adresslisten** — Benutzerdefinierte Adresslisten + GAL-Flag, JSON-Filter
  - **Globale Adressliste (GAL)** — Live-Abfrage über Users, Shared Mailboxes, Verteilergruppen und Ressourcenpostfächer mit Suche
- **Backend `adminConnectorsRouter`** — vollständiges CRUD + PATCH toggle (`/api/v1/admin/connectors`)
- **Backend `adminOrganisationRouter`** — Sharing Policies + Address Lists CRUD + GAL Live-Query (`/api/v1/admin/organisation`)
- **ECP „Nachrichtenfluss-Trace"** (`/ecp/#/message-trace`) — Bereits in v1.3.3 enthalten, jetzt vollständig verknüpft
- **Prisma-Modell `MailConnector`** — `id`, `name`, `description`, `type` (SEND/RECEIVE), `enabled`, `host`, `port`, `tls`, `requireTls`, `sourceIps[]`, `targetDomains[]`, `username?`, `password?`, `priority`, `createdBy`
- **Prisma-Modell `SharingPolicy`** — `id`, `name`, `description`, `enabled`, `allowedDomains[]`, `allowCalendar`, `allowContacts`, `calendarDetail`, `isDefault`
- **Prisma-Modell `AddressList`** — `id`, `name`, `description`, `filter` (JSON), `isGal`

---

## [1.3.3] — 2026-05-16 — Feature: Shared Mailboxes + Quarantäne + Transportregeln + Mobile Geräte + Nachrichtenfluss-Trace

### Added

- **ECP „Freigegebene Postfächer"** (`/ecp/#/shared-mailboxes`) — Shared Mailbox Verwaltung:
  - Tabelle: E-Mail, Name, Quota, Status, Mitgliederzahl
  - Create/Edit-Modal mit Quota-Feld
  - Berechtigungsmodal: User suchen, Berechtigungstyp (FULL_ACCESS / SEND_AS / SEND_ON_BEHALF / READ_ONLY) zuweisen und entfernen
- **ECP „Quarantäne"** (`/ecp/#/quarantine`) — Spam- und Virus-Quarantäne:
  - Stats-Karten: Gesamt, Viren, Spam, Policy, Freigegeben, Ausstehend
  - Filter nach Grund (Alle/Virus/Spam/Policy) + Freigegebene anzeigen/ausblenden + Suche
  - Freigabe-Aktion (nur Nicht-Virus), Löschen einzeln, Bulk-Löschen (nach Alter + Filter)
- **ECP „Transportregeln"** (`/ecp/#/transport-rules`) — E-Mail-Transportregeln:
  - Regelübersicht mit Bedingungen/Aktionen-Vorschau, Priorität, Enabled-Toggle
  - Regeleditor-Modal: Name, Beschreibung, Priorität, dynamische Bedingungen (SENDER/RECIPIENT/SUBJECT/HEADER/SIZE/ATTACHMENT) und Aktionen (REDIRECT/COPY/ADD_HEADER/REMOVE_HEADER/REJECT/QUARANTINE/SET_SPAM_SCORE/PREPEND_SUBJECT/APPEND_DISCLAIMER)
  - POST /reorder — Massenpriorität-Update per Transaction
  - PATCH /:id/toggle — Aktivieren/Deaktivieren
- **ECP „Mobile Geräte"** (`/ecp/#/mobile`) — ActiveSync-Geräteverwaltung:
  - Tabelle: Gerät, User, Typ/OS, Status-Badge (OK/PENDING/BLOCKED/WIPED), zuletzt gesehen
  - Aktionen: Status ändern (Block/Freigabe), Remote Wipe, Löschen
  - Filter nach Status + Suche
- **ECP „Nachrichtenfluss-Trace"** (`/ecp/#/message-trace`) — Mail-Flow-Debugging:
  - Suchformular: Absender, Empfänger, Betreff, Status, Datum von/bis
  - Ergebnistabelle mit Zeitstempel, Von, An, Betreff, Status-Badge, Details-Klappzeile
  - CSV-Export via GET /export mit Content-Disposition-Header
- **Backend `adminSharedMailboxesRouter`** — CRUD + Berechtigungsverwaltung (`/api/v1/admin/shared-mailboxes`)
- **Backend `adminQuarantineRouter`** — GET (gefiltert + paginiert), Stats, Release, Delete, Bulk-Delete (`/api/v1/admin/quarantine`)
- **Backend `adminTransportRulesRouter`** — CRUD + Toggle + Reorder-Transaction (`/api/v1/admin/transport-rules`)
- **Backend `adminMobileRouter`** — Geräteliste, Status-Patch, Wipe, Delete (`/api/v1/admin/mobile`)
- **Backend `adminMessageTraceRouter`** — Liest SystemLog `MAIL_FLOW`-Kategorie, In-Memory-Filter, CSV-Export (`/api/v1/admin/message-trace`)
- **Sidebar-Neustrukturierung** — Gruppierte Navigation mit Sektionen: Empfänger / Nachrichtenfluss / Schutz / Infrastruktur

---

## [1.3.2] — 2026-05-15 — Feature: SSL/TLS Zertifikat-Verwaltung

### Added

- **ECP „Zertifikate"** (`/ecp/#/certificates`) — vollständige SSL/TLS-Verwaltung:
  - Zertifikatliste mit Name, Domains, Typ-Badge (Let's Encrypt / Eigenes / Self-Signed), Status-Badge (Aktiv + Resttage, Läuft ab, Abgelaufen, Ausstehend, Fehler), Services, Aktionen
  - Aufklappbare Detailzeile: alle Domains, Ausstell-/Ablaufdatum, Auto-Renew, ACME-E-Mail, Fehlermeldung
  - **Let's Encrypt (ACME HTTP-01)**: Domains, E-Mail, Services-Auswahl, Auto-Renew-Toggle, Staging-Toggle
  - **Eigenes Zertifikat hochladen**: Cert-PEM, Key-PEM, Chain-PEM (optional)
  - **Self-Signed generieren**: Domains, Gültigkeitsdauer in Tagen
  - **Sofort-Erneuerung** (🔄) für Let's Encrypt-Zertifikate
  - **Löschen** mit Bestätigungsdialog
  - Auto-Refresh alle 10 Sekunden (Pending/Renewing-Status sichtbar)
- **Backend `POST /api/v1/admin/certificates/letsencrypt`** — async ACME HTTP-01-Issuance (202-Antwort sofort, Cert wird im Hintergrund ausgestellt)
- **Backend `POST /api/v1/admin/certificates/upload`** — Custom-PEM hochladen, expiresAt wird per `X509Certificate` geparst
- **Backend `POST /api/v1/admin/certificates/self-signed`** — via `node-forge` vollständig generiertes Self-Signed-Zertifikat inkl. SAN
- **Backend `POST /api/v1/admin/certificates/:id/renew`** — ACME-Erneuerung für bestehende Let's Encrypt Certs
- **ACME Challenge-Route** `GET /.well-known/acme-challenge/:token` — Redis-basierter Token-Store (TTL 600s), registriert vor allen Body-Parsern
- **Prisma-Modell `Certificate`** — `id`, `name`, `domains[]`, `services[]`, `type` (LETSENCRYPT/CUSTOM/SELF_SIGNED), `status` (PENDING/ACTIVE/EXPIRING/EXPIRED/ERROR/RENEWING), `certPem`, `keyPem`, `chainPem`, `issuedAt`, `expiresAt`, `autoRenew`, `acmeAccount`, `acmeEmail`, `lastError`
- **Sidebar-Eintrag „Zertifikate"** (`ShieldCheck`-Icon) zwischen Services und Berichte

### Changed

- `node-forge` + `@types/node-forge` zu `@coremail/api-gateway` dependencies hinzugefügt
- `packages/api-gateway/src/server.ts`: `adminCertificatesRouter` registriert, ACME-Challenge-Route vor Proxy-Routen

---

## [1.3.1] — 2026-05-15 — Feature: Manage Domains (komplette Überarbeitung)

### Added

- **ECP „Manage Domains"** (`/ecp/#/domains`) komplett nach Screenshot-Design:
  - Titel-Leiste „Manage Domains"
  - Suchfeld „Search domains" + blauer **+ ADD DOMAIN** Button
  - Tabelle: `#`, `DOMAIN NAME`, **MAKE PRIMARY**-Button / „Primary Domain"-Label, **STATUS-Toggle**, **Bearbeiten**-Stift
  - Pagination: Selektor „50 domains per page" (10/25/50/100), Gesamt-Anzeige, Blättern
- **Primäre Domain** — genau eine Domain kann als primär markiert werden (Radio-Semantik)
  - Bei MAKE PRIMARY: alle anderen Domains werden atomisch als nicht-primär gesetzt (DB-Transaction)
  - Erste angelegte Domain wird automatisch primär
  - Primäre Domain kann nicht gelöscht werden
- **Status-Toggle** — Domain per Toggle aktivieren/deaktivieren (PATCH /toggle)
- **Edit-Modal** — Name, DKIM-Selektor bearbeiten, DKIM-DNS-Eintrag einblenden + kopieren, Löschen (mit Guard)
- **Add-Domain-Modal** — Name + DKIM-Selektor, DKIM-Schlüsselpaar wird automatisch generiert
- **API `PATCH /api/v1/admin/domains/:id/toggle`** — active-Status umschalten
- **API `POST /api/v1/admin/domains/:id/make-primary`** — primäre Domain setzen
- **API `GET /api/v1/admin/domains`** — erweitert um `search`, `page`, `limit` Query-Parameter
- **Prisma `Domain.primary`** — neues Boolean-Feld (@default false)

---

## [1.3.0] — 2026-05-15 — Feature: Services-Verwaltung (Listener-Konfiguration)

### Added

- **Neue ECP-Seite „Services"** (`/ecp/#/services`) mit interner Sub-Navigation (dark sidebar):
  - **Services Management** — Übersichtskarten (SMTP Receiving, SMTP Sending, IMAP, POP3) mit Listener-Counts und Aktivitätsbalken
  - **SMTP Receiving** — Listener-Tabelle für Port 25, 465, 587 (mit SSL-Badge)
  - **SMTP Sending** — Listener-Tabelle für Port 587
  - **IMAP** — Listener-Tabelle für Port 143, 993
  - **POP3** — Listener-Tabelle für Port 110, 995
- **Listeners-Tabelle** exakt nach Vorbild (Screenshot): #, ADDRESS:PORT, SSL-Badge, STATUS-Toggle, Edit/Delete-Buttons
- **ADD LISTENER** Button öffnet Modal mit IP-Adresse, Port, SSL-Toggle, Aktiv-Toggle
- **Default-Seeding**: Beim ersten Abruf werden Standard-Listener automatisch angelegt
- **API `GET /api/v1/admin/services/overview`** — Listener-Counts pro Service
- **API `GET/POST /api/v1/admin/services/listeners/:service`** — Listener auflisten + hinzufügen
- **API `PUT /api/v1/admin/services/listeners/:id`** — Listener bearbeiten
- **API `PATCH /api/v1/admin/services/listeners/:id/toggle`** — aktivieren/deaktivieren
- **API `DELETE /api/v1/admin/services/listeners/:id`** — Listener löschen
- **Prisma-Modell `ServiceListener`** mit Enum `ServiceType` (SMTP_RECEIVE, SMTP_SEND, IMAP, POP3)
- **`api.patch()`** Methode im Admin-Panel API-Client ergänzt
- **Sidebar**: „Server & Health" durch „Services" ersetzt

---

## [1.2.9] — 2026-05-15 — Feature: Globale Server-Einstellungen (ECP)

### Added

- **Neue ECP-Seite „Einstellungen"** (`/ecp/#/settings`) — 4 konfigurierbare Sektionen mit je eigenem Speichern-Button:
  - **Organisation**: Servername (orgName), Beschreibung, Admin-E-Mail, Logo-URL (mit Live-Vorschau), Sprache (de/en), Zeitzone, Willkommensnachricht
  - **Mail-Limits**: Max. Nachrichtengröße (MB), Max. Anhangsgröße (MB), Papierkorb-Aufbewahrung (Tage)
  - **Sicherheitsrichtlinien**: Mindest-Passwortlänge (Schnellauswahl-Buttons), Max. Login-Versuche, Session-Timeout, MFA für Admins erzwingen, Selbstregistrierung erlauben
  - **Wartungsmodus**: An/Aus-Toggle mit Live-Vorschau der Wartungsmeldung, bearbeitbarer Hinweistext
- **Wartungsmodus-Banner** — wenn aktiv, erscheint im ECP ein orangefarbenes Warnier-Banner
- **API `GET /api/v1/admin/settings`** — liest alle Server-Einstellungen (Singleton-Pattern)
- **API `PUT /api/v1/admin/settings/org`** — Organisations-Einstellungen speichern (Zod-validiert)
- **API `PUT /api/v1/admin/settings/mail`** — Mail-Limits speichern
- **API `PUT /api/v1/admin/settings/security`** — Sicherheitsrichtlinien speichern
- **API `PUT /api/v1/admin/settings/maintenance`** — Wartungsmodus aktivieren/deaktivieren
- **Prisma-Schema** `ServerSettings` um 15 neue Felder erweitert (org, mail-limits, security, maintenance)
- **Sidebar-Navigation** Eintrag „Einstellungen" mit Settings2-Icon

---

## [1.2.8] — 2026-05-15 — Feature: Erweitertes Admin-Dashboard

### Added

- **ECP-Dashboard** vollständig überarbeitet — aggregierte Übersichtsseite mit:
  - **4 KPI-Karten** (Benutzer gesamt/aktiv/neu, Domains, E-Mails gesamt/heute, Gesamt-Speicherverbrauch)
  - **SMTP-Queue-Status** (Wartend / Aktiv / Fehlerhaft / Verzögert) mit Ampel-Anzeige
  - **E-Mail-Aktivitäts-Chart** (Area-Chart, letzte 7 Tage, Recharts)
  - **Speicher-Ranking** (Top-10 Nutzer mit Fortschrittsbalken, grün/gelb/rot je Auslastung)
  - **Domain-Übersicht** (Balkendiagramm Benutzerverteilung + Tabelle mit Online-Status)
  - **Letzte Fehler & Warnungen** (System-Logs der letzten 30 Tage, kompakte Liste)
  - **Admin-Aktions-Protokoll** (letzte 8 Audit-Events mit Erfolg-/Fehler-Indikator)
  - **Info-Leiste** (Queue-Gesamteinträge, kumulierte Zustellungen, neue Benutzer, Mails heute)
  - Auto-Refresh alle 30 Sekunden + manueller „Aktualisieren"-Button
- **API `GET /api/v1/admin/dashboard`** — aggregiert alle Metriken in einem einzigen DB-Aufruf:
  - Nutzerstatistiken, Domain-Liste, Nachrichtenanzahl (gesamt/Tag/Woche), Speicher-Ranking
  - BullMQ Job-Counts (waiting/active/failed/delayed/completed)
  - Letzte Fehler-Logs, letzte Audit-Events
  - Mail-pro-Tag-Zeitreihe (PostgreSQL `DATE_TRUNC` Aggregation)

---

## [1.2.7] — 2026-05-15 — Feature: Dateianhänge beim E-Mail-Versand

### Added

- **Anhänge im Compose-Fenster** (OWA): Dateien über „Anhang"-Schaltfläche auswählen (mehrere Dateien gleichzeitig möglich, max. 25 MB pro Datei, max. 20 Dateien)
- **Anhangsliste** über der Aktionsleiste: Dateiname + Größe (KB/MB) + einzeln entfernbar (×-Button)
- **Anhang-Zähler** am „Anhang"-Button (blauer Badge mit Anzahl)
- **Drag & Drop** für mehrere Dateien aus dem Dateiexplorer
- **Backend**: Versand-Endpunkt `POST /api/v1/mail/send` unterstützt jetzt `multipart/form-data` mit `multer` (Speicher im Arbeitsspeicher, danach direkt in MIME-Message eingebettet)
- **MIME-Aufbau**: Nodemailer baut die vollständige RFC 2822-Nachricht mit Anhängen auf (Inline-Kodierung als Base64/quoted-printable je MIME-Typ)
- **BullMQ-Fix**: Mail-Versand aus der OWA legte Nachrichten bislang in eine nie verarbeitete Redis-Liste (`smtp:outbound:api`). Jetzt werden sie korrekt in die BullMQ-Queue `smtp:outbound` eingereiht, die der SMTP-Server verarbeitet.

### Fixed

- E-Mail-Versand aus dem OWA-Compose-Fenster war de facto nicht funktionsfähig (Nachrichten landeten in einer unverarbeiteten Redis-Liste). Jetzt korrekte BullMQ-Integration.

---

## [1.2.6] — 2026-05-15 — Feature: Gmail-artiger Rich-Text-Editor im Compose-Fenster

### Added

- **Vollständige Formatierungsleiste** im E-Mail-Verfassen-Fenster (OWA):
  - **Rückgängig / Wiederholen** (Ctrl+Z / Ctrl+Y)
  - **Block-Typ-Dropdown**: Normal, Überschrift 1/2/3, Codeblock
  - **Zeichenformatierung**: Fett, Kursiv, Unterstrichen, Durchgestrichen
  - **Schriftfarbe** mit 24-Farben-Palette (Popover mit Live-Swatch-Vorschau)
  - **Markierungsfarbe (Highlight)** mit 12-Farben-Palette
  - **Link einfügen / bearbeiten** (Ctrl+K)
  - **Textausrichtung**: Linksbündig, Zentriert, Rechtsbündig, Blocksatz
  - **Aufzählungsliste** und **Nummerierte Liste**
  - **Einzug verringern / erhöhen** für Listen-Elemente
  - **Blockquote** (Zitat), **Inline-Code**, **Horizontale Trennlinie**
  - **Formatierung entfernen** (Radiergummi)
- **BCC-Feld**: neben CC jetzt auch BCC per Klick einblendbar
- **Breites Compose-Fenster**: von 580 px auf 660 px verbreitert für mehr Platz

---

## [1.2.5] — 2026-05-15 — Feature: Echtzeit-Speicherverbrauch pro Postfach im ECP

### Added

- **ECP Postfach-Speicherdetails** — aufklappbare Detailzeile pro Benutzer in der Postfachliste:
  - Quota-Fortschrittsbalken mit exakter GB/MB-Anzeige (belegt / gesamt)
  - Ordner-Tabelle: Anzeigename, Nachrichtenanzahl, Ungelesen-Zähler
  - Benutzer-Metadaten (ID, Erstellt-Datum)
  - „Speicher aktualisieren"-Schaltfläche zur Neu-Berechnung aller Quotas
- **API `POST /api/v1/admin/mailboxes/:id/recalculate-quota`** — Speicherverbrauch für einen einzelnen Benutzer neu berechnen (aggregiert `rawSize` aller nicht-gelöschten Nachrichten)
- **API `POST /api/v1/admin/mailboxes/recalculate-all-quotas`** — Speicherverbrauch für alle Benutzer neu berechnen (Admin-Wartungsfunktion)
- **Live-Berechnung** — `GET /api/v1/admin/mailboxes` berechnet `usedBytes` jetzt on-the-fly aus den tatsächlichen Nachrichtengrößen und synchronisiert den Wert lazy in die DB
- **Ordnerdetails** — `GET /api/v1/admin/mailboxes/:id` gibt jetzt `mailbox.folders` (Name, Anzeigename, Nachrichten- und Ungelesen-Zähler) mit zurück

---

## [1.2.4] — 2026-05-15 — Feature: Vollständige Benutzerverwaltung im ECP

### Added

- **ECP Benutzerverwaltung** — komplett überarbeitete Seite „Empfänger → Postfächer":
  - Benutzeravatar mit Initiale, E-Mail + Anzeigename in einer Zeile
  - Domain-Filter-Dropdown (zeigt Anzahl Benutzer pro Domain)
  - Quota-Fortschrittsbalken (grün/gelb/rot je nach Auslastung)
  - **Bearbeiten-Dialog**: Anzeigename, Rolle, Speicherkontingent ändern
  - **Passwort-Reset-Dialog** (Schlüssel-Symbol) — direkt aus der Liste
  - Aktivieren/Deaktivieren per Klick auf Status-Badge
  - **Neuer Benutzer**-Dialog: Domain zuerst wählen, dann nur Localpart eingeben (E-Mail wird automatisch zusammengesetzt)
  - Deutsche Rollenbezeichnungen (Benutzer, Helpdesk, Administrator etc.)
  - Speicherkontingent-Auswahl: 1 GB / 2 GB / 5 GB / 10 GB / 25 GB / 50 GB / Unbegrenzt

---

## [1.2.3] — 2026-05-15 — Feature: Serverkonfiguration im ECP (Outlook Autodiscover)

### Added

- **ECP → Server → Virtuelle Verzeichnisse** — neue Einstellungsseite im Admin-Panel: öffentlichen Hostnamen, HTTP-Port, HTTPS-Schalter, EWS-URL, OWA-URL, EAS-URL, Autodiscover-Basis, IMAP/POP3/SMTP-Host und -Port konfigurierbar
- **Prisma-Modell `ServerSettings`** — Singleton-Tabelle `server_settings` speichert alle Server-URLs persistent in der Datenbank
- **Admin-API** `GET/PUT /api/v1/admin/servers/settings` — Einstellungen lesen und speichern; `POST /api/v1/admin/servers/settings/derive` — URLs automatisch aus Hostname + Port ableiten
- **Autodiscover liest URLs aus DB** — `packages/autodiscover/src/settings.ts` mit 60-Sekunden-In-Memory-Cache; fällt auf Umgebungsvariablen zurück wenn noch kein DB-Eintrag existiert
- **Outlook 2019/2022/365 Einrichtungsanleitung** direkt im ECP angezeigt

---

## [1.2.2] — 2026-05-15 — Bugfix: BigInt-Serialisierungsfehler crasht api-gateway nach Login

### Fixed

- **api-gateway Crash nach Login** — Nach erfolgreichem Login rief das Frontend `/api/v1/user/profile` ab. Die Felder `quotaBytes` und `usedBytes` (Prisma `BigInt`) konnten von `JSON.stringify` nicht serialisiert werden → Node.js-Fehler + api-gateway-Neustart → Browser sah NetworkError. Globaler `BigInt.prototype.toJSON`-Patch in server.ts konvertiert BigInt → Number für alle Routen

---

## [1.2.1] — 2026-05-15 — Bugfix: "Invalid request" — express.json() vor Auth-Route

### Fixed

- **"Invalid request" beim Login** — `/auth`-Route wurde vor `express.json()` registriert, sodass `req.body` immer `undefined` war und die Zod-Validierung scheiterte. Auth-Route wird jetzt korrekt **nach** dem Body-Parser gemountet (nur echte Proxy-Routen bleiben vor `express.json()`)

---

## [1.2.0] — 2026-05-15 — Fix: Auth direkt im api-gateway (kein Proxy)

### Fixed

- **Login NetworkError** — Auth-Routen (`/auth/login`, `/auth/refresh`, `/auth/logout`) werden jetzt **direkt im api-gateway** verarbeitet statt über einen HTTP-Proxy an den auth-service weitergeleitet. Eliminiert alle Proxy-bedingten Verbindungsfehler (NetworkError, Body-Streaming, Path-Strip-Probleme)

---

## [1.1.9] — 2026-05-15 — Bugfix: Login "Invalid credentials" durch falschen Proxy-Pfad

### Fixed

- **Proxy `proxyReq`-Event** — `req.originalUrl` in `proxyReq.path` schreiben; `http-proxy-middleware` strippt wie Express den Mount-Prefix (`/auth/login` → `/login`), auth-service empfing falschen Pfad → 401 statt Login

---

## [1.1.8] — 2026-05-15 — Bugfix: NetworkError — Proxy vor express.json() registrieren

### Fixed

- **Middleware-Reihenfolge** — Proxy-Routen (`/auth`, `/EWS`, `/dav`, …) werden jetzt **vor** `express.json()` registriert; `express.json()` konsumiert den Body-Stream — danach konnte `http-proxy-middleware` keinen Body mehr weiterleiten → NetworkError im Browser

---

## [1.1.7] — 2026-05-14 — Bugfix: NetworkError beim Login (Proxy ersetzt)

### Fixed

- **Interner Proxy** — Custom Node.js HTTP-Proxy durch `http-proxy-middleware` ersetzt; handhabt Body-Streaming, Hop-by-hop-Header und Content-Length-Neuberechnung korrekt → NetworkError beim Login behoben

---

## [1.1.6] — 2026-05-14 — Bugfix: Login funktioniert nicht (Body leer + falscher Proxy-Pfad)

### Fixed

- **Interner Proxy — Hop-by-Hop-Header** — `connection`, `transfer-encoding` etc. werden jetzt korrekt gefiltert (RFC 2616); verhindert Connection-Konflikte (NetworkError im Browser)
- **Interner Proxy — Body-Streaming** — `express.json()` konsumiert den Request-Body-Stream vor dem Proxy; Auth-Service erhielt leeren Body → Login-Validierung schlug fehl. Fix: `req.body` wird als Buffer re-serialisiert mit exakter `content-length`
- **Interner Proxy — Pfad** — `req.path` → `req.originalUrl`; Express strippt bei `app.use('/auth', proxy)` den Prefix, sodass `POST /auth/login` als `POST /login` beim auth-service ankam → 404. Betrifft alle internen Proxys (auth, EWS, CalDAV, ActiveSync)

---

## [1.1.5] — 2026-05-14 — Bugfix: OWA/ECP Routing funktioniert nicht

### Fixed

- **BrowserRouter basename** — `basename="/owa"` (web-client) und `basename="/ecp"` (admin-panel) gesetzt; React Router hat `/owa/login` nicht als `/login` erkannt → Routing schlug komplett fehl, Login-Button tat nichts

---

## [1.1.4] — 2026-05-14 — Bugfix: OWA Login funktioniert nicht

### Fixed

- **Login-URL** — `fetch('http://localhost:3003/auth/login')` → `fetch('/auth/login')`; Browser hat Login-Request an eigenen PC statt an den Server gesendet

---

## [1.1.3] — 2026-05-14 — Feature: First-Run Setup Wizard

### Added

- **Setup Wizard** (`GET /api/v1/setup/status`, `POST /api/v1/setup/complete`)
  - Beim ersten Aufruf ohne Benutzer wird automatisch auf `/setup` weitergeleitet
  - Formular: Mail-Domain, Administrator-E-Mail + Passwort (min. 8 Zeichen)
  - Erstellt Domain, Admin-User (Rolle `ORGANIZATION_MANAGEMENT`) + Standard-Mailbox-Ordner
  - Endpoint gesperrt sobald erster User existiert (409 Conflict)
- **SetupPage** (`packages/web-client/src/pages/SetupPage.tsx`) — Exchange-Design, Erfolgs-Screen mit Weiterleitung zum Login
- **SetupGuard** in `App.tsx` — prüft Setup-Status bei jedem App-Start, leitet automatisch weiter

---

## [1.0.2] — 2026-05-14 — Bugfix: OWA/ECP leere Seite

### Fixed

- **Vite base path** — `base: '/owa/'` (web-client) und `base: '/ecp/'` (admin-panel) gesetzt; Assets wurden zuvor mit absolutem Pfad `/assets/...` gebaut — Browser konnte sie unter `/owa/assets/...` nicht finden → leere Seite

---

## [1.0.1] — 2026-05-14 — Bugfix: Prisma OpenSSL 3.x Kompatibilität

### Fixed

- **Prisma Engine OpenSSL 3.x** — `binaryTargets = ["native", "linux-musl-openssl-3.0.x"]` in `schema.prisma` hinzugefügt; behebt `libssl.so.1.1: No such file or directory` auf Alpine 3.20 / Node 22
- **Prisma Schema-Deployment** — `prisma db push` statt `prisma migrate deploy` (kein Migrationsverlauf nötig); `prisma` CLI von `devDependencies` in `dependencies` verschoben
- **Redis Synology** — AOF durch RDB-Snapshots ersetzt (`user: "0:0"`); behebt `Permission denied` auf Synology-Volumes
- **Docker Entrypoint** — `entrypoint-app.sh` wartet auf PostgreSQL und führt `prisma db push` vor `supervisord` aus

---

## [0.11.0] — 2026-05-14 — Phase 10: Benutzerverwaltung, Modern Auth, Audit-Log, Push, SMTP-Gateway

### Added

- **Automatische Mailbox-Provisionierung** (`packages/api-gateway/src/lib/provision-mailbox.ts`)
  - `ensureMailboxProvisioned(userId)` — idempotent: legt Mailbox + 8 Standard-Ordner an (INBOX, Drafts, Sent, Trash, Junk, Archive, Notes, Tasks), falls nicht vorhanden
  - Wird beim ersten Login, beim IMAP-Connect und beim Admin-Import aufgerufen
  - `POST /api/v1/admin/mailboxes/:id/provision` — einzelnen User provisionieren
  - `POST /api/v1/admin/mailboxes/bulk-provision` — alle aktiven User ohne Mailbox in einem Durchlauf

- **Audit-Log** (`packages/api-gateway/src/lib/audit.ts`, `src/routes/admin/audit-log.ts`)
  - `audit(entry)` — Fire-and-forget Write in `AuditLog`-Tabelle (blockiert nie)
  - `auditMiddleware` — Express-Middleware, loggt alle mutierenden Admin-Calls (POST/PUT/PATCH/DELETE) automatisch
  - `GET  /api/v1/admin/audit-log` — abfragbar nach actorId, action, targetType, success, from/to, limit/offset
  - `GET  /api/v1/admin/audit-log/export` — CSV-Export mit `Content-Disposition` Header
  - `DELETE /api/v1/admin/audit-log/purge` — alte Einträge löschen (`{ before: ISO-date }`)
  - **Neues Modell** `AuditLog`: actorId, actorEmail, action, targetType, targetId, targetName, ipAddress, userAgent, changes (Json), success, errorMsg

- **OAuth2 / Outlook Modern Auth** (`packages/auth-service/src/oauth2/router.ts`)
  - Authorization Code Flow + PKCE (S256) — vollständig nach RFC 7636
  - `GET  /.well-known/openid-configuration` — OIDC Discovery Document
  - `GET  /oauth2/jwks` — JSON Web Key Set (HS256)
  - `GET  /oauth2/authorize` — startet OAuth2-Flow (redirect zu OWA Login)
  - `POST /oauth2/authorize/complete` — gibt Auth-Code aus (server-seitig vom OWA-Backend aufgerufen)
  - `POST /oauth2/token` — `authorization_code` + `refresh_token` Grants
  - `POST /oauth2/token/revoke` — Token-Revozierung
  - `GET  /oauth2/userinfo` — OIDC UserInfo-Endpoint
  - **Admin API** (`/api/v1/admin/oauth`): Client-Verwaltung (CRUD), Secret-Rotation, Token-Übersicht + Revozierung
  - **Neue Modelle**: `OAuthClient`, `OAuthAuthorizationCode`, `OAuthToken`
  - **EWS Bearer-Token**: `packages/ews-server/src/auth/middleware.ts` prüft OAuth2-Revokation (DB-Lookup)

- **VAPID Web Push** (`packages/api-gateway/src/lib/push.ts`, `src/routes/push.ts`)
  - `sendPushToUser(userId, topic, payload)` — sendet an alle Subscriptions eines Users für ein Topic
  - `broadcastPush(topic, payload)` — systemweiter Broadcast (für Admin-Alerts)
  - Automatische Bereinigung abgelaufener Subscriptions (HTTP 410/404 → DB-Löschen)
  - `GET  /api/v1/push/vapid-public-key` — VAPID Public Key für `PushManager.subscribe()`
  - `POST /api/v1/push/subscribe` — Subscription registrieren (Upsert per Endpoint)
  - `PUT  /api/v1/push/subscribe/:id/topics` — abonnierte Topics aktualisieren
  - `DELETE /api/v1/push/subscribe/:id` — Subscription entfernen
  - `GET  /api/v1/push/subscriptions` — eigene Subscriptions auflisten
  - `POST /api/v1/push/test` — Test-Notification senden
  - **SSE-Integration**: neue Mails lösen automatisch Web Push aus (auch wenn Tab geschlossen)
  - **Neues Modell** `PushSubscription`: userId, endpoint, p256dhKey, authKey, topics, userAgent
  - **Neue Dependency**: `web-push` ^3.6.7 + `@types/web-push` ^3.6.3 in `api-gateway`
  - **ENV**: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`

- **SMTP-Gateway-Modus** (`packages/smtp-server/src/gateway/relay.ts`)
  - `getGatewayConfig()` — DB-first (GatewaySettings Singleton), ENV-Fallback, 60s-Cache
  - `shouldRelayToGateway(recipientEmail)` — prüft ob Gateway aktiv + Domain in relayDomains
  - `relayToUpstream(rawMessage, from, to)` — leitet via nodemailer an Upstream-MTA weiter
  - Eingebunden in `message.ts`: Relay statt lokaler Zustellung wenn Gateway aktiv
  - **Admin API** (`/api/v1/admin/gateway`):
    - `GET  /api/v1/admin/gateway/settings` — aktuelle Konfiguration (Passwort maskiert)
    - `PUT  /api/v1/admin/gateway/settings` — Gateway konfigurieren (upsert, Passwort nur bei expliziter Angabe überschrieben)
    - `POST /api/v1/admin/gateway/test` — Upstream-Verbindung testen (10s Timeout)
  - **Neues Modell** `GatewaySettings`: enabled, upstreamHost, upstreamPort, upstreamTls, upstreamUsername, upstreamPassword, relayDomains[], filterBeforeRelay
  - **ENV**: `GATEWAY_MODE`, `GATEWAY_UPSTREAM_HOST`, `GATEWAY_UPSTREAM_PORT`, `GATEWAY_UPSTREAM_TLS`, `GATEWAY_UPSTREAM_USER`, `GATEWAY_UPSTREAM_PASS`, `GATEWAY_DOMAINS`, `GATEWAY_FILTER`

- **Changelog-API** (`packages/api-gateway/src/server.ts`)
  - `GET /api/v1/changelog` — gibt `CHANGELOG.md` als strukturiertes JSON + Rohtext aus
  - Parst Keep-a-Changelog-Format in Versionen mit Sections (Added/Changed/Fixed …)
  - Pfad konfigurierbar via `CHANGELOG_PATH` ENV

### Changed
- `packages/api-gateway/src/server.ts` — Phase-10-Routen registriert: `/api/v1/push`, `/api/v1/admin/audit-log`, `/api/v1/admin/oauth`, `/api/v1/admin/gateway`; `auditMiddleware` als globale Admin-Middleware; Changelog-API-Endpunkt inline
- `packages/api-gateway/src/sse.ts` — VAPID Push-Notification bei neuer Mail (`CHANNEL_MAIL_NEW`)
- `packages/smtp-server/src/handlers/message.ts` — Gateway-Relay-Prüfung vor lokaler Zustellung

---

## [0.10.0] — 2026-05-14 — Phase 9: S/MIME Inline, Journaling-Regeln, Aufbewahrungsrichtlinien

### Added

- **S/MIME Inline-Signierung & -Verschlüsselung** (`packages/smtp-server/src/smime/`)
  - `sign.ts` — CMS SignedData (RFC 5652): erzeugt `multipart/signed` mit detachierter Signatur
  - `verify.ts` — Verifiziert eingehende S/MIME-Signaturen (`multipart/signed` + opaque signed); Result als JSON in `Message.smimeMeta` gespeichert
  - `encrypt.ts` — CMS EnvelopedData (AES-256-CBC): verschlüsselt ausgehende Nachrichten für den Empfänger wenn dessen Zertifikat in der DB vorhanden ist
  - `decrypt.ts` — Entschlüsselt eingehende verschlüsselte Nachrichten automatisch vor Speicherung
  - `loader.ts` — Lädt PKCS#12-Bundles aus MinIO (private Key + Zertifikatskette via `node-forge`)
  - `index.ts` — Re-Export aller S/MIME-Funktionen
  - **Neue Abhängigkeit**: `node-forge` ^1.3.1 + `@types/node-forge` ^1.3.11 in `smtp-server`

- **SmimeSettings-Modell** (Prisma-Schema, Phase 9)
  - Pro-User-Einstellungen: `autoSign`, `autoEncrypt`, `verifyIncoming`, `decryptIncoming`
  - Relation `User.smimeSettings` (1:1 optional)

- **SMTP Outbound Auto-Sign/-Encrypt** (`packages/smtp-server/src/outbound/queue.ts`)
  - `OutboundJob.senderUserId` — neue Eigenschaft für S/MIME-Lookup
  - Prüft `SmimeSettings.autoSign` → signiert mit Signing-Default-Zertifikat des Absenders
  - Prüft `SmimeSettings.autoEncrypt` (bei Single-Recipient) → verschlüsselt opportunistisch wenn Empfänger-Zertifikat vorhanden

- **SMTP Inbound Verify/Decrypt** (`packages/smtp-server/src/handlers/message.ts`)
  - Entschlüsselt eingehende `application/pkcs7-mime; smime-type=enveloped-data` automatisch
  - Verifiziert eingehende S/MIME-Signaturen; Ergebnis in `Message.smimeMeta` (JSON)
  - Feld `Message.smimeMeta` (String?) im Prisma-Schema hinzugefügt

- **S/MIME Settings API** (`packages/api-gateway/src/routes/smime.ts`)
  - `GET  /api/v1/smime/settings` — User S/MIME-Einstellungen abfragen
  - `PUT  /api/v1/smime/settings` — User S/MIME-Einstellungen setzen (mit Validierung: autoSign erfordert signingDefault-Zertifikat)

- **Journaling-Engine** (`packages/smtp-server/src/journaling/engine.ts`)
  - RFC 3462 Journal Reports: `multipart/report` mit Envelope-Metadaten + Original-Nachricht
  - `JournalingRule`-Matching: Scope (ALL / INBOUND / OUTBOUND / INTERNAL) + RecipientType (ALL_MAILBOXES / SPECIFIC_USERS / DOMAIN)
  - Wird nach jeder Inbound-Delivery und nach jedem Outbound-Relay aufgerufen (nie blockierend)
  - Dispatch via nodemailer (SMTP intern)

- **JournalingRule-Modell** (Prisma-Schema)
  - Felder: `name`, `journalAddress`, `scope` (JournalScope), `recipientType`, `recipientIds[]`, `wrapAsReport`, `enabled`

- **Admin API Journaling** (`packages/api-gateway/src/routes/admin/journaling.ts`)
  - `GET/POST   /api/v1/admin/compliance/journaling`          — Liste + Anlegen
  - `GET/PUT/DELETE /api/v1/admin/compliance/journaling/:id`  — Einzelne Regel
  - `POST       /api/v1/admin/compliance/journaling/:id/toggle` — Aktivieren/Deaktivieren

- **Aufbewahrungsrichtlinien-Worker** (`packages/backup-service/src/retention/worker.ts`)
  - `runRetentionPolicies()` — verarbeitet alle aktivierten Policies
  - Aktionen: `ARCHIVE` (in Archiv-Ordner verschieben), `DELETE` (Hart-Löschen mit Quota-Update), `MOVE_TO_FOLDER` (beliebiger Zielordner, wird angelegt falls nicht vorhanden)
  - Scope: `ALL_ITEMS` / `INBOX` / `SENT_ITEMS` / `DELETED_ITEMS` / `JUNK`
  - Legal Hold: Löschen wird bei aktiven Holds übersprungen (`respectLegalHold`)
  - Dry-Run-Modus via `RETENTION_DRY_RUN=true`
  - Läuft täglich 03:00 UTC via CronJob (`RETENTION_SCHEDULE` konfigurierbar)

- **RetentionPolicy + RetentionPolicyAssignment-Modelle** (Prisma-Schema)
  - `RetentionPolicy`: `retentionDays`, `action` (RetentionAction), `targetFolder`, `scope` (RetentionScope), `respectLegalHold`
  - `RetentionPolicyAssignment`: `target` (GLOBAL / DOMAIN / USER), `targetId`

- **Admin API Retention Policies** (`packages/api-gateway/src/routes/admin/retention.ts`)
  - `GET/POST   /api/v1/admin/compliance/retention`                     — Liste + Anlegen
  - `GET/PUT/DELETE /api/v1/admin/compliance/retention/:id`             — Einzelne Policy
  - `POST       /api/v1/admin/compliance/retention/:id/toggle`          — Aktivieren/Deaktivieren
  - `GET/POST   /api/v1/admin/compliance/retention/:id/assignments`     — Assignments verwalten
  - `DELETE     /api/v1/admin/compliance/retention/:id/assignments/:aid`
  - `POST       /api/v1/admin/compliance/retention/run`                 — Manueller Lauf (via backup-service)

- **Internes Retention-Endpoint** (`packages/backup-service/src/server.ts`)
  - `POST /internal/retention/run` — von api-gateway aufgerufen für manuellen Lauf

### Changed
- `packages/backup-service/src/scheduler/index.ts` — zweiter CronJob für Retention (03:00 UTC, `RETENTION_SCHEDULE` konfigurierbar); `startBackupScheduler()` gibt jetzt `{ backupJob, retentionJob }` zurück
- `packages/api-gateway/src/server.ts` — neue Phase-9-Routen registriert: `/api/v1/admin/compliance/journaling`, `/api/v1/admin/compliance/retention`

---

## [0.9.2] — 2026-05-14 — Kein Proxy: api-gateway übernimmt HTTP-Routing

### Changed
- **`packages/api-gateway/src/server.ts`** — HTTP-Routing ohne externen Proxy:
  - **Statische Dateien**: Express-Static-Middleware für `/owa/` und `/ecp/` (Frontend-Bundles aus `/app/www/`)
  - **Interner Proxy** (Node.js built-in `http.request`, keine neuen Dependencies) für:
    `/auth/` → auth-service (localhost:3003)
    `/EWS/`, `/mapi/`, `/OAB/`, `/Autodiscover/`, `/autodiscover/` → ews-server (localhost:8080)
    `/Microsoft-Server-ActiveSync` → activesync (localhost:3005)
    `/dav/` → caldav-server (localhost:8082)
  - Root `GET /` → Redirect zu `/owa/`
  - Konfigurierbar via `AUTH_SERVICE_URL`, `EWS_SERVICE_URL`, `EAS_SERVICE_URL`, `CALDAV_SERVICE_URL`
- **`infra/docker/Dockerfile.app`** — nginx entfernt, nur noch `supervisor curl tini` als System-Deps; EXPOSE 3000 statt 80/443
- **`infra/docker/supervisord-app.conf`** — nginx-Sektion entfernt
- **`infra/docker/docker-compose.yml`** — Vereinfacht auf 4 Services: `coremail` + `postgres:16-alpine` + `redis:7-alpine` + `minio/minio` (keine Custom-Images für DB); Port 3000 statt 80/443
- **`infra/docker/docker-compose.synology.yml`** — Gleiche Vereinfachung, `8080:3000` für DSM-Kompatibilität, kein TLS-Cert-Handling mehr (DSM Application Portal übernimmt)
- **`scripts/synology-setup.sh`** — TLS-Zertifikat-Schritte entfernt; Anleitung für DSM Reverse Proxy
- **`scripts/docker-push.sh`** — Nur noch 1 Image: `magpeek/coremail-app`

### Removed
- `infra/docker/Dockerfile.db` — nicht mehr nötig (Standard-Images)
- `infra/docker/entrypoint-db.sh` — nicht mehr nötig
- `infra/docker/supervisord-db.conf` — nicht mehr nötig
- `infra/docker/nginx/nginx.app.conf` — nginx vollständig entfernt

---

## [0.9.1] — 2026-05-14 — 2-Container-Architektur & Docker-Deployment-Dokumentation

### Added
- **Monolithischer App-Container** (`magpeek/coremail-app`) — alle 13 Node.js-Services + nginx + OWA/ECP-Frontends in einem einzigen Image, verwaltet von `supervisord`
  - `infra/docker/Dockerfile.app` — Multi-Stage-Build (Node.js Builder + Frontend Builder + Alpine Runner)
  - `infra/docker/supervisord-app.conf` — supervisord-Konfiguration mit Prioritäten (nginx → storage-api → auth → security-filter → Protokoll-Services)
  - `infra/docker/nginx/nginx.app.conf` — nginx-Konfiguration für App-Container (alle Upstream-Adressen auf localhost)
- **Datenbank-Container** (`magpeek/coremail-db`) — PostgreSQL 16 + Redis 7 + MinIO in einem Image
  - `infra/docker/Dockerfile.db` — abgeleitet von `postgres:16-alpine`, ergänzt um Redis (apk) und MinIO (Binary)
  - `infra/docker/supervisord-db.conf` — supervisord für PostgreSQL + Redis + MinIO
  - `infra/docker/entrypoint-db.sh` — Initialisierungs-Entrypoint: PostgreSQL-Init-Skript ausführen, dann supervisord starten
- **Docker-Deployment-Dokumentation** (`docs/deployment-docker.md`) — vollständige Anleitung für Docker-Betrieb: Schnellstart, Konfigurationsreferenz, Synology NAS, Updates, Fehlerbehebung, Produktions-Checkliste

### Changed
- **`infra/docker/docker-compose.yml`** — von 14-Service-Stack auf 2-Container-Stack vereinfacht (`coremail-app` + `coremail-db`)
  - Observability-Stack (Prometheus/Grafana/Loki/Tempo) bleibt als `--profile observability` erhalten
  - Alle internen Service-URLs auf `localhost:PORT` (gleicher App-Container)
- **`infra/docker/docker-compose.synology.yml`** — ebenfalls auf 2-Container vereinfacht (Ports 8080/8443 für DSM-Kompatibilität)
- **`scripts/docker-push.sh`** — baut und pusht nur noch 2 Images (`coremail-app` + `coremail-db`) statt 14 Einzel-Images
- **`README.md`** — Architektur-Diagramm auf 2-Container aktualisiert, Docker Hub Images-Tabelle vereinfacht, Deployment (Docker)-Abschnitt ergänzt

### Removed
- Alle 14 Einzel-Images aus der CI/CD-Pipeline entfernt: `magpeek/coremail-storage-api`, `magpeek/coremail-auth-service`, `magpeek/coremail-security-filter`, `magpeek/coremail-smtp-server`, `magpeek/coremail-imap-server`, `magpeek/coremail-pop3-server`, `magpeek/coremail-ews-server`, `magpeek/coremail-autodiscover`, `magpeek/coremail-caldav-server`, `magpeek/coremail-api-gateway`, `magpeek/coremail-backup-service`, `magpeek/coremail-activesync`, `magpeek/coremail-web-client`, `magpeek/coremail-admin-panel`
- `infra/docker/docker-compose.prod.yml` (separates Prod-Overlay nicht mehr nötig — `docker-compose.yml` verwendet direkt Hub-Images)

---

## [0.9.0] — 2026-05-13 — Phase 8: EMS REST-Bridge, MAPI over HTTP, eDiscovery & Legal Hold

### Added
- **EMS REST-Bridge** (`/api/v1/admin/ems/`)
  - `adminEmsRouter` — vollständige REST-Implementierung aller 20+ Exchange Management Shell Cmdlets
  - **Mailbox-Cmdlets**: `Get-Mailbox`, `New-Mailbox`, `Set-Mailbox`, `Remove-Mailbox`
  - **Gruppen-Cmdlets**: `Get/New/Set/Remove-DistributionGroup`, `Add/Remove/Get-DistributionGroupMember`
  - **Domain-Cmdlets**: `Get/New/Remove-AcceptedDomain`
  - **Transportregel-Cmdlets**: `Get/New/Set/Remove-TransportRule`, `Enable/Disable-TransportRule`
  - **Statistiken**: `Get-MailboxStatistics`
  - **Ressourcen**: `Get-ResourceMailbox`
  - POST `/cmdlet` — universeller Cmdlet-Dispatcher (EMS-kompatibles JSON-Interface)
- **PowerShell-Remoting Phase 8** (`/PowerShell/`)
  - Vollständiges Cmdlet-Routing: erkannte Cmdlets werden direkt an EMS REST-Bridge weitergeleitet
  - SOAP-Antwort: erkannte Cmdlets liefern strukturierten JSON-Output im SOAP-Envelope
  - SOAP-Fault mit vollständiger Cmdlet-Liste für nicht unterstützte Cmdlets
  - Unterstützte Cmdlets als `Set<string>` (SUPPORTED_CMDLETS) — einfach erweiterbar
- **MAPI over HTTP** (`/mapi/` — `packages/ews-server/src/mapi/handler.ts`)
  - `GET /mapi/healthcheck.htm` — Outlook Connectivity-Probe (antwortet "MAPI")
  - `POST /mapi/emsmdb/` — EMSMDB Session-Lifecycle:
    - `Connect` → Session-Cookie + Server-Metadaten (Exchange 2019 Versions-String)
    - `Execute` → ecNotSupported → transparenter EWS-Fallback für Outlook
    - `Disconnect` → Session beenden
    - `NotificationWait` → sofortige Antwort (kein Long-Poll)
  - `POST /mapi/nspi/` — NSPI Adressbuch-Service:
    - `Bind` → NSPI-Session
    - `QueryRows` → GAL-Einträge aus PostgreSQL (max. 500 User)
    - `ResolveNames` → Namensauflösung (Display Name + E-Mail)
    - `Unbind` → Session beenden
  - nginx routing: `/mapi/` → ews-server (bereits konfiguriert)
- **eDiscovery & Legal Hold** (`/api/v1/admin/ediscovery/`)
  - `adminEDiscoveryRouter` — vollständige eDiscovery-Verwaltung
  - **Suchen**: `GET/POST/DELETE /searches`, `GET /searches/:id`
  - **Suchausführung**: `POST /searches/:id/run` — asynchron via Redis Pub/Sub + `runSearch()`
  - **Suchergebnisse**: `GET /searches/:id/results?limit=&offset=` — paginierte Ergebnisliste
  - **Export**: `POST /searches/:id/export` — MBOX-Export-Job (Redis-Queue)
  - **Legal Hold**: `GET/POST /holds`, `GET/DELETE /holds/:id`
  - **Hold-Check**: `GET /holds/check/:userId` — User unter Legal Hold?
  - Suchparameter: `keywords`, `senderAddresses`, `recipientAddresses`, `dateFrom`, `dateTo`, `subjectContains`, `hasAttachment`, `mailboxIds` (leer = alle Postfächer)
- **Prisma-Schema Phase 8**
  - Neues Enum: `EDiscoveryStatus` (DRAFT / RUNNING / COMPLETED / FAILED)
  - Neues Model: `EDiscoverySearch` — Suchparameter als JSON, resultCount, exportPath
  - Neues Model: `LegalHold` — mailboxIds, active, appliedBy, appliedAt, releasedAt
  - Neues Model: `TransportRule` — conditions/actions als JSON, priority, enabled

---

## [0.8.0] — 2026-05-13 — Phase 7: Verteilergruppen, Raumverwaltung, Öffentliche Ordner, PowerShell-Stub

### Added
- **Verteilergruppen (Distribution Groups)**
  - `DistributionGroup`-Model: Statische und dynamische Gruppen (LDAP-Filter)
  - `DistributionGroupMember`-Model: Mitglieder (USER / SHARED_MAILBOX / GROUP / EXTERNAL)
  - SMTP-Expansion: Eingehende E-Mails an Gruppenadresse werden automatisch an alle Mitglieder zugestellt (rekursiv, Loop-Schutz)
  - Admin-REST-API: `GET/POST/PUT/DELETE /api/v1/admin/groups`
  - Mitglieder-API: `GET/POST/DELETE /api/v1/admin/groups/:id/members`
  - GAL-Endpunkt: `GET /api/v1/admin/groups/gal/list` — für Adress-Autovervollständigung
  - Konfigurierbar: Moderierung, externe Absender, verborgen aus GAL
- **Raum- und Ressourcenpostfächer (Resource Mailboxes)**
  - `ResourceMailbox`-Model: Typ ROOM / EQUIPMENT, Kapazität, Standort, Buchungsregeln
  - `ResourceCalendar`-Model + `ResourceBooking`-Model: Buchungsverwaltung
  - **Auto-Accept-Logik**: iCal-VEVENT aus eingehender E-Mail wird automatisch geparst und Buchung als ACCEPTED / DECLINED / PENDING gespeichert
  - Konflikterkennung: Überschneidende Buchungen werden automatisch abgelehnt (konfigurierbar)
  - Admin-REST-API: `GET/POST/PUT/DELETE /api/v1/admin/resources`
  - Buchungs-API: `GET /api/v1/admin/resources/:id/bookings`, `DELETE /api/v1/admin/resources/:id/bookings/:bookingId`
  - Free/Busy-Abfrage: `GET /api/v1/admin/resources/freebusy/query?email=&from=&to=`
- **Öffentliche Ordner (Public Folders)**
  - `PublicFolder`-Model: Hierarchischer Baum mit ACL-System (READ / POST / OWNER)
  - `PublicFolderMessage`-Model: Beiträge in öffentlichen Ordnern
  - Admin-API: `GET/POST/PUT/DELETE /api/v1/admin/public-folders` inkl. ACL-Verwaltung
  - User-API: `GET /api/v1/public-folders` (nur zugängliche Ordner), `GET/POST /api/v1/public-folders/:id/messages`
- **PowerShell-Remoting-Stub** (`/PowerShell/`)
  - WSMan-Identifizierung: `POST /PowerShell/` mit SOAP-Envelope
  - WSDL-Endpunkt: `GET /PowerShell/`
  - Stub-Antwort für alle Cmdlets mit klarer Fehlermeldung (Phase 8 geplant)
  - nginx-Routing: `/PowerShell/` → api-gateway mit Auth-Header-Weiterleitung
- **SMTP-Server-Erweiterungen**
  - `verifyRecipient()`: Akzeptiert nun auch Verteilergruppen- und Ressourcenpostfach-Adressen
  - `expandRecipients()`: Rekursive Gruppenexpansion mit Duplikateleminierung
  - `processResourceMailboxes()`: Auto-Accept-Verarbeitung für Raumkalender
- **Prisma-Schema**
  - Neue Enums: `GroupType` (STATIC / DYNAMIC), `ResourceType` (ROOM / EQUIPMENT)
  - Neue Modelle: `DistributionGroup`, `DistributionGroupMember`, `ResourceMailbox`, `ResourceCalendar`, `ResourceBooking`, `PublicFolder`, `PublicFolderMessage`
  - `Domain`-Relation: `distributionGroups`, `resourceMailboxes`
  - `Mailbox`-Relation: `resourceMailbox`

---

## [0.7.0] — 2026-05-13 — Phase 6: ActiveSync (EAS) + S/MIME

### Added
- **`packages/activesync`** — Microsoft Exchange ActiveSync (EAS 14.1) Server
  - WBXML binary codec mit vollständigem EAS-Codepage-Support (AirSync, Email, FolderHierarchy, Provision, Ping, ComposeMail)
  - **Provision-Befehl**: Geräte-Registrierung, Policy-Aushandlung (permissive Policy out-of-the-box)
  - **FolderSync-Befehl**: Initiale + inkrementelle Ordnerhierarchie-Synchronisation
  - **Sync-Befehl**: Bidirektionale E-Mail-Synchronisation mit Delta-Tracking, Read-Flag, Delete
  - **SendMail-Befehl**: Ausgehende E-Mails via Redis-Queue, optionales Speichern im Gesendeten-Ordner
  - **SmartReply / SmartForward**: Antworten/Weiterleiten mit MIME-Payload
  - **Ping-Befehl**: Long-Poll Push-Benachrichtigung (Heartbeat bis 59 Minuten)
  - **GetAttachment**: Anhang-Abruf per AttachmentName
  - Basic Auth + App-Passwort-Unterstützung
  - Express-Server auf Port 3005 mit `/health`-Endpoint
  - Eigenes Dockerfile
- **S/MIME API** (`packages/api-gateway/src/routes/smime.ts`)
  - `GET/POST/PUT/DELETE /api/v1/smime/certificates` — PKCS#12-Zertifikat-Verwaltung
  - `GET /api/v1/smime/public-key/:email` — Public Key für Verschlüsselung ausgehender Mails
  - `GET/DELETE /api/v1/smime/devices` — ActiveSync-Geräteverwaltung
- **Prisma-Schema-Erweiterungen**
  - `ActiveSyncDevice`-Model: Geräte-ID, Type, Policy-Key, Status, SyncKey-Map
  - `UserCertificate`-Model: Fingerprint, Subject/Issuer, Gültigkeit, Signing/Encrypt-Default
- **Autodiscover v1**: ActiveSync-Protokollblock (`<Type>ActiveSync</Type>`) hinzugefügt
- **nginx**: Proxy-Route für `/Microsoft-Server-ActiveSync` mit Long-Poll-Timeout (600s)
- **docker-compose.yml**: `activesync`-Service auf Port 3005

### Changed
- `packages/autodiscover/src/v1.ts`: `EAS_URL`-Umgebungsvariable + ActiveSync-Block im XML

---

## [0.6.1] — 2026-05-09 — Docker Hub Publishing & CI/CD

### Added
- **GitHub Actions Workflow** (`.github/workflows/docker-publish.yml`)
  - Baut und pusht alle 13 Service-Images bei jedem Push auf `main` und bei Git-Tags (`v*.*.*`)
  - Multi-Arch-Build: `linux/amd64` + `linux/arm64` via Docker Buildx / QEMU
  - Layer-Caching via GitHub Actions Cache (scope pro Service)
  - Semantisches Tagging: `1.2.3`, `1.2`, `1`, `latest`, `edge` (main-Branch), `sha-<hash>`
  - OCI-Labels: `image.title`, `image.version`, `image.revision`, `image.source`
  - Login-Schritt nur bei echten Pushes (nicht bei Pull Requests)
  - Matrix-Strategy: alle 13 Services parallel, `fail-fast: false`
- **`scripts/docker-push.sh`** — lokales Build-und-Push-Skript
  - Version automatisch aus CHANGELOG extrahiert oder explizit angegeben
  - `--no-push`-Flag zum reinen lokalen Bauen
  - Multi-Arch via `docker buildx`, OCI-Labels mit Git-SHA und Timestamp
  - Farbige Zusammenfassung mit allen gepushten Image-Namen
- **`infra/docker/docker-compose.prod.yml`** — Production-Override
  - Ersetzt `build:`-Direktiven durch fertige Docker-Hub-Images
  - Image-Tag über `COREMAIL_VERSION`-Env-Variable steuerbar
  - Verwendung: `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`

### Docker Hub Images

Alle Images unter: **https://hub.docker.com/u/magpeek**

| Image | Beschreibung |
|-------|-------------|
| `magpeek/coremail-storage-api` | Interner Storage-API-Service |
| `magpeek/coremail-auth-service` | Authentifizierung (Local/LDAP/OIDC/MFA) |
| `magpeek/coremail-security-filter` | SPF/DKIM/DMARC/DNSBL/ClamAV/rspamd |
| `magpeek/coremail-smtp-server` | SMTP Inbound + Outbound (25/465/587) |
| `magpeek/coremail-imap-server` | IMAP4rev1 + IDLE + CONDSTORE (143/993) |
| `magpeek/coremail-pop3-server` | POP3 (110/995) |
| `magpeek/coremail-ews-server` | Exchange Web Services SOAP/XML (Outlook) |
| `magpeek/coremail-autodiscover` | Autodiscover v1 + v2 |
| `magpeek/coremail-caldav-server` | CalDAV + CardDAV (iOS/Android/Thunderbird) |
| `magpeek/coremail-api-gateway` | REST API + SSE Live-Events |
| `magpeek/coremail-backup-service` | Backup/Restore (MBOX/EML/S3) |
| `magpeek/coremail-web-client` | Webmail (OWA React UI) |
| `magpeek/coremail-admin-panel` | Admin-Panel (ECP React UI) |

---

## [0.6.0] — 2026-05-09 — Phase 5: Backup + Observability + Kubernetes

### Added
- **packages/backup-service** — Self-service and admin backup/restore on port 3004
  - MBOX export (RFC 4155) with page-based streaming and backpressure handling
  - EML-ZIP export — individual `.eml` files + `.vcf` contacts + `.ics` calendar events
  - S3-compatible upload via `@aws-sdk/lib-storage` (MinIO multipart, 10 MB parts)
  - Presigned download URLs (1 h TTL) via `@aws-sdk/s3-request-presigner`
  - Scheduled full-server backup (daily 02:00 UTC via `cron` CronJob)
  - Retention policy (configurable, default 30 days) applied after each scheduled run
  - Soft-delete restore: users can recover messages deleted within the last 30 days
  - MBOX import via streaming `readline` interface (no full-file buffering)
  - Admin endpoints: trigger immediate backup, list jobs, download signed URLs
  - User self-service endpoints: request backup, track status, download, list restorables
- **packages/core — OpenTelemetry instrumentation**
  - `initMetrics()` — PrometheusExporter on port 9464, MeterProvider with service labels
  - `createMailMetrics()` — counters/histograms for messages, auth, HTTP, queue depth, storage
  - `metricsMiddleware()` — Express middleware recording method/path/status/duration
  - `initTracing()` — NodeSDK + OTLPTraceExporter → otel-collector, SIGTERM shutdown hook
  - `withSpan()` — typed helper wrapping async functions with active spans and error recording
- **infra/observability** — Full observability stack (docker-compose `observability` profile)
  - **Prometheus** — scrapes all 9 CoreMail services + postgres-exporter + redis-exporter + node-exporter
  - **Alertmanager** — 8 alert rules (dead-letter queue, high spam rate, virus found, brute-force, quota exceeded, service down, HTTP errors, slow responses), email routing
  - **OTEL Collector** — OTLP gRPC+HTTP receivers, fan-out to Tempo + Prometheus remote write + Loki
  - **Grafana** — pre-provisioned Prometheus, Tempo, Loki datasources; `coremail-overview` dashboard (8 panels)
  - **Tempo** — distributed tracing backend, OTLP receiver, 7-day retention, local storage
  - **Loki** — log aggregation, filesystem storage, v13 schema, 7-day retention
  - **postgres-exporter**, **redis-exporter**, **node-exporter** — infrastructure metrics
- **infra/k8s** — Kubernetes Helm chart (`helm install coremail ./infra/k8s`)
  - `Chart.yaml` — chart metadata, Bitnami Redis subchart dependency
  - `values.yaml` — fully documented defaults for all services, HPA, resources, CNPG, MinIO, Ingress
  - `templates/_helpers.tpl` — shared helpers (image ref, secret name, env helpers)
  - `templates/secret.yaml` — chart-managed Secret (skipped if `existingSecret` set)
  - `templates/configmap.yaml` — shared env ConfigMap for all pods
  - `templates/cnpg-cluster.yaml` — CloudNativePG `Cluster` resource (3 instances, 2 read replicas, optional WAL backup)
  - `templates/minio.yaml` — MinIO distributed StatefulSet (4 nodes, erasure coding)
  - `templates/deployments.yaml` — Deployment + Service + HPA + PodDisruptionBudget for all 12 services
  - `templates/ingress.yaml` — nginx Ingress with cert-manager TLS, Exchange-compatible paths
  - `templates/NOTES.txt` — post-install instructions

### Changed
- `infra/docker/docker-compose.yml` — backup-service promoted to always-on; 9 observability services added under `observability` profile; new volumes for all observability data

---

## [0.5.0] — 2026-05-09 — Phase 4: CalDAV + API-Gateway + Frontend

### Added
- **packages/caldav-server** — CalDAV (RFC 4791) + CardDAV (RFC 6352) server on port 8082
  - PROPFIND, GET, PUT, DELETE for `.ics` (calendar events) and `.vcf` (contacts)
  - MKCALENDAR, REPORT (sync), OPTIONS with correct DAV headers
  - Well-known redirects (`/.well-known/caldav`, `/.well-known/carddav`)
  - Basic Auth + Bearer JWT via auth-service
- **packages/api-gateway** — REST API on port 3000
  - `GET/POST/PATCH/DELETE /api/v1/mail/folders`, `/messages`, `/search`, `/send`
  - `GET/POST/PUT/DELETE /api/v1/calendar`, `/calendar/events`
  - `GET/POST/PUT/DELETE /api/v1/contacts`, `/contacts/gal`
  - `GET/POST/PUT/DELETE /api/v1/tasks`, `/api/v1/notes`
  - `GET/PUT /api/v1/user/profile`, `/signature`, `/oof`, `/rules`, `/shared-mailboxes`
  - `GET/POST/PUT/DELETE /api/v1/admin/mailboxes` (incl. shared mailboxes + permissions)
  - `GET/POST/PUT/DELETE /api/v1/admin/domains` (incl. DKIM DNS record export)
  - `GET/POST/DELETE /api/v1/admin/queues` (SMTP queue monitoring)
  - `GET/PUT/DELETE /api/v1/admin/logs` (system log viewer + log-level control)
  - `GET /api/v1/events` — SSE live-events stream (Redis Pub/Sub → browser)
- **packages/web-client** — React 19 OWA-style webmail UI (Vite + TailwindCSS)
  - Mail: three-column layout (folder tree / message list / reader), compose window
  - Calendar: FullCalendar week/month/day view with create/delete
  - Contacts: search, detail view, create/edit/delete
  - Tasks: list with priority, due date, toggle complete
  - Settings: profile, rich-text signature (Tiptap), OOF, security (App Passwords / 2FA)
  - Real-time updates via SSE (`useMailEvents` hook)
  - Auth: login page, JWT in Zustand + localStorage, auto-redirect on 401
- **packages/admin-panel** — React 19 ECP-style admin UI (Vite + TailwindCSS)
  - Dashboard: queue stats, service health overview
  - Mailboxes: create/toggle/delete, quota display, role assignment
  - Domains: add domain, auto-generate DKIM key pair, export DNS TXT record
  - Queues: live queue counters, flush dead-letter queue
  - Logs: filterable log viewer (level / service / search)
  - Protection: security feature status matrix
  - Servers: service health grid (all 10 services)
  - Reports: mail flow bar chart (recharts), daily stats
- **infra/docker/nginx/owa.conf** + **ecp.conf** — nginx SPA configs for web + admin containers

### Changed
- `infra/docker/docker-compose.yml` — `caldav-server`, `api-gateway`, `web-client`, `admin-panel` services already wired; no further changes needed

---

## [0.4.0] — 2026-04-xx — Phase 3: EWS + Autodiscover + Auth

### Added
- **packages/ews-server** — Exchange Web Services (SOAP/XML) on port 8080
  - 13 EWS operations: FindItem, GetItem, CreateItem, UpdateItem, DeleteItem,
    SyncFolderHierarchy, SyncFolderItems, MoveItem, CopyItem,
    ResolveNames, GetUserAvailability, Subscribe, GetStreamingEvents
  - CalendarItem, Contact support
  - Bearer + Basic Auth (delegated to auth-service)
  - Shared Mailbox access via `X-AnchorMailbox` header
- **packages/autodiscover** — Autodiscover v1 (XML) + v2 (JSON) on port 8081
  - Exchange-compatible response with EXCH/IMAP/SMTP protocol blocks
  - Supports Outlook 2010–365
- **packages/auth-service** — Authentication & MFA on port 3003
  - Local (bcrypt + pepper), LDAP fallback, OIDC SSO
  - TOTP (otpauth), WebAuthn/FIDO2 (@simplewebauthn/server), Backup Codes
  - App Passwords for IMAP/POP3/SMTP clients
  - Session management
- **packages/auth-ldap** — LDAP/Active Directory connector (ldapts)
- **packages/auth-sso** — OIDC SSO connector (openid-client)

---

## [0.3.0] — 2026-03-xx — Phase 2: SMTP + IMAP + POP3 + Security

### Added
- **packages/smtp-server** — Inbound + Outbound SMTP (ports 25/465/587)
  - SPF/DKIM/DMARC validation (mailauth), DKIM signing on outbound
  - Redis outbound queue, retry with exponential backoff
- **packages/imap-server** — IMAP4rev1 + IDLE + CONDSTORE (ports 143/993)
- **packages/pop3-server** — POP3 (ports 110/995)
- **packages/security-filter** — Mail security pipeline
  - Greylisting, DNSBL (Spamhaus ZEN + SpamCop), reverse-DNS, SPF/DKIM/DMARC
  - ClamAV antivirus, rspamd anti-spam, attachment filter

---

## [0.2.0] — 2026-02-xx — Phase 1: Foundation

### Added
- **packages/core** — JWT auth, Redis client, logger (pino), shared types
- **packages/storage** — Prisma ORM (22 models), MinIO integration, MIME parser
- Docker Compose base stack: PostgreSQL 16, Redis 7, MinIO, rspamd, nginx
- pnpm monorepo, TypeScript 5.5, ESLint, Prettier
