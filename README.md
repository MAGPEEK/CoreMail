# CoreMail

> **Coremail — der OpenSource Mailserver für kleine und mittlere Umgebungen.**  
> Aufgebaut auf React + Node.js/TypeScript, container-first, vollständig selbst gehostet.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22+-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue.svg)](https://www.typescriptlang.org)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED.svg)](https://www.docker.com)
[![Version](https://img.shields.io/badge/Version-3.17.8-brightgreen.svg)](https://github.com/MAGPEEK/CoreMail/releases)

📄 **[docker-compose.yml](infra/docker/docker-compose.yml)** — sofort einsatzbereit, einfach herunterladen und starten  
📋 **[COMMANDS.md](COMMANDS.md)** — Befehlsreferenz: Dienste prüfen, Benutzer anlegen, Queues, Logs, Backup  
📝 **[CHANGELOG.md](CHANGELOG.md)** — Vollständiger Versionsverlauf

**CoreMail** ist ein vollständiger, selbst gehosteter Mailserver für Klein- und Mittelunternehmen mit **10–500 Benutzern** — ohne Lizenzkosten, ohne Vendor Lock-in, mit voller Datensouveränität.

Outlook-Clients (Desktop und Mobil), iOS Mail, Android Mail und alle anderen IMAP/POP3/SMTP-Clients verbinden sich nativ. Kein VPN, kein Connector, keine Drittanbieter-Software.

> **Aktuelle Version: v3.17.8** — [Changelog](CHANGELOG.md) · [Releases](https://github.com/MAGPEEK/CoreMail/releases) · [Docker Hub](https://hub.docker.com/r/magpeek/coremail-app)

---

## Inhalt

1. [Features](#features)
2. [Schnellstart](#schnellstart)
3. [Docker Compose](#docker-compose)
4. [Zugriff](#zugriff)
5. [Konfiguration](#konfiguration)
6. [DNS-Einrichtung](#dns-einrichtung)
7. [TLS-Zertifikate](#tls-zertifikate)
8. [Befehlsreferenz](#befehlsreferenz)
9. [Docker Hub](#docker-hub)
10. [Versionsverlauf](#versionsverlauf)
11. [Lizenz](#lizenz)

---

## Features

### E-Mail

| Feature | Status |
|---------|--------|
| SMTP Inbound (Port 25, 465, 587) | ✅ |
| SMTP Outbound mit MX-Lookup & DKIM-Signierung | ✅ |
| IMAP4rev1 mit IDLE, CONDSTORE, ESEARCH | ✅ |
| POP3 (Port 110, 995) | ✅ |
| EWS — Outlook Desktop 2010–2024 (SOAP/XML) | ✅ |
| MAPI over HTTP — Outlook 2013+ native Transport | ✅ |
| Autodiscover v1 + v2 (automatische Outlook-Konfiguration) | ✅ |
| ActiveSync EAS 14.1 — iOS Mail, Android, Outlook Mobile | ✅ |
| MWA — Mail Web Access (React, Exchange-ähnliches Layout) | ✅ |
| RFC 822 Quelltext-Ansicht (Modal im MWA) | ✅ |
| Empfänger-Autocomplete im Compose (An/CC/BCC, Keyboard-Nav) | ✅ |
| Resizable Panels im MWA (Ordnerstruktur / Liste / Lesebereich) | ✅ |
| Freigegebene Postfächer mit voller Ordner-Struktur (Inbox, Sent, Trash, …) | ✅ |
| Shared Mailbox-Reader im MWA — „Weiteres Postfach öffnen" über Konto-Dropdown | ✅ |
| Folder-CRUD in Shared Mailboxes (Neuer Ordner, Umbenennen, Löschen, Standard-Folder geschützt) | ✅ |
| E-Mail-Aliase pro User-Postfach und Shared-Mailbox | ✅ |
| Öffentliche Ordner mit ACL (READ / WRITE / FULL) | ✅ |
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
`HTTPS_PROXY_ENABLED=false` in `.env` setzen und `"443:443"` in der `docker-compose.yml` auskommentieren.

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
# HTTPS_PROXY_ENABLED=true    # Standard: true (integrierter Proxy)
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

```env
# .env — Standard, kann weggelassen werden
HTTPS_PROXY_ENABLED=true
```

### Option B — Externer Reverse Proxy

Für Betrieb hinter Traefik, Caddy, nginx, DSM Application Portal o.ä.:

```env
# .env
HTTPS_PROXY_ENABLED=false
```

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

| Version | Highlights |
|---------|-----------|
| **v3.17.8** | Fix: Nachrichtenablaufverfolgung (MAIL_FLOW-Logging im SMTP-Server); RFC 822 Quelltext-Ansicht (Modal im MWA) |
| **v3.17.7** | DNS-Einträge Tabellen-UI in BCP SMTP (grün/gelb Statusampeln für alle Records) |
| **v3.17.6** | DNS-Reiter in BCP SMTP-Konfiguration — MX, SPF, DKIM, DMARC, Autodiscover, PTR live-check |
| **v3.17.5** | Fix: BullMQ Queue-Name `smtp:outbound` → `smtp-outbound` (BullMQ v5 verbietet Doppelpunkte) |
| **v3.17.0** | Integrierter HTTPS-Proxy (Port 443, Hot-Reload via Redis, BCP → SSL/TLS-Verwaltung) |
| **v3.16.6** | Empfänger-Autocomplete im Compose (RecipientInput, Keyboard-Nav, Multi-Empfänger); Resizable Panels; Ansicht-Einstellungen (Lesebereich, Dichte, Konversationen) |
| **v3.16.0** | DraggableCard BCP-Dashboard; Tiptap-Schriftarten (Arial, Calibri, Georgia, …); erweiterte Kontaktfelder (email2, mobile, department); erweiterte Mailsuche (Scope-Umschalter, Typeahead) |
| **v3.15.0** | DNS-Hardening: trusted Resolver (8.8.8.8/1.1.1.1/9.9.9.9), Cross-Validation, Startup-Integrity-Check |
| **v3.14.0** | Pentest-Fixes: SMTP Brute-Force-Schutz, Rate-Limiting, Fail2Ban-Integration, Firewall-Hardening |
| **v3.13.9** | Aufbewahrungsrichtlinien — 8 Vorlagen (1-Klick erstellt Tag + Policy + GLOBAL-Zuweisung) |
| **v3.13.8** | Shared Mailboxes mit voller Ordnerstruktur (INBOX/Drafts/Sent/…); Folder-CRUD im MWA |
| **v3.13.7** | Transportregeln aus Vorlagen — 9 Exchange-2019-typische Templates ([EXTERN]-Markierung, CEO-Phishing, PCI-DSS, …) |
| **v3.13.6** | Journaling-Feature komplett entfernt (−1.533 LOC) — DB-Tabellen `journaling_*` gedroppt |
| **v3.13.5** | E-Mail-Aliase pro User + Shared-Mailbox (XOR-Target, Adress-Kollisions-Check, SMTP-Resolution) |
| **v3.13.4** | „Weiteres Postfach öffnen" im MWA — Shared-Mailbox-Reader über Konto-Dropdown |
| **v3.13.0** | SMTP-Audit: 5 kritische Bugs gefixt (ESMTP-Flags, maxMessageSize, localDelivery, Greylisting); IANA-Zeitzonen; OWA → MWA Umbenennung |
| **v3.11.0** | Aufbewahrungsrichtlinien Exchange-2019: DPT/RPT/Personal-Tags + Managed Folder Assistant + Recoverable Items |
| **v3.10.0** | eDiscovery komplett: Empfänger-Filter, Anhang-Filter, De-Duplizierung, MBOX-Export (Streaming, 50k-Cap) |
| **v3.9.0** | BCP-Dashboard mit Server-Info (Uptime, RAM, CPU), konfigurierbare Widgets, Drag-Reorder |
| **v3.8.0** | Öffentliche Ordner mit ACL READ/WRITE/FULL |
| **v3.7.0** | DNSBL-Modul: Zonen + Aktionen + Score + IPv6 + Cache + Statistik |
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
  <b>CoreMail v3.17.8</b> · Der OpenSource Mailserver für kleine und mittlere Umgebungen<br>
  <sub>Entwickelt mit ❤️ · <a href="https://github.com/MAGPEEK/CoreMail">github.com/MAGPEEK/CoreMail</a></sub>
</div>
