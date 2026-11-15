# CoreMail

> 🇬🇧 [English version](README.md) · 🇩🇪 Deutsche Fassung

> **Coremail — der OpenSource Mailserver für kleine und mittlere Umgebungen.**  
> Aufgebaut auf React + Node.js/TypeScript, container-first, vollständig selbst gehostet.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22+-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue.svg)](https://www.typescriptlang.org)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED.svg)](https://www.docker.com)
[![Version](https://img.shields.io/badge/Version-9.0.0-brightgreen.svg)](https://github.com/MAGPEEK/CoreMail/releases)
[![IMAP4rev2](https://img.shields.io/badge/IMAP4-rev2-blue.svg)](https://datatracker.ietf.org/doc/html/rfc9051)
[![CalDAV](https://img.shields.io/badge/CalDAV%2FCardDAV-supported-blue.svg)](https://datatracker.ietf.org/doc/html/rfc4791)

📄 **[docker-compose.yml](infra/docker/docker-compose.yml)** — sofort einsatzbereit: `.env` erzeugen, `up -d`, fertig  
⌨️ **[docs/cli.md](docs/cli.md)** — Admin-CLI `coremail`: Benutzer, Postfächer, Konnektoren, SMTP-Banner, Zertifikate  
📋 **[COMMANDS.md](COMMANDS.md)** — Befehlsreferenz: Dienste prüfen, Benutzer anlegen, Queues, Logs, Backup  
📝 **[CHANGELOG.md](CHANGELOG.md)** — Vollständiger Versionsverlauf

**CoreMail** ist ein vollständiger, selbst gehosteter Mailserver für Klein- und Mittelunternehmen mit **10–500 Benutzern** — ohne Lizenzkosten, ohne Vendor Lock-in, mit voller Datensouveränität.

**🎯 Standard-Mail-Protokolle.** CoreMail spricht **IMAP4rev2** (RFC 9051) + **JMAP** (RFC 8620/8621, seit v5.7.1) + **SMTP-Submission** + **POP3** + **CalDAV/CardDAV** + **ActiveSync** — Standard-Clients (Apple Mail, Thunderbird, Outlook, K-9 Mail, eM Client, iOS Mail) verbinden sich über IMAP/SMTP. **App-Passwörter** für MFA-kompatible Anmeldung. Kein VPN, kein Connector, keine Drittanbieter-Software.

> **Aktuelle Version: v9.0.0** — Sicherheitshärtung nach OWASP (gemeinsame Login-Sperre, HttpOnly-Refresh-Cookies, DMARC-Durchsetzung, ReDoS-/DoS-Grenzen, verschlüsselte Backups, Schema-Sync ohne stillen Datenverlust); Mail-Logik auf Exchange-Niveau (DSN, CHUNKING, SMTPUTF8, QRESYNC, SORT/THREAD, Quota-Stufen, gelöschte Elemente wiederherstellen, Server-Entwürfe mit Rückgängig-Senden); automatische Einrichtung für Thunderbird/Apple; Docker-Compose-Varianten minimal/standard/full; Helm-Chart 2.0.0; Ende-zu-Ende in beiden Speichermodi getestet ([docs/e2e.md](docs/e2e.md)). **Breaking — vor dem Upgrade die [Upgrade-Hinweise](docs/releases/v9.0.0.md) lesen** · Admin-CLI `coremail` ([Doku](docs/cli.md)) · JMAP-Server ([Doku](docs/jmap.md)) · IMAP4rev2 · [Changelog](CHANGELOG.md) · [Releases](https://github.com/MAGPEEK/CoreMail/releases) · [Docker Hub](https://hub.docker.com/r/magpeek/coremail-app)
>
> **Hinweis zu Outlook**: CoreMail lässt sich nicht als Exchange-Konto einrichten. Outlook wird über **„Andere E-Mail-Konten" → IMAP** eingerichtet (bei aktivem MFA mit App-Passwort), Kalender + Kontakte via CalDAV/CardDAV (Outlook-CalDav-Synchronizer-Plugin; oder Apple Kalender, Thunderbird Lightning).
>
> **Hinweis (seit v5.6.0)**: Der OAuth2-Authorization-Server unter `/oauth2/*` wurde komplett entfernt — XOAUTH2 hat in der Praxis keine Mainstream-Client-UI-Unterstützung für non-Microsoft-Server. JWT läuft jetzt wieder mit HS256 (`JWT_SECRET`). REST-API + MWA/BCP nutzen Session-JWTs über `/auth/login`, Mail-Clients App-Passwörter.
>
> **Hinweis (seit v5.6.1)**: Verteilergruppen wurden entfernt — moderne Teams nutzen Shared Mailboxes (mit Aliasen) für Team-Postfächer oder externe Listserv-Tools (Mailman, listmonk) für reine Outbound-Verteiler.

---

## Inhalt

1. [Features](#features)
2. [Clients verbinden](#clients-verbinden)
3. [Schnellstart](#schnellstart)
4. [Docker Compose](#docker-compose)
   - [Admin-CLI `coremail`](#admin-cli-coremail-seit-v580)
5. [Zugriff](#zugriff)
6. [Konfiguration](#konfiguration)
7. [DNS-Einrichtung](#dns-einrichtung)
8. [TLS-Zertifikate](#tls-zertifikate)
9. [Befehlsreferenz](#befehlsreferenz)
10. [Docker Hub](#docker-hub)
11. [Versionsverlauf](#versionsverlauf)
12. [Lizenz](#lizenz)

---

## Features

✅ funktioniert · ⚠️ teilweise · ❌ nicht verfügbar · ⚙️ optional

### E-Mail-Protokolle

| Feature | Status | RFC |
|---------|--------|-----|
| **SMTP** Inbound (Port 25) + Submission (465 implicit-TLS, 587 STARTTLS) | ✅ | 5321 + 6409 |
| ESMTP-Erweiterungen: STARTTLS, AUTH PLAIN/LOGIN, PIPELINING, SIZE, 8BITMIME, ENHANCEDSTATUSCODES, DSN (Zustell-/Verzögerungs-/Fehlerberichte), CHUNKING + BINARYMIME (BDAT), SMTPUTF8 — DSN/CHUNKING/SMTPUTF8 standardmäßig an, abschaltbar über `SMTP_EXT_*` | ✅ | 3207, 4954, 2920, 1870, 6152, 2034, 3461, 3030, 6531 |
| SMTP Outbound mit MX-Lookup & DKIM-Signierung | ✅ | 6376 |
| **IMAP4rev2** (Port 993 implicit-TLS, Port 143 STARTTLS — Login erst nach TLS, davor `LOGINDISABLED`) — Originalnachrichten byte-genau inkl. Anhängen | ✅ | **9051** |
| IMAP-Capabilities: AUTHENTICATE PLAIN/LOGIN, IDLE, CONDSTORE, QRESYNC, ESEARCH, SEARCHRES, SORT, THREAD=ORDEREDSUBJECT, THREAD=REFERENCES, ACL (RIGHTS=texk), COMPRESS=DEFLATE, BINARY, LIST-EXTENDED, LIST-STATUS, QUOTA (nur lesend), SPECIAL-USE, NAMESPACE, MOVE, UNSELECT, UIDPLUS, ID, ENABLE, LITERAL+, STATUS=SIZE, vollständiges SEARCH; Sequenznummern pro Sitzung mit EXISTS/EXPUNGE/FLAGS-Updates | ✅ | 2087, 2971, 3502, 3516, 3691, 4314, 4731, 4978, 5161, 5182, 5256, 5258, 5819, 6154, 6851, 7162, 7888, 8438, 9208 |
| **POP3** (Port 995 implicit-TLS, Port 110 STLS — USER/PASS erst nach TLS) + App-Password-Support | ⚠️ kein SASL (`AUTH`); nur USER/PASS | 1939, 2595 |
| **JMAP** (Core + Mail + WebSocket/Blob/Quota/Sharing/VAPID) | ✅ | 8620, 8621, 8887, 9404, 9425, 9670, 9749 |
| Admin-CLI `coremail` im Container (Benutzer, Postfächer, Konnektoren, Banner, Zertifikate) | ✅ | — |
| Autodiscover v1 (XML) + v2 (JSON) — IMAP/SMTP/ActiveSync | ✅ | MS-OXDISCO |
| ActiveSync EAS 14.1 — iOS Mail, Android, Outlook Mobile (Provision, FolderSync, Sync mit AirSyncBase-Bodies, Ping, SendMail, SmartReply/Forward, GetAttachment, ItemOperations, GetItemEstimate, Settings, Search, MoveItems, MeetingResponse, ResolveRecipients) | ⚠️ nicht mit echten Geräten getestet; Ordner anlegen/umbenennen/löschen vom Gerät aus wird nicht unterstützt |
| MWA — Mail Web Access (React, Exchange-ähnliches Layout; Endlos-Scrollen, Anhang-Download, Inline-Bilder) | ✅ |
| RFC 822 Quelltext-Ansicht (Modal im MWA) | ✅ |
| Empfänger-Autocomplete im Compose (An/CC/BCC, Keyboard-Nav) | ✅ |
| Resizable Panels im MWA (Ordnerstruktur / Liste / Lesebereich) | ✅ |
| Freigegebene Postfächer mit voller Ordner-Struktur (Inbox, Sent, Trash, …) | ✅ |
| Shared Mailbox-Reader im MWA — „Weiteres Postfach öffnen" über Konto-Dropdown | ✅ |
| Folder-CRUD in Shared Mailboxes (Neuer Ordner, Umbenennen, Löschen, Standard-Folder geschützt) | ✅ |
| E-Mail-Aliase pro User-Postfach und Shared-Mailbox | ✅ |
| Raum- und Gerätepostfächer mit Auto-Accept | ⚠️ nur über die REST-/EMS-API verwaltbar (keine BCP-Seite); siehe Raumbuchung unten |
| Abwesenheitsassistent (automatische Antworten nach RFC 3834) | ✅ |
| Posteingangsregeln & Transportregeln + 9 Exchange-Vorlagen (Disclaimer, CEO-Phishing, PCI-DSS, …) | ⚠️ Transportregeln greifen nur bei lokaler Zustellung (nicht bei Mails an externe Empfänger); Ablehnen sendet nur an lokale Absender einen DSN |
| Postfachsuche im MWA (Betreff, Absender, Text; Ordner oder ganzes Postfach, seitenweise) | ⚠️ Teilstring-Suche ohne Volltextindex |
| S/MIME — Signierung, Verschlüsselung, Verifikation | ✅ |
| SMTP-Gateway-Modus (Relay zu Upstream-MTA) | ✅ |
| Aufbewahrungsrichtlinien Exchange-2019-konform (DPT/RPT/Personal Tags · 8 Vorlagen · Recoverable Items) | ✅ |
| Managed Folder Assistant (Tag-Hierarchie, Soft/Hard Delete) | ✅ |
| EMS-artige REST-Admin-Bridge (`/api/v1/admin/ems/` — Mailbox/Domain/TransportRule/ResourceMailbox) | ✅ |

### Kalender & Zusammenarbeit

| Feature | Status |
|---------|--------|
| Persönlicher Kalender (Ganztagstermine, Wiederholungsregeln, serverseitige Serienauflösung) | ✅ |
| Geteilte Teamkalender | ✅ |
| Besprechungsanfragen (iCal-Standard) | ✅ |
| Frei/Gebucht-Abfrage (inkl. Serienterminen) | ⚠️ nur eigene und mit dir geteilte Kalender |
| Raum- und Ressourcenbuchung mit Auto-Accept | ⚠️ nur für Einladungen, die per eingehendem SMTP ankommen; der Organisator erhält keine Antwort; ausstehende Buchungen können nicht genehmigt werden; Zeitzonen werden nicht zuverlässig behandelt |
| CalDAV (iOS, Android, Thunderbird — REPORT, MKCALENDAR, ETag/If-Match, TZID/RRULE) | ✅ |
| Kontakte & CardDAV (inkl. REPORT) | ✅ |
| Aufgaben & Notizen | ✅ |
| Globale Adressliste (GAL) | ✅ |

### Sicherheit

| Feature | Status |
|---------|--------|
| SPF / DKIM / DMARC / ARC-Validierung | ✅ |
| DKIM-Signierung ausgehender E-Mails | ✅ |
| DNSBL (Spamhaus ZEN, SpamCop, konfigurierbar) | ✅ |
| Greylisting mit automatischer Whitelist | ✅ |
| Country-Filtering (MaxMind GeoIP, BCP-Einstellungen) | ⚠️ benötigt eine im Container eingebundene MaxMind-GeoLite2-Datenbank (`GEOIP_DB_PATH`); nicht im Image enthalten |
| ClamAV Antivirus (separater Container) | ✅ |
| Rspamd 4.0 Anti-Spam (Bayes, selbstlernend, separater Container) | ✅ |
| Adress-Blacklist (Global / Domain / Benutzer) | ✅ |
| Attachment-Filter (MIME-Typen, Doppel-Extensions, Endungs- und Größen-Einstellungen aus dem BCP) | ✅ |
| Quarantäne-Management mit Detail-Ansicht, MIME-Vorschau und Freigabe (Zustellung) | ✅ |
| TLS (STARTTLS + Implicit TLS) — Zugangsdaten erst nach TLS (IMAP 143 STARTTLS, POP3 110 STLS, SMTP 587 AUTH nach STARTTLS) | ✅ |
| Integrierter HTTPS-Proxy (Port 443, Hot-Reload, BCP-Verwaltung) | ✅ |
| DNS-Hardening (trusted Resolver, Cross-Validation, Integrity-Check) | ✅ |
| Nachrichtenablaufverfolgung (Message Trace) mit CSV-Export | ✅ |
| Brute-Force-Sperre pro IP und Konto für SMTP/IMAP/POP3/ActiveSync/Autodiscover/JMAP/CalDAV (`MAIL_AUTH_*`) & SMTP-Rate-Limiting | ✅ |

### Authentifizierung

| Feature | Status |
|---------|--------|
| Lokale Anmeldung (bcrypt + pepper) | ✅ |
| LDAP / Active Directory (BCP-Verwaltung, TLS, Attributzuordnung, manueller + geplanter Sync, Provisionierung beim ersten Login; Web-Login und Mail-Protokolle) | ✅ |
| SSO via OIDC / OAuth2 für MWA/BCP (Azure AD, Keycloak, Google, Authentik, Okta — PKCE, state/nonce, `email_verified`, erlaubte Domains) | ✅ |
| MFA: TOTP (Authenticator-App) | ✅ |
| MFA: WebAuthn / FIDO2 (YubiKey, Touch ID) — Registrierung und Anmeldung in MWA/BCP | ✅ |
| MFA: Backup-Codes (beim Login akzeptiert) | ✅ |
| App-Passwörter für Mail-Clients (SMTP/IMAP/POP3/ActiveSync/Autodiscover/JMAP/CalDAV — Pflicht bei aktivem MFA) | ✅ |
| Passwort-Änderung im Webclient (MWA) | ✅ |

### Administration (BCP Admin-Panel)

| Feature | Status |
|---------|--------|
| RBAC mit 7 Admin-Rollen (Rolle → Bereich-Matrix, BCP zeigt nur die erlaubten Seiten) | ✅ |
| SMTP-Queue-Management (BullMQ-nativ, Retry, Dead Letter, Retention, Auto-Flush, Dead-Letter-Benachrichtigung) | ✅ |
| DNS-Check in BCP SMTP-Konfiguration (MX, SPF, DKIM, DMARC, Autodiscover, PTR live) | ✅ |
| DNS-Einträge Tabellen-UI mit Statusampeln (grün/gelb) | ✅ |
| Nachrichtenablaufverfolgung (Message Trace) mit Filtern & CSV-Export | ✅ |
| Quarantäne-Verwaltung mit Detail-Slide-over, MIME-Vorschau und Freigabe (Zustellung) | ✅ |
| SMTP-Infrastruktur-Konfiguration (ESMTP, Banner, Relay, Greylisting) | ✅ |
| SSL/TLS-Verwaltung (integrierter HTTPS-Proxy, Zertifikats-Upload, Let's Encrypt mit automatischer Erneuerung und Live-TLS-Wechsel bei SMTP/IMAP/POP3) | ✅ |
| SSO-Provider-Verwaltung (OIDC/OAuth2, Schnellauswahl) | ✅ |
| LDAP/AD-Verbindungsverwaltung (Attributzuordnung, echter Bind-/Such-Verbindungstest, manueller + geplanter Sync) | ✅ |
| Rspamd-Integration (Schwellwerte, Bayes-Training, Modul-Übersicht) | ✅ |
| Audit-Log (alle Admin-Aktionen nachvollziehbar) | ✅ |
| Service-Konfiguration (live, kein Neustart nötig) | ✅ |
| Log-Viewer mit Log-Level pro Service | ⚠️ zeigt Mailfluss- und ausgewählte Auth-Ereignisse, nicht die vollständigen Service-Logs |
| Backup: MBOX/EML-Export (Self-Service pro Benutzer) | ❌ keine MWA-Oberfläche, und die Endpunkte sind über das API-Gateway nicht erreichbar |
| Backup: Admin-Voll-/Postfach-Backup zu S3 + MBOX-Wiederherstellung (Originalnachrichten inkl. Anhängen) | ⚠️ keine Point-in-Time Recovery; nicht Ende-zu-Ende getestet |
| Kubernetes Helm Chart 2.0.0 (gemeinsames Image `coremail-app`, Datenbanken gebündelt oder extern) | ⚠️ standardmäßig eine Replik, kein HPA; auf kind getestet (Pod Security `restricted`, NetworkPolicies, Einrichtung, SMTP → IMAP, Upgrade/Rollback) mit `scripts/k8s-e2e.sh`, dazu helm lint/kubeconform |
| Strukturierte JSON-Logs (pino) + Log-Level pro Service (zur Laufzeit änderbar) | ✅ |
| Web Push / VAPID-Benachrichtigungen (neue Mail, auch ohne geöffneten MWA-Tab) | ✅ |
| Auto-Mailbox-Provisionierung beim ersten Login (LDAP, OIDC mit Auto-Provisionierung) | ✅ |

### MWA Benutzer-Einstellungen

| Feature | Status |
|---------|--------|
| Anzeigename bearbeiten | ✅ |
| Passwort ändern (Stärkemeter, Sichtbarkeits-Toggle) | ✅ |
| Signaturen (Rich-Text Editor, Auto-Insert) | ✅ |
| Abwesenheitsassistent mit Zeitraum-Kalenderintegration | ✅ |
| Speicherübersicht pro Ordner mit Donut-Chart | ✅ |
| Lesebereich-Layout (rechts / unten / aus) | ✅ |
| Nachrichtendichte (kompakt / normal / komfortabel) | ✅ |
| Konversationsansicht (ein/aus) | ✅ |
| Design: Hell / Dunkel / System + 6 Akzentfarben | ✅ |
| Sicherheit: App-Passwörter & 2FA-Verwaltung | ✅ |

---

## Clients verbinden

CoreMail funktioniert mit allen Standard-Mail-Clients. Die empfohlene Konfiguration variiert je nach Client:

### Setup-Übersicht

| Client | Konto-Typ | Mail | Kalender + Kontakte |
|--------|-----------|------|---------------------|
| **Outlook 2024 LTSC** | „Andere E-Mail-Konten" → **IMAP** | IMAP+SMTP | Outlook-CalDav-Synchronizer-Plugin (gratis OSS) |
| **Outlook 2013–2021** | **IMAP** | IMAP+SMTP | Outlook-CalDav-Synchronizer |
| **Apple Mail** (Mac + iOS) | „Anderes Mail-Konto" → IMAP | IMAP+SMTP | Apple Kalender/Kontakte separat (CalDAV/CardDAV) |
| **Thunderbird** | IMAP-Konto | IMAP+SMTP | Lightning (CalDAV) + TbSync (CardDAV) |
| **eM Client** | IMAP-Konto | IMAP+SMTP | CalDAV+CardDAV nativ |
| **K-9 Mail** (Android) | IMAP-Konto | IMAP+SMTP | DAVx⁵ für CalDAV/CardDAV |
| **Browser** | — | **MWA** unter `https://<dein-host>/` | inkl. Kalender/Kontakte im Web |

**Automatische Einrichtung:** Thunderbird, K-9 Mail / Thunderbird für Android, FairEmail, Evolution, KMail und eM Client richten sich über **Mozilla Autoconfig** (`autoconfig.<domain>` bzw. `/.well-known/autoconfig/`) allein aus der E-Mail-Adresse ein; iPhone, iPad und Mac erhalten ein fertiges **Apple-Konfigurationsprofil** (`.mobileconfig`: IMAP/SMTP + CalDAV/CardDAV oder ActiveSync) unter MWA → Einstellungen → Externe Clients. Outlook nutzt Autodiscover. DNS-Einträge und Details: [docs/clients.md](docs/clients.md).

### IMAP-Einstellungen

| Setting | Wert |
|---------|------|
| IMAP-Server | `mail.<deine-domain>` |
| IMAP-Port | **993** (implicit-TLS) oder **143** (STARTTLS — Login erst nach STARTTLS) |
| POP3-Port (optional) | **995** (implicit-TLS) oder **110** (STLS — Login erst nach STLS) |
| SMTP-Server | `mail.<deine-domain>` |
| SMTP-Port | **465** (implicit-TLS) oder **587** (STARTTLS, empfohlen — AUTH erst nach STARTTLS) |
| Authentifizierung | **PLAIN** oder **LOGIN** (SASL) |
| Username | `max@firma.de` (vollständige E-Mail-Adresse) |
| Passwort | Account-Passwort; bei aktivem MFA ist ein **App-Passwort Pflicht** |

### JMAP (seit v5.7.1)

Für JMAP-fähige Clients (z. B. Thunderbird mit JMAP-Support, Ltt.rs, eigene Web-Apps):

| Einstellung | Wert |
|-------------|------|
| Discovery | `https://mail.example.de/.well-known/jmap` |
| Session-URL | `https://mail.example.de/jmap/session` |
| Benutzername | vollständige E-Mail-Adresse |
| Passwort | Konto-Passwort oder **App-Passwort** (Pflicht bei aktivem MFA) |
| DNS (optional) | `_jmap._tcp.example.de. SRV 0 1 443 mail.example.de.` |

Push: EventSource (`/jmap/eventsource`) oder WebSocket (`wss://…/jmap/ws`, Subprotokoll `jmap`).
Schalter: BCP → Server → „JMAP" (Standard: an). Details: [docs/jmap.md](docs/jmap.md).

### App-Passwörter (für MFA-Accounts)

Der MFA-Code lässt sich über SMTP/IMAP/POP3/ActiveSync/Autodiscover/JMAP/CalDAV/CardDAV nicht übertragen. Bei aktivem 2FA **lehnen diese Protokolle das Account-Passwort ab** und akzeptieren nur ein **App-Passwort** — pro Client eines erstellen. Wiederholte Fehlanmeldungen sperren Client-IP und Konto für eine Weile (Umgebungsvariablen `MAIL_AUTH_*`).

1. Im MWA anmelden → Einstellungen → **Sicherheit** → „App-Passwörter"
2. „Neues App-Passwort" → Name eintippen (z.B. „Apple Mail Mac")
3. Generiertes Passwort kopieren (Format `XXXX-XXXX-XXXX-XXXX`)
4. Im Client als Passwort eintragen
5. Bei Verlust/Diebstahl: einzelnes App-Passwort widerrufen — andere bleiben gültig

### Hinweis zu Outlook

CoreMail bietet für Outlook (jede Version) keinen Exchange-Kontotyp — Outlook 2024 LTSC / Microsoft 365 erzwingen auf Exchange-Endpoints zudem Modern Auth mit Microsoft Entra ID. Outlook wird mit **IMAP+SMTP** eingerichtet (über „Andere E-Mail-Konten", bei aktivem MFA mit App-Passwort), Kalender + Kontakte werden per **CalDAV/CardDAV** synchronisiert (z. B. mit dem kostenlosen Outlook-CalDav-Synchronizer-Plugin).

---

## Schnellstart

> **Voraussetzung:** Docker ≥ 24 und Docker Compose ≥ 2.20.  
> Node.js ist für den reinen Docker-Betrieb **nicht** erforderlich.

### 1. Repository klonen

```bash
git clone https://github.com/MAGPEEK/CoreMail.git
cd CoreMail
```

### 2. Umgebung einrichten

```bash
bash scripts/setup.sh
```

Das Skript prüft Docker, erstellt die `.env` mit zufällig generierten Schlüsseln und zeigt die nächsten Schritte.

**Stack-Variante wählen** mit `--variant` (Standard: `standard`):

| Variante | Compose-Datei | Inhalt | Für |
|---|---|---|---|
| `minimal` | `infra/docker/docker-compose.minimal.yml` | coremail + PostgreSQL + Redis, Mails auf dem lokalen Volume, kein rspamd/ClamAV | 1–50 Benutzer, ~1 GB RAM |
| `standard` | `infra/docker/docker-compose.yml` | + MinIO, rspamd, ClamAV | Standard, bestehende Installationen |
| `full` | `infra/docker/docker-compose.full.yml` | alles + Ressourcenlimits, Log-Rotation, Profile `minio` / `backup` / `geoip` | 50–500 Benutzer, ab 4 GB RAM |

```bash
bash scripts/setup.sh --variant minimal    # danach: docker compose -f infra/docker/docker-compose.minimal.yml up -d
```

Vergleich, Speicher einbinden (eigene Platte, NFS/SMB, Bind-Mounts), Backups und Wechsel zwischen den Varianten: [docs/docker-compose.md](docs/docker-compose.md) (Englisch).

Alternativ manuell:

```bash
cp .env.example .env
```

### 3. `.env` prüfen

`scripts/setup.sh` hat die fünf Pflichtwerte bereits zufällig gesetzt. Bei manueller Einrichtung ersetzen:

```env
JWT_SECRET=<openssl rand -hex 32>
PEPPER=<openssl rand -hex 32>
POSTGRES_PASSWORD=<openssl rand -hex 20>
REDIS_PASSWORD=<openssl rand -hex 20>
MINIO_ROOT_PASSWORD=<openssl rand -hex 20>
```

Der Mail-Hostname wird nicht in der `.env`, sondern im Setup-Assistenten bzw. im BCP gesetzt.

### 4. TLS konfigurieren

**Option A — Integrierter HTTPS-Proxy (Standard):**  
CoreMail terminiert TLS selbst. Zertifikat nach dem Start im BCP unter **SSL/TLS** hochladen. Port `443` ist in der `docker-compose.yml` bereits gemappt.

**Option B — Externer Reverse Proxy:**  
Traefik, Caddy, nginx oder Synology DSM Application Portal übernehmen TLS.  
`"443:443"` in der `docker-compose.yml` auskommentieren.

### 5. Stack starten

```bash
docker compose -f infra/docker/docker-compose.yml up -d
```

Nach ca. 60–90 Sekunden sind alle Services bereit.

### 6. Ersten Admin-Account anlegen

Beim ersten Aufruf von `https://<MAIL_HOSTNAME>/bcp/` erscheint automatisch der Setup-Assistent zum Anlegen des ersten Admin-Accounts.

Alternativ per API:

```bash
curl -s -X POST https://<MAIL_HOSTNAME>/api/v1/admin/setup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@meinedomain.de",
    "password": "sicheres-passwort",
    "displayName": "Administrator"
  }'
```

---

## Docker Compose

### Aufbau des CoreMail-Stacks

CoreMail besteht aus **sechs Containern** (ein Custom-Image, fünf Standard-Images):

| Container | Image | Aufgabe |
|-----------|-------|---------|
| `coremail` | `magpeek/coremail-app:9.0.0` | Alle Mail-Dienste + Webmail + Admin-Panel + CLI |
| `rspamd` | `rspamd/rspamd:4.0.0` | Anti-Spam Engine (Bayes, DKIM/SPF/DMARC, Fuzzy) |
| `clamav` | `clamav/clamav:stable` | Open-Source Antivirus (GPL), freshclam Updates |
| `postgres` | `postgres:16-alpine` | Datenbank für Mails, Benutzer, Kalender |
| `redis` | `redis:7-alpine` | Sessions, SMTP-Queue (BullMQ), Live-Updates |
| `minio` | `pgsty/minio` (pinned) | Objektspeicher für Anhänge, Quarantäne und Backups |

Der App-Container (`coremail`) enthält intern alle Mail-Dienste — SMTP, IMAP, POP3, JMAP, ActiveSync, CalDAV/CardDAV, Webmail, Admin-Panel und die Admin-CLI — verwaltet von `supervisord`. Nach außen sind Port 3000 (HTTP), 80/443 (ACME + HTTPS) sowie die Mail-Ports (25, 465, 587, 143, 993, 110, 995) sichtbar.

### Die `docker-compose.yml`

Die Datei `infra/docker/docker-compose.yml` ist seit v5.8.0 auf das Nötigste reduziert und durchgehend kommentiert. Sie braucht genau **fünf Werte** aus der `.env` — fehlt einer, bricht `docker compose up` sofort mit einer sprechenden Meldung ab statt später mit einem halb gestarteten Stack:

```yaml
# Auszug — vollständige Datei im Repository
services:
  coremail:
    image: magpeek/coremail-app:${COREMAIL_VERSION:-9.0.0}
    environment:
      JWT_SECRET: ${JWT_SECRET:?JWT_SECRET fehlt in .env  →  openssl rand -hex 32}
      PEPPER:     ${PEPPER:?PEPPER fehlt in .env  →  openssl rand -hex 32}
      DATABASE_URL: postgresql://coremail:${POSTGRES_PASSWORD:?POSTGRES_PASSWORD fehlt in .env}@postgres:5432/coremail
      REDIS_URL:    redis://:${REDIS_PASSWORD:?REDIS_PASSWORD fehlt in .env}@redis:6379
      MINIO_SECRET_KEY: ${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD fehlt in .env}
      RSPAMD_URL:  http://rspamd:11334
      CLAMAV_HOST: clamav
    ports:
      - "25:25"     # SMTP Empfang          - "143:143"  # IMAP
      - "465:465"   # SMTPS                 - "993:993"  # IMAPS
      - "587:587"   # SMTP Submission       - "110:110"  # POP3  (optional)
      - "80:3000"   # Let's-Encrypt + Redirect   - "995:995"  # POP3S (optional)
      - "443:443"   # HTTPS (integrierter TLS-Proxy)
      - "3000:3000" # HTTP ohne TLS — Ersteinrichtung / eigener Reverse-Proxy
  postgres: { image: postgres:16-alpine }
  redis:    { image: redis:7-alpine }
  minio:    { image: pgsty/minio:RELEASE.2026-08-04T00-00-00Z }
  rspamd:   { image: rspamd/rspamd:4.0.0 }
  clamav:   { image: clamav/clamav:stable }
```

Alles Weitere (Hostname, Domains, DNS-Vorlagen, Zertifikate, Konnektoren, Banner) wird **nach dem Start** im Admin-Panel unter `http://<server>:3000/bcp/` oder per CLI eingerichtet — nicht in der Compose-Datei. Interne Service-Ports und URLs haben im Image feste Defaults und tauchen in der Compose nicht mehr auf.

Hinter einem eigenen Reverse-Proxy (Traefik, Caddy, nginx, Synology): die Zeilen `"80:3000"` und `"443:443"` entfernen und den Proxy auf `http://<server>:3000` zeigen lassen.

### Häufige Befehle

```bash
# Stack starten (Images werden automatisch von Docker Hub geladen)
docker compose -f infra/docker/docker-compose.yml up -d

# Status aller Container prüfen
docker compose -f infra/docker/docker-compose.yml ps

# Logs in Echtzeit verfolgen
docker compose -f infra/docker/docker-compose.yml logs -f coremail

# Einzelnen Dienst innerhalb des Containers neu starten
docker exec coremail supervisorctl restart api-gateway

# Stack stoppen (Daten bleiben erhalten)
docker compose -f infra/docker/docker-compose.yml down

# Auf neue Version aktualisieren
docker compose -f infra/docker/docker-compose.yml pull && \
docker compose -f infra/docker/docker-compose.yml up -d
```

### Logs einsehen

```bash
# Alle Container live
docker compose -f infra/docker/docker-compose.yml logs -f

# Nur CoreMail-App
docker compose -f infra/docker/docker-compose.yml logs -f coremail
```

---

## Zugriff

| URL | Beschreibung |
|-----|-------------|
| `https://<MAIL_HOSTNAME>/` | Webmail (MWA — Mail Web Access) |
| `https://<MAIL_HOSTNAME>/bcp/` | Admin-Panel (BCP — Backend Control Panel) |
| `https://<MAIL_HOSTNAME>/.well-known/jmap` | JMAP-Discovery |
| `https://<MAIL_HOSTNAME>/Microsoft-Server-ActiveSync` | ActiveSync (iOS / Android / Outlook Mobile) |
| `https://<MAIL_HOSTNAME>/Autodiscover/Autodiscover.xml` | Autodiscover |
| `http://localhost:9001` | MinIO Web-Konsole (nur lokal) |

**Mail-Ports:**

| Port | Protokoll | Verschlüsselung |
|------|-----------|----------------|
| 25 | SMTP (eingehend) | STARTTLS |
| 465 | SMTPS (Submission) | Implizites TLS |
| 587 | SMTP Submission | STARTTLS (Pflicht vor AUTH) |
| 143 | IMAP | STARTTLS (Pflicht vor dem Login) |
| 993 | IMAPS | Implizites TLS |
| 110 | POP3 | STLS (Pflicht vor dem Login) |
| 995 | POP3S | Implizites TLS |

---

## Konfiguration

Die `.env` enthält nur, was der Stack vor dem ersten Start wissen muss. `bash scripts/setup.sh` erzeugt sie mit Zufallswerten.

```env
# ── Pflicht ────────────────────────────────────────────────
JWT_SECRET=…            # openssl rand -hex 32 — signiert Login-Tokens
PEPPER=…                # openssl rand -hex 32 — NIE nachträglich ändern
POSTGRES_PASSWORD=…     # interne Datenbank-Passwörter
REDIS_PASSWORD=…
MINIO_ROOT_PASSWORD=…

# ── Von setup.sh erzeugt (docs/deployment-security.md) ─────
BACKUP_ENCRYPTION_KEY=…         # openssl rand -hex 32 — Backup-Verschlüsselung; KOPIE AUSSERHALB DES SERVERS AUFBEWAHREN
RSPAMD_CONTROLLER_PASSWORD=…    # rspamd-Web-UI / Controller-API
COREMAIL_DB_USER=coremail_app   # DB-Rolle ohne Superuser-Rechte (nur bei neuer Datenbank;
COREMAIL_DB_PASSWORD=…          #   ungesetzt = Superuser „coremail")

# ── Optional (Defaults in Klammern) ────────────────────────
#COREMAIL_VERSION=9.0.0         # Image-Tag
#RSPAMD_NET_PREFIX=10.253.253   # /29 des App ↔ rspamd-Netzes (nur bei Kollision ändern)
#LOG_LEVEL=info                 # error | warn | info | debug
#TZ=Europe/Berlin
#MINIO_ROOT_USER=minioadmin
#BACKUP_SCHEDULE=0 2 * * *      # Vollbackup (Cron, UTC)
#BACKUP_RETENTION_DAYS=30
#RETENTION_SCHEDULE=0 3 * * *   # Aufbewahrungsrichtlinien
#COREMAIL_CPU_LIMIT=2  /  COREMAIL_MEM_LIMIT=2g
#VAPID_PUBLIC_KEY= / VAPID_PRIVATE_KEY= / VAPID_SUBJECT=   # Browser-Push (npx web-push generate-vapid-keys)
#HTTPS_PORT=8443                # falls 443 am Host belegt
# Feineinstellungen und Notausgänge (Quotas, Anti-Spoofing, Verbindungs- und
# Rate-Limits, SMTP_EXT_*, …): siehe .env.example — die Compose-Dateien reichen sie durch.
```

Hostname, Domains, Zertifikate, Konnektoren, Spam-/Virenschutz-Einstellungen, LDAP/SSO und Backups werden im **BCP** (`/bcp/`) oder per **CLI** verwaltet und in der Datenbank gespeichert.

---

## DNS-Einrichtung

Folgende DNS-Einträge für `mail.domain.de` anlegen:

```dns
; A-Record
mail.domain.de.           A     <Server-IP>

; MX-Record
domain.de.                MX 10 mail.domain.de.

; SPF
domain.de.                TXT   "v=spf1 mx -all"

; DKIM (Public Key aus dem BCP Admin-Panel kopieren)
coremail._domainkey.domain.de. TXT "v=DKIM1; k=rsa; p=<public-key>"

; DMARC
_dmarc.domain.de.         TXT   "v=DMARC1; p=reject; rua=mailto:dmarc@domain.de"

; Autodiscover SRV (für ältere Outlook-Versionen)
_autodiscover._tcp.domain.de. SRV 0 0 443 mail.domain.de.
```

Den DKIM-Public-Key findet man im BCP unter **Domains → Domain auswählen → DKIM**.

Ab v3.17.6 prüft CoreMail alle DNS-Einträge live im BCP unter **SMTP-Konfiguration → DNS-Check** — inklusive Statusampeln für MX, SPF, DKIM, DMARC, Autodiscover und PTR.

---

## TLS-Zertifikate

CoreMail unterstützt zwei TLS-Betriebsmodi:

### Option A — Integrierter HTTPS-Proxy (Standard)

Ab v3.17.0 terminiert CoreMail TLS selbst (Node.js HTTPS auf Port 443).  
Zertifikat im BCP unter **Server → SSL/TLS** hochladen und aktivieren. Hot-Reload ohne Neustart.

### Option B — Externer Reverse Proxy

Für Betrieb hinter Traefik, Caddy, nginx, DSM Application Portal o.ä.:  
In der `docker-compose.yml` die Zeile `"443:443"` auskommentieren. CoreMail läuft dann nur auf Port 3000 (HTTP).

**Let's Encrypt mit Certbot (für Option B mit eigenem nginx):**

```bash
certbot certonly --standalone -d mail.meinedomain.de
```

Für die lokale Entwicklung genügen selbstsignierte Zertifikate:

```bash
bash scripts/gen-dev-certs.sh
```

---

## Admin-CLI `coremail` (seit v5.8.0)

Die CLI steckt im App-Image und spricht dieselbe Admin-API wie das BCP — gleiche Rollen, gleiche Prüfungen, gleicher Audit-Log. Vollständige Referenz: **[docs/cli.md](docs/cli.md)**.

```bash
alias coremail='docker exec -it coremail coremail'

coremail login -u admin@example.de                   # Sitzung speichern (TOTP wird abgefragt)
coremail user list --domain example.de               # Benutzer anzeigen
coremail user create max@example.de --name "Max Muster" --quota 10GB
coremail user delete max@example.de
coremail mailbox list --sort used                    # Postfächer mit Belegung
coremail shared create team@example.de --name "Team" # Shared Mailbox …
coremail shared grant team@example.de max@example.de FULL_ACCESS SEND_AS   # … berechtigen
coremail connector status                            # SMTP/IMAP/POP3/JMAP mit Ports und Zustand
coremail connector disable pop3                      # Konnektor aus (an: enable; einzelner Port: --port 995)
coremail connector listener set <id> --port 1143 --ssl false
coremail smtp banner set "mail.example.de ESMTP"     # SMTP-Begrüßung (reset: Standard)
coremail cert letsencrypt --domains mail.example.de,autodiscover.example.de \
    --email admin@example.de --services SMTP,IMAP,POP3
coremail cert activate mail.example.de --https --protocol
coremail --json user list | jq                       # alles auch als JSON
```

Für Skripte: `COREMAIL_ADMIN_EMAIL`/`COREMAIL_ADMIN_PASSWORD` (plus `COREMAIL_ADMIN_TOTP`) oder ein fertiges `COREMAIL_TOKEN`; gegen entfernte Server `--server https://mail.example.de`.

---

## Befehlsreferenz

Alle wichtigen Befehle für den täglichen Betrieb sind in **[COMMANDS.md](COMMANDS.md)** zusammengefasst:

| Abschnitt | Inhalt |
|-----------|--------|
| Container & Dienste | Stack starten/stoppen, Dienststatus, Health-Check |
| Admin-Token | Authentifizierung gegen die REST API |
| Benutzer verwalten | Anlegen, Passwort setzen, Quota, Rolle, Postfach provisionieren |
| Domains | Domain hinzufügen, DKIM-Key abrufen |
| Warteschlangen | Queue-Stats, Job-Details, Retry, Dead Letter, Queue leeren |
| Logs & Diagnose | Container-Logs, Audit-Log, Service-Log-Level |
| Nachrichtenablaufverfolgung | Message Trace, Filterung, CSV-Export |
| Datenbank | PostgreSQL-Abfragen (Benutzer, Mails, Speicher) |
| Redis | Queue-Längen, Sessions, Greylisting |
| SMTP testen | Verbindungstest, TLS-Check, Testmail senden |
| Backup | Datenbank-Dump, Restore, MinIO-Backup |
| Updates | Auf neue Image-Version aktualisieren |

```bash
# Beispiele

# Health-Check
curl -s http://localhost:3000/healthz | jq

# Queue-Stats (BullMQ-nativ)
curl -s http://localhost:3000/api/v1/admin/queues/stats \
  -H "Authorization: Bearer $TOKEN" | jq

# Dead-Letter-Jobs anzeigen
curl -s "http://localhost:3000/api/v1/admin/queues/jobs?state=failed" \
  -H "Authorization: Bearer $TOKEN" | jq '.jobs[].failedReason'

# Alle Dead-Letter-Jobs wiederholen
curl -s -X POST http://localhost:3000/api/v1/admin/queues/retry-failed \
  -H "Authorization: Bearer $TOKEN" | jq

# Rspamd-Status prüfen
curl -s http://localhost:3000/api/v1/admin/security/status \
  -H "Authorization: Bearer $TOKEN" | jq
```

→ **[Vollständige Befehlsreferenz in COMMANDS.md](COMMANDS.md)**

---

## Docker Hub

CoreMail besteht aus **einem einzigen Custom-Image** — alle Services in einem Container, verwaltet von `supervisord`.

| Image | Inhalt |
|-------|--------|
| [`magpeek/coremail-app`](https://hub.docker.com/r/magpeek/coremail-app) | Alle Services + MWA/BCP-Frontends |

Rspamd und ClamAV laufen in offiziellen Standard-Images — kein eigenes Image notwendig.

```bash
# Neueste Version ziehen und starten
docker compose -f infra/docker/docker-compose.yml pull
docker compose -f infra/docker/docker-compose.yml up -d

# Bestimmte Version
docker pull magpeek/coremail-app:9.0.0
```

**Multi-Arch:** Das Image wird für `linux/amd64` und `linux/arm64` gebaut (Synology NAS, Raspberry Pi, Apple Silicon).

---

## Versionsverlauf

### v9.x — Sicherheitshärtung & Exchange-Parität

| Version | Highlights |
|---------|-----------|
| **v9.0.0** | **OWASP-Härtung + Mail-Logik auf Exchange-Niveau** (Breaking). OWASP/ASVS-Audit in vier Bereichen und zwei Review-Runden, alle Befunde mit Tests behoben. Gemeinsame Login-Sperre für Web und Mail, HttpOnly-Refresh-Cookies, SSE-Tickets, DMARC/SPF auf der echten Sitzung mit Schutz der eigenen Domain, ReDoS-sichere Regeln, DoS-Grenzen vor der Anmeldung, SSRF-Schutz, HMAC-signierte Audit-Exporte, verschlüsselte Backups, Schema-Sync ohne stillen Datenverlust, gehärtete Container, signierte CI-Images. SMTP DSN/CHUNKING/SMTPUTF8, 48 h Zustellversuche mit Verzögerungsmeldung; IMAP QRESYNC/SORT/THREAD/ACL/COMPRESS; Quota-Stufen, gelöschte Elemente wiederherstellen (30 Tage), Abwesenheitsnotiz einmal pro Zeitraum, Server-Entwürfe + Rückgängig-Senden; Webmail-Tastenkürzel, Rückgängig, Suchoperatoren; BCP-Rechte-Tabelle + einheitliche Listen; Thunderbird-Autoconfig + Apple-Profil; Compose-Varianten minimal/full; Helm 2.0.0. 1.894 Tests; e2e MinIO 135/135, Dateisystem 130/130. |

### v8.x — Protokoll-Konformität

| Version | Highlights |
|---------|-----------|
| **v8.0.0** | **Protokoll-Konformität** (Breaking). Alle Protokolle gegen RFC/MS-Spezifikation und Clean Code geprüft; alle Befunde mit Tests behoben. SMTP-Ergebnisse pro Empfänger, geprüftes Smarthost-TLS, RFC-3464-Bounces; IMAP-Sequenznummern pro Sitzung, modified UTF-7; POP3 atomares QUIT + Maildrop-Sperre; JMAP vollständige Absender-Policy, seitenweises `/changes`; CalDAV/CardDAV-Discovery + Filter; ActiveSync 14.1 (AirSyncBase, ItemOperations, Search, MeetingResponse, Pflicht-Policy-Key, Remote-Wipe). Lokaler Speicher auf Docker-Volume, S3 mit TLS, `coremail storage migrate`. Geänderte Zugangsdaten schließen offene Sitzungen sofort. Neues Helm-Chart 1.0.0. Ende-zu-Ende getestet (MinIO 131/131, Dateisystem 126/126). |

### v7.x — Sicher ab Werk

| Version | Highlights |
|---------|-----------|
| **v7.0.0** | **Sicher ab Werk** (Breaking). Mailprogramme: App-Passwörter bei Zwei-Faktor-Anmeldung Pflicht, Zugangsdaten nur nach TLS (IMAP STARTTLS, POP3 STLS, SMTP 587), gemeinsame Brute-Force-Sperre. Web/Admin: gehashte, rotierende Sessions mit Widerruf, gehärtete MFA (Backup-Codes, WebAuthn, verschlüsselte TOTP-Secrets), RBAC pro Bereich, Setup-Token, `TRUST_PROXY`, keine Abstürze durch fehlerhafte Requests. Originalmails gespeichert und byte-genau ausgeliefert, atomare UID/modSeq-Vergabe. Neu: OIDC-SSO, LDAP/AD-Login + Sync, automatische Zertifikatserneuerung, Abwesenheitsnotiz, S/MIME-Prüfung, IMAP SEARCH/Literale, CalDAV REPORT + Serientermine, Quarantäne-Freigabe. Entfernt: EWS. MinIO-Image jetzt `pgsty/minio` (gepinnt). Ende-zu-Ende getestet (95/95). |

### v6.x — Sicherheit & Aufräumen

| Version | Highlights |
|---------|-----------|
| **v6.0.0** | **Sicherheits- und Aufräum-Release** nach vollständigem Code-Review. Behoben: Token-Prüfung (Refresh-Tokens nicht mehr als Access-Token gültig, ungültige Tokens bringen keine Dienste mehr zum Absturz), JMAP-Prototype-Pollution, Bcc-Leck und Delegationsrechte, XSS in Shared Mailboxes, Zugriff auf fremde Postfächer (Posteingangsregeln, EWS ResolveNames), SMTP-Befehlsinjektion nach zu großem DATA, IMAP UID FETCH/STORE/EXPUNGE, verlorene ActiveSync-/EWS-Mails, DKIM für Port 465/587, Spamfilter-Verbindungsprüfung, Aufbewahrung nach Zustellzeit. Entfernt: ungenutzte storage-api, PowerShell-Stub, tote BCP-Seiten, OpenTelemetry-Module. EWS hat einen eigenen Schalter. Automatisierte Tests für jeden Fix. |

### v5.x — IMAP4rev2 + RFC-Compliance + Stack-Slim-down

| Version | Highlights |
|---------|-----------|
| **v5.9.0** | **Repository komplett auf Englisch**: README, CHANGELOG, Doku, Code- und Infra-Kommentare, CLI-Ausgaben; deutsches README bleibt als `README.de.md`. Enthält die v5.8.0-Features als erstes veröffentlichtes Image (`magpeek/coremail-app:5.9.0`). |
| **v5.8.0** | **Admin-CLI `coremail`** (neues Paket `cli`, im Image unter `/usr/local/bin/coremail`): Benutzer/Postfächer/Shared Mailboxes anzeigen, anlegen, löschen; Konnektoren SMTP/IMAP/POP3/JMAP/EWS ein-/ausschalten, Listener-Ports/TLS; SMTP-Banner; Zertifikate (Self-Signed, Let's Encrypt, aktivieren, erneuern). **Neue `docker-compose.yml`**: nur die nötigen Parameter, Pflichtwerte mit Startabbruch-Prüfung, `setup.sh` erzeugt die `.env`. |
| **v5.7.1** | **JMAP-Server** — neues Paket `jmap-server` (Port 3006): RFC 8620 Core, 8621 Mail (Mailbox/Email/Thread/Identity/EmailSubmission/SearchSnippet/VacationResponse), 8887 WebSocket, 9404 Blob, 9425 Quota, 9670 Principals/Sharing, 9749 VAPID. Discovery `/.well-known/jmap`, Push via EventSource + WebSocket, Schalter im BCP (Default an). Siehe [docs/jmap.md](docs/jmap.md). |
| **v5.7.0** | Build-Härtung: pnpm auf 11 gepinnt, 70 veraltete `src/*.js`-Artefakte entfernt, `noEmit` in Frontend-tsconfigs. |
| **v5.6.1** | **Verteilergruppen (DistributionGroups) komplett entfernt** — selten genutzt, Use-Case besser mit Shared Mailboxes (Team-Postfächer) oder externem Listserv-Tool gelöst. Schema-Drop von 2 Tabellen + Enum, BCP-Page entfernt, EMS-Cmdlets entfernt. |
| **v5.6.0** | **OAuth2 / Modern Auth komplett aus dem Stack entfernt** (~970 LOC + 4 Prisma-Tabellen). XOAUTH2 hat keine Mainstream-Client-UI für non-Microsoft-Server. JWT zurück auf HS256 (`JWT_SECRET`). Mail-Clients nutzen App-Passwörter, MWA/BCP Session-JWTs. |
| **v5.5.0** | **IMAP4rev2** (RFC 9051) compliance: STARTTLS + AUTHENTICATE SASL + UNSELECT + ID. Entscheidung gegen XOAUTH2 dokumentiert. |
| **v5.4.0** | Outlook-Einrichtung vereinfacht: Outlook → „Andere E-Mail-Konten" → IMAP, Kalender/Kontakte via CalDAV/CardDAV. |
| **v5.3.5** | IMAP FETCH komplett rewritten: ENVELOPE-Bug fixed (NIL-Listen RFC 3501 §7.4.2), echte BODYSTRUCTURE statt BODY[TEXT], INTERNALDATE, BODY[]/BODY[HEADER]/BODY.PEEK[*]/RFC822-Varianten |
| **v5.3.1** | IMAP vollständige Command-Suite: CREATE, DELETE, RENAME, APPEND, COPY, UID COPY, MOVE, UID MOVE, SEARCH, UID SEARCH, CLOSE, CHECK. UID-Compound-Dispatcher-Bug fixed. POP3 App-Password + Byte-Stuffing fix. |
| **v5.2.19** | parseLine empty-quoted-string fix (`LIST "" "*"`) — Mac Mail/iOS Mail/Thunderbird konnten ihre Ordnerliste nie über LIST holen |
| **v5.2.18** | IMAP SPECIAL-USE + LSUB + NAMESPACE + STATUS für Mac Mail / iOS Mail |

### v3.18.x — Feature-Polish & Production-Hardening

| Version | Highlights |
|---------|-----------|
| **v3.18.40** | Externe Clients & Outlook Setup-Page im OWA (CalDav-Synchronizer-Anleitung) |
| **v3.18.36** | Hostname-Auto-Derive für alle Domains generisch + Bilder-Privacy-Banner gehärtet |
| **v3.18.30** | BigInt-Crash-Fix + Audit-Toggle + Audit-Translations |
| **v3.18.25** | Calendar-Invitations iMIP/iTIP (RFC 6047/5546) — Outlook/Gmail Annehmen/Ablehnen-Buttons |
| **v3.18.18** | CalDAV-URL-Anzeige im Share-Dialog + Toolbar-Share-Button |
| **v3.18.14** | Kalender teilen mit READ/WRITE-Permission + Sidebar-Sektion „Geteilt mit mir" |
| **v3.18.11** | MWA Globales Adressbuch (GAL-Browser) mit Tabs „Mein/Globales Adressbuch" |
| **v3.18.10** | Bilder-Privacy-Banner (Outlook/Gmail-Style) — externe `<img>` blockiert bis Bestätigung |
| **v3.18.7** | Audit-Log v2: Filter + PDF + SHA-256 + Stats + Anomalien + Meta-Logging |
| **v3.18.5** | eDiscovery & Legal Hold komplett entfernt |
| **v3.18.4** | Signaturen Rich-Text-Editor (Tiptap) mit Bildern/Links/Schriften (10 Fonts) |
| **v3.18.0** | Outlook-Style Posteingangsregeln (Inbox Rules) — Forward/Redirect via BullMQ |

### v3.17.x — Infrastruktur-Festigung

| Version | Highlights |
|---------|-----------|
| **v3.17.0** | Integrierter HTTPS-Proxy (Port 443, Hot-Reload via Redis, BCP → SSL/TLS-Verwaltung) |
| **v3.16.6** | Empfänger-Autocomplete im Compose + Resizable Panels + Ansicht-Einstellungen |
| **v3.15.0** | DNS-Hardening: trusted Resolver (8.8.8.8/1.1.1.1/9.9.9.9) + Cross-Validation |
| **v3.14.0** | Pentest-Fixes: SMTP Brute-Force-Schutz + Rate-Limiting + Fail2Ban + Firewall |
| **v3.13.0** | SMTP-Audit: 5 kritische Bugs gefixt + IANA-Zeitzonen + OWA → MWA Umbenennung |
| **v3.11.0** | Aufbewahrungsrichtlinien Exchange-2019: DPT/RPT/Personal-Tags + Managed Folder Assistant |
| **v3.5.5** | MWA jetzt direkt unter `/` (statt `/owa/`) |
| **v3.2.3** | Admin-Panel umbenannt: ECP → BCP, Pfad `/ecp/` → `/bcp/` |
| **v2.1.19** | Grafana + Prometheus aus Stack entfernt; Synology-Compose um rspamd + clamav ergänzt |

→ [Vollständiger Changelog](CHANGELOG.md)

---

## Mitwirken

Beiträge sind herzlich willkommen!

```bash
git checkout -b feature/mein-feature
# Änderungen vornehmen
pnpm -r exec tsc --noEmit
git push origin feature/mein-feature
# Pull Request öffnen
```

---

## Lizenz

MIT License — siehe [LICENSE](LICENSE)

---

<div align="center">
  <b>CoreMail v9.0.0</b> · Der OpenSource Mailserver für kleine und mittlere Umgebungen<br>
  <sub>IMAP4rev2 + JMAP + SMTP + POP3 + CalDAV + CardDAV + ActiveSync</sub><br>
  <sub>Entwickelt mit ❤️ · <a href="https://github.com/MAGPEEK/CoreMail">github.com/MAGPEEK/CoreMail</a></sub>
</div>
