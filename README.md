# CoreMail

> **Coremail — der OpenSource Mailserver für kleine und mittlere Umgebungen.**  
> Aufgebaut auf React + Node.js/TypeScript, container-first, vollständig selbst gehostet.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22+-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue.svg)](https://www.typescriptlang.org)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED.svg)](https://www.docker.com)
[![Version](https://img.shields.io/badge/Version-5.5.0-brightgreen.svg)](https://github.com/MAGPEEK/CoreMail/releases)
[![IMAP4rev2](https://img.shields.io/badge/IMAP4-rev2-blue.svg)](https://datatracker.ietf.org/doc/html/rfc9051)
[![CalDAV](https://img.shields.io/badge/CalDAV%2FCardDAV-supported-blue.svg)](https://datatracker.ietf.org/doc/html/rfc4791)

📄 **[docker-compose.yml](infra/docker/docker-compose.yml)** — sofort einsatzbereit, einfach herunterladen und starten  
📋 **[COMMANDS.md](COMMANDS.md)** — Befehlsreferenz: Dienste prüfen, Benutzer anlegen, Queues, Logs, Backup  
📝 **[CHANGELOG.md](CHANGELOG.md)** — Vollständiger Versionsverlauf

**CoreMail** ist ein vollständiger, selbst gehosteter Mailserver für Klein- und Mittelunternehmen mit **10–500 Benutzern** — ohne Lizenzkosten, ohne Vendor Lock-in, mit voller Datensouveränität.

**🎯 Standard-Mail-Protokolle.** CoreMail spricht **IMAP4rev2** (RFC 9051) + **SMTP-Submission** + **POP3** + **EWS** + **CalDAV/CardDAV** + **ActiveSync** — alle Clients (Apple Mail, Thunderbird, Outlook, K-9 Mail, eM Client, iOS Mail) funktionieren nativ. **App-Passwörter** für MFA-kompatible Anmeldung. Kein VPN, kein Connector, keine Drittanbieter-Software.

> **Aktuelle Version: v5.5.0** — IMAP4rev2 (RFC 9051) + STARTTLS + AUTHENTICATE SASL + Mac-Mail-Vollkompatibilität · [Changelog](CHANGELOG.md) · [Releases](https://github.com/MAGPEEK/CoreMail/releases) · [Docker Hub](https://hub.docker.com/r/magpeek/coremail-app)
>
> **Wichtiger Hinweis (seit v5.4.0)**: MAPI/HTTP wurde aus dem Stack entfernt — Outlook 2024 LTSC erzwingt Microsoft-Entra-only-Modern-Auth, was für non-Microsoft-Server fundamental nicht funktioniert. Verwende **Outlook → „Andere E-Mail-Konten" → IMAP**. Kalender + Kontakte via CalDAV/CardDAV (Apple Kalender, Outlook-CalDav-Synchronizer-Plugin, Thunderbird Lightning).

---

## Inhalt

1. [Features](#features)
2. [Clients verbinden](#clients-verbinden)
3. [Schnellstart](#schnellstart)
4. [Docker Compose](#docker-compose)
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

### E-Mail-Protokolle

| Feature | Status | RFC |
|---------|--------|-----|
| **SMTP** Inbound (Port 25) + Submission (465 implicit-TLS, 587 STARTTLS) | ✅ | 5321 + 6409 |
| SMTP Outbound mit MX-Lookup & DKIM-Signierung | ✅ | 6376 |
| **IMAP4rev2** (Port 143 STARTTLS, 993 implicit-TLS) | ✅ | **9051** |
| IMAP-Capabilities: AUTHENTICATE PLAIN/LOGIN, IDLE, CONDSTORE, ESEARCH, SPECIAL-USE, LIST-EXTENDED, NAMESPACE, MOVE, UNSELECT, UIDPLUS, ID | ✅ | 2087, 2971, 3502, 3691, 4314, 4978, 5161, 5256, 5267, 5258, 6154, 6851 |
| **POP3** (Port 110 STLS, 995 implicit-TLS) + SASL PLAIN/LOGIN + App-Password-Support | ✅ | 1939 + 5034 |
| EWS (Exchange Web Services) — Outlook Desktop 2010–2021 (SOAP/XML) | ✅ | MS-OXWSCORE |
| Autodiscover v1 (XML) + v2 (JSON) — IMAP/SMTP/ActiveSync | ✅ | MS-OXDISCO |
| ActiveSync EAS 14.1 — iOS Mail, Android, Outlook Mobile | ✅ |
| MWA — Mail Web Access (React, Exchange-ähnliches Layout) | ✅ |
| RFC 822 Quelltext-Ansicht (Modal im MWA) | ✅ |
| Empfänger-Autocomplete im Compose (An/CC/BCC, Keyboard-Nav) | ✅ |
| Resizable Panels im MWA (Ordnerstruktur / Liste / Lesebereich) | ✅ |
| Freigegebene Postfächer mit voller Ordner-Struktur (Inbox, Sent, Trash, …) | ✅ |
| Shared Mailbox-Reader im MWA — „Weiteres Postfach öffnen" über Konto-Dropdown | ✅ |
| Folder-CRUD in Shared Mailboxes (Neuer Ordner, Umbenennen, Löschen, Standard-Folder geschützt) | ✅ |
| E-Mail-Aliase pro User-Postfach und Shared-Mailbox | ✅ |
| Verteilergruppen (statisch & dynamisch via LDAP-Filter) | ✅ |
| Raum- und Gerätepostfächer mit Auto-Accept | ✅ |
| Abwesenheitsassistent | ✅ |
| Posteingangsregeln & Transportregeln + 9 Exchange-Vorlagen (Disclaimer, CEO-Phishing, PCI-DSS, …) | ✅ |
| Volltextsuche (< 200 ms, PostgreSQL GIN-Index) | ✅ |
| S/MIME — Signierung, Verschlüsselung, Verifikation | ✅ |
| SMTP-Gateway-Modus (Relay zu Upstream-MTA) | ✅ |
| Aufbewahrungsrichtlinien Exchange-2019-konform (DPT/RPT/Personal Tags · 8 Vorlagen · Recoverable Items) | ✅ |
| Managed Folder Assistant (Tag-Hierarchie, Soft/Hard Delete, Legal-Hold-aware) | ✅ |
| Outlook Modern Auth (OAuth2 / PKCE) | ✅ |
| PowerShell-Remoting (EMS mit 20+ Cmdlets) | ✅ |

### Kalender & Zusammenarbeit

| Feature | Status |
|---------|--------|
| Persönlicher Kalender | ✅ |
| Geteilte Teamkalender | ✅ |
| Besprechungsanfragen (iCal-Standard) | ✅ |
| Frei/Gebucht-Abfrage | ✅ |
| Raum- und Ressourcenbuchung mit Auto-Accept | ✅ |
| CalDAV (iOS, Android, Thunderbird) | ✅ |
| Kontakte & CardDAV | ✅ |
| Aufgaben & Notizen | ✅ |
| Globale Adressliste (GAL) | ✅ |

### Sicherheit

| Feature | Status |
|---------|--------|
| SPF / DKIM / DMARC / ARC-Validierung | ✅ |
| DKIM-Signierung ausgehender E-Mails | ✅ |
| DNSBL (Spamhaus ZEN, SpamCop, konfigurierbar) | ✅ |
| Greylisting mit automatischer Whitelist | ✅ |
| Country-Filtering (MaxMind GeoIP) | ✅ |
| ClamAV Antivirus (separater Container) | ✅ |
| Rspamd 4.0 Anti-Spam (Bayes, selbstlernend, separater Container) | ✅ |
| Adress-Blacklist (Global / Domain / Benutzer) | ✅ |
| Attachment-Filter (MIME-Typen, Doppel-Extensions) | ✅ |
| Quarantäne-Management mit Detail-Ansicht und MIME-Vorschau | ✅ |
| TLS (STARTTLS + Implicit TLS) auf allen Ports | ✅ |
| Integrierter HTTPS-Proxy (Port 443, Hot-Reload, BCP-Verwaltung) | ✅ |
| DNS-Hardening (trusted Resolver, Cross-Validation, Integrity-Check) | ✅ |
| eDiscovery & Legal Hold (Cross-Mailbox-Suche, MBOX-Export) | ✅ |
| Nachrichtenablaufverfolgung (Message Trace) mit CSV-Export | ✅ |
| SMTP Brute-Force-Schutz & Rate-Limiting | ✅ |

### Authentifizierung

| Feature | Status |
|---------|--------|
| Lokale Anmeldung (bcrypt + pepper) | ✅ |
| LDAP / Active Directory (BCP-Verwaltung, Attributzuordnung, Sync) | ✅ |
| SSO via OIDC / OAuth2 (Azure AD, Keycloak, Google, Authentik, Okta) | ✅ |
| SAML 2.0 | ✅ |
| MFA: TOTP (Authenticator-App) | ✅ |
| MFA: WebAuthn / FIDO2 (YubiKey, Touch ID) | ✅ |
| MFA: Backup-Codes | ✅ |
| App-Passwörter für Mail-Clients | ✅ |
| OAuth2 Authorization Server (Modern Auth) | ✅ |
| Passwort-Änderung im Webclient (MWA) | ✅ |

### Administration (BCP Admin-Panel)

| Feature | Status |
|---------|--------|
| RBAC mit 7 Rollen | ✅ |
| SMTP-Queue-Management (BullMQ-nativ, Retry, Dead Letter, Retention) | ✅ |
| DNS-Check in BCP SMTP-Konfiguration (MX, SPF, DKIM, DMARC, Autodiscover, PTR live) | ✅ |
| DNS-Einträge Tabellen-UI mit Statusampeln (grün/gelb) | ✅ |
| Nachrichtenablaufverfolgung (Message Trace) mit Filtern & CSV-Export | ✅ |
| Quarantäne-Verwaltung mit Detail-Slide-over und MIME-Vorschau | ✅ |
| SMTP-Infrastruktur-Konfiguration (ESMTP, Banner, Relay, Greylisting) | ✅ |
| SSL/TLS-Verwaltung (integrierter HTTPS-Proxy, Zertifikats-Upload) | ✅ |
| SSO-Provider-Verwaltung (OIDC/OAuth2, SAML, Schnellauswahl) | ✅ |
| LDAP/AD-Verbindungsverwaltung (Attributzuordnung, Verbindungstest, Sync) | ✅ |
| Rspamd-Integration (Schwellwerte, Bayes-Training, Modul-Übersicht) | ✅ |
| Audit-Log (alle Admin-Aktionen nachvollziehbar) | ✅ |
| Service-Konfiguration (live, kein Neustart nötig) | ✅ |
| Log-Viewer mit Log-Level pro Service | ✅ |
| Backup: MBOX/EML-Export (Self-Service pro Benutzer) | ✅ |
| Backup: Admin-Vollbackup zu S3 (Point-in-Time Recovery) | ✅ |
| Kubernetes Helm Chart (HPA, HA) | ✅ |
| Strukturierte JSON-Logs (pino) + Log-Level pro Service | ✅ |
| Web Push / VAPID-Benachrichtigungen | ✅ |
| Auto-Mailbox-Provisionierung beim ersten Login | ✅ |

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
| **Outlook 2021 LTSC** | IMAP oder Exchange (via EWS) | IMAP+SMTP oder EWS | Outlook-CalDav-Synchronizer |
| **Apple Mail** (Mac + iOS) | „Anderes Mail-Konto" → IMAP | IMAP+SMTP | Apple Kalender/Kontakte separat (CalDAV/CardDAV) |
| **Thunderbird** | IMAP-Konto | IMAP+SMTP | Lightning (CalDAV) + TbSync (CardDAV) |
| **eM Client** | IMAP-Konto | IMAP+SMTP | CalDAV+CardDAV nativ |
| **K-9 Mail** (Android) | IMAP-Konto | IMAP+SMTP | DAVx⁵ für CalDAV/CardDAV |
| **Browser** | — | **MWA** unter `https://<dein-host>/` | inkl. Kalender/Kontakte im Web |

### IMAP-Einstellungen

| Setting | Wert |
|---------|------|
| IMAP-Server | `mail.<deine-domain>` |
| IMAP-Port | **993** (implicit-TLS, empfohlen) oder **143** (STARTTLS) |
| SMTP-Server | `mail.<deine-domain>` |
| SMTP-Port | **465** (implicit-TLS) oder **587** (STARTTLS, empfohlen) |
| Authentifizierung | **PLAIN** oder **LOGIN** (SASL) |
| Username | `max@firma.de` (vollständige E-Mail-Adresse) |
| Passwort | Account-Passwort ODER **App-Passwort** (Pflicht bei aktivem MFA) |

### App-Passwörter (für MFA-Accounts)

Bei aktiviertem 2FA können Mail-Clients das normale Passwort nicht mehr verwenden — der MFA-Code lässt sich nicht via IMAP/SMTP übertragen. Lösung: **App-Passwort** pro Client erstellen.

1. Im MWA anmelden → Einstellungen → **Sicherheit** → „App-Passwörter"
2. „Neues App-Passwort" → Name eintippen (z.B. „Apple Mail Mac")
3. Generiertes 32-stelliges Passwort kopieren
4. Im Client als Passwort eintragen
5. Bei Verlust/Diebstahl: einzelnes App-Passwort widerrufen — andere bleiben gültig

### Hinweis zu Outlook 2024 LTSC

Outlook 2024 LTSC erzwingt **Modern Auth (OAuth2)** auf Exchange-Endpoints und akzeptiert nur Microsoft-Entra-ID als Identity-Provider. Für non-Microsoft-Server (wie CoreMail) ist die einzige praktikable Konfiguration **IMAP+SMTP** (über „Andere E-Mail-Konten"). MAPI/HTTP wurde aus diesem Grund in v5.4.0 aus CoreMail entfernt.

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

Das Skript erstellt die `.env`-Datei mit zufällig generierten Schlüsseln. Alternativ manuell:

```bash
cp .env.example .env
```

### 3. `.env` anpassen

```env
MAIL_HOSTNAME=mail.meinedomain.de    # Vollqualifizierter Hostname

POSTGRES_PASSWORD=sicheres-passwort
REDIS_PASSWORD=sicheres-passwort
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=sicheres-passwort

JWT_SECRET=<openssl rand -hex 32>
PEPPER=<openssl rand -hex 32>
```

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
| `coremail` | `magpeek/coremail-app:3.17.8` | Alle Mail-Dienste + Webmail + Admin-Panel |
| `rspamd` | `rspamd/rspamd:4.0.0` | Anti-Spam Engine (Bayes, DKIM/SPF/DMARC, Fuzzy) |
| `clamav` | `clamav/clamav:stable` | Open-Source Antivirus (GPL), freshclam Updates |
| `postgres` | `postgres:16-alpine` | Datenbank für Mails, Benutzer, Kalender |
| `redis` | `redis:7-alpine` | Sessions, SMTP-Queue (BullMQ), Live-Updates |
| `minio` | `minio/minio` | Objektspeicher für Anhänge, Quarantäne und Backups |

Der App-Container (`coremail`) enthält intern alle Mail-Dienste — SMTP, IMAP, POP3, EWS, ActiveSync, CalDAV, Webmail und Admin-Panel — verwaltet von `supervisord`. Nach außen sind Port 3000 (HTTP/API), Port 443 (HTTPS, optional) sowie die Mail-Ports (25, 465, 587, 143, 993, 110, 995) sichtbar.

### Die `docker-compose.yml`

Die vollständig kommentierte Datei liegt unter `infra/docker/docker-compose.yml`:

```yaml
# Auszug — vollständige Datei im Repository
services:
  coremail:
    image: magpeek/coremail-app:3.17.8
    ports:
      - "3000:3000"   # HTTP (API, Webmail, Admin-Panel, EWS, Autodiscover)
      - "443:443"     # HTTPS (integrierter TLS-Proxy, deaktivierbar via .env)
      - "25:25"       # SMTP eingehend
      - "465:465"     # SMTPS (Implizites TLS)
      - "587:587"     # SMTP Submission (STARTTLS)
      - "143:143"     # IMAP (STARTTLS)
      - "993:993"     # IMAPS (Implizites TLS)
      - "110:110"     # POP3
      - "995:995"     # POP3S
    environment:
      MAIL_HOSTNAME: mail.meinedomain.de
      RSPAMD_URL: http://rspamd:11334
      CLAMAV_HOST: clamav
      CLAMAV_PORT: "3310"
      # ... vollständige Liste in der docker-compose.yml
    depends_on:
      postgres: { condition: service_healthy }
      redis:    { condition: service_started }
      minio:    { condition: service_healthy }
      rspamd:   { condition: service_healthy }
      clamav:   { condition: service_healthy }

  rspamd:
    image: rspamd/rspamd:4.0.0

  clamav:
    image: clamav/clamav:stable
    environment:
      CLAMAV_NO_FRESHCLAMD: "false"

  postgres:
    image: postgres:16-alpine

  redis:
    image: redis:7-alpine

  minio:
    image: minio/minio:latest
    ports:
      - "9001:9001"   # MinIO Web-Konsole (nur lokal erreichbar!)
```

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
| `https://<MAIL_HOSTNAME>/EWS/Exchange.asmx` | EWS (Outlook Desktop) |
| `https://<MAIL_HOSTNAME>/Microsoft-Server-ActiveSync` | ActiveSync (iOS / Android / Outlook Mobile) |
| `https://<MAIL_HOSTNAME>/Autodiscover/Autodiscover.xml` | Autodiscover |
| `http://localhost:9001` | MinIO Web-Konsole (nur lokal) |

**Mail-Ports:**

| Port | Protokoll | Verschlüsselung |
|------|-----------|----------------|
| 25 | SMTP (eingehend) | STARTTLS |
| 465 | SMTPS (Submission) | Implizites TLS |
| 587 | SMTP Submission | STARTTLS |
| 143 | IMAP | STARTTLS |
| 993 | IMAPS | Implizites TLS |
| 110 | POP3 | STARTTLS |
| 995 | POP3S | Implizites TLS |

---

## Konfiguration

Alle Einstellungen erfolgen über die `.env`-Datei. Die vollständige Referenz:

```env
# ── Allgemein ──────────────────────────────────────────────
NODE_ENV=production           # development | production
LOG_LEVEL=info                # error | warn | info | debug

# ── Datenbank ──────────────────────────────────────────────
POSTGRES_PASSWORD=...

# ── Redis ──────────────────────────────────────────────────
REDIS_PASSWORD=...

# ── Objektspeicher (Anhänge, Quarantäne, Backup) ──────────
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=...

# ── Sicherheit ─────────────────────────────────────────────
JWT_SECRET=...                # mind. 32 Zeichen, zufällig
PEPPER=...                    # mind. 32 Zeichen, zufällig

# ── TLS ────────────────────────────────────────────────────
# HTTPS_PORT=443              # Alternativer Port falls 443 belegt

# ── Anti-Spam (Rspamd) ─────────────────────────────────────
RSPAMD_URL=http://rspamd:11334

# ── Antivirus (ClamAV) ─────────────────────────────────────
CLAMAV_HOST=clamav
CLAMAV_PORT=3310

# ── WebAuthn (MFA FIDO2) ───────────────────────────────────
WEBAUTHN_RP_NAME=CoreMail
WEBAUTHN_RP_ID=mail.domain.de
WEBAUTHN_ORIGIN=https://mail.domain.de

# ── GeoIP Country-Filter (optional) ───────────────────────
# Kostenlose Registrierung: https://www.maxmind.com/en/geolite2/signup
MAXMIND_ACCOUNT_ID=
MAXMIND_LICENSE_KEY=
```

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
docker pull magpeek/coremail-app:3.17.8
```

**Multi-Arch:** Das Image wird für `linux/amd64` und `linux/arm64` gebaut (Synology NAS, Raspberry Pi, Apple Silicon).

---

## Versionsverlauf

### v5.x — IMAP4rev2 + RFC-Compliance + MAPI-Cleanup

| Version | Highlights |
|---------|-----------|
| **v5.5.0** | **IMAP4rev2** (RFC 9051) compliance: STARTTLS + AUTHENTICATE SASL + UNSELECT + ID. Doku-Update für MAPI-Removal. OAuth2-Server bleibt für REST-API; XOAUTH2 für Mail-Protokolle **nicht** implementiert (keine Mainstream-Client-UI-Unterstützung für non-Microsoft-Server). |
| **v5.4.0** | **MAPI/HTTP komplett entfernt** (~12.000 LOC). Outlook 2024 LTSC erzwingt Microsoft-Entra-only-Modern-Auth, was für non-Microsoft-Server fundamental nicht funktioniert. Empfehlung: Outlook → „Andere E-Mail-Konten" → IMAP. Kalender/Kontakte via CalDAV/CardDAV. |
| **v5.3.5** | IMAP FETCH komplett rewritten: ENVELOPE-Bug fixed (NIL-Listen RFC 3501 §7.4.2), echte BODYSTRUCTURE statt BODY[TEXT], INTERNALDATE, BODY[]/BODY[HEADER]/BODY.PEEK[*]/RFC822-Varianten |
| **v5.3.1** | IMAP vollständige Command-Suite: CREATE, DELETE, RENAME, APPEND, COPY, UID COPY, MOVE, UID MOVE, SEARCH, UID SEARCH, CLOSE, CHECK. UID-Compound-Dispatcher-Bug fixed. POP3 App-Password + Byte-Stuffing fix. |
| **v5.2.19** | parseLine empty-quoted-string fix (`LIST "" "*"`) — Mac Mail/iOS Mail/Thunderbird konnten ihre Ordnerliste nie über LIST holen |
| **v5.2.18** | IMAP SPECIAL-USE + LSUB + NAMESPACE + STATUS für Mac Mail / iOS Mail |
| **v5.2.0** | (archiviert) MAPI/HTTP FINAL — siehe v5.4.0 für Removal-Begründung |

### v3.18.x — Feature-Polish & Production-Hardening

| Version | Highlights |
|---------|-----------|
| **v3.18.40** | Externe Clients & Outlook Setup-Page im OWA (vor MAPI/HTTP-Implementation: CalDav-Synchronizer-Anleitung) |
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
  <b>CoreMail v5.2.0</b> · Der OpenSource Mailserver für kleine und mittlere Umgebungen<br>
  <sub>IMAP4rev2 + SMTP + POP3 + EWS + CalDAV + CardDAV + ActiveSync</sub><br>
  <sub>Entwickelt mit ❤️ · <a href="https://github.com/MAGPEEK/CoreMail">github.com/MAGPEEK/CoreMail</a></sub>
</div>
