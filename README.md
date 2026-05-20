# CoreMail

> **Coremail — der OpenSource Mailserver für kleine und mittlere Umgebungen.**  
> Aufgebaut auf React + Node.js/TypeScript, container-first, vollständig selbst gehostet.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22+-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue.svg)](https://www.typescriptlang.org)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED.svg)](https://www.docker.com)
[![Version](https://img.shields.io/badge/Version-3.13.9-brightgreen.svg)](https://github.com/MAGPEEK/CoreMail/releases)

📄 **[docker-compose.yml](infra/docker/docker-compose.yml)** — sofort einsatzbereit, einfach herunterladen und starten  
📋 **[COMMANDS.md](COMMANDS.md)** — Befehlsreferenz: Dienste prüfen, Benutzer anlegen, Queues, Logs, Backup  
📝 **[CHANGELOG.md](CHANGELOG.md)** — Vollständiger Versionsverlauf

**CoreMail** ist ein vollständiger, selbst gehosteter Mailserver für Klein- und Mittelunternehmen mit **10–500 Benutzern** — ohne Lizenzkosten, ohne Vendor Lock-in, mit voller Datensouveränität.

Outlook-Clients (Desktop und Mobil), iOS Mail, Android Mail und alle anderen IMAP/POP3/SMTP-Clients verbinden sich nativ. Kein VPN, kein Connector, keine Drittanbieter-Software.

> **Aktuelle Version: v3.13.9** — [Changelog](CHANGELOG.md) · [Releases](https://github.com/MAGPEEK/CoreMail/releases) · [Docker Hub](https://hub.docker.com/r/magpeek/coremail-app)

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
10. [Lizenz](#lizenz)

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
| eDiscovery & Legal Hold (Cross-Mailbox-Suche) | ✅ |

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
| Quarantäne-Verwaltung mit Detail-Slide-over und MIME-Vorschau | ✅ |
| SMTP-Infrastruktur-Konfiguration (ESMTP, Banner, Relay, Greylisting) | ✅ |
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

Das Skript erstellt die `.env`-Datei und generiert selbstsignierte TLS-Zertifikate für die lokale Entwicklung. Alternativ manuell:

```bash
cp .env.example .env
bash scripts/gen-dev-certs.sh
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

### 4. Stack starten

```bash
docker compose -f infra/docker/docker-compose.yml up -d
```

Nach ca. 60–90 Sekunden sind alle Services bereit.

### 5. Ersten Admin-Account anlegen

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

CoreMail besteht aus **sechs Containern** (drei Standard-Images, drei Custom/Extern):

| Container | Image | Aufgabe |
|-----------|-------|---------|
| `coremail` | `magpeek/coremail-app:3.13.9` | Alle Mail-Dienste + Webmail + Admin-Panel |
| `rspamd` | `rspamd/rspamd:4.0.0` | Anti-Spam Engine (Bayes, DKIM/SPF/DMARC, Fuzzy) |
| `clamav` | `clamav/clamav:stable` | Open-Source Antivirus (GPL), freshclam Updates |
| `postgres` | `postgres:16-alpine` | Datenbank für Mails, Benutzer, Kalender |
| `redis` | `redis:7-alpine` | Sessions, SMTP-Queue (BullMQ), Live-Updates |
| `minio` | `minio/minio` | Objektspeicher für Anhänge, Quarantäne und Backups |

Der App-Container (`coremail`) enthält intern alle Mail-Dienste — SMTP, IMAP, POP3, EWS, ActiveSync, CalDAV, Webmail und Admin-Panel — verwaltet von `supervisord`. Nach außen ist nur ein einziger HTTP-Port (3000) und die Mail-Ports (25, 465, 587, 143, 993, 110, 995) sichtbar.

### Die `docker-compose.yml`

Die vollständig kommentierte Datei liegt unter `infra/docker/docker-compose.yml`:

```yaml
# Auszug — vollständige Datei im Repository
services:
  coremail:
    image: magpeek/coremail-app:3.13.9
    ports:
      - "3000:3000"   # Webmail, Admin-Panel, API, EWS, Autodiscover
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
      - "9001:9001"   # MinIO Web-Konsole
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
| `https://<MAIL_HOSTNAME>/` | Webmail (MWA — Mail Web Access, seit v3.5.5 direkt unter Root) |
| `https://<MAIL_HOSTNAME>/bcp/` | Admin-Panel (BCP — Backend Control Panel, seit v3.2.3 umbenannt) |
| `https://<MAIL_HOSTNAME>/EWS/Exchange.asmx` | EWS (Outlook Desktop) |
| `https://<MAIL_HOSTNAME>/Microsoft-Server-ActiveSync` | ActiveSync (iOS / Android / Outlook Mobile) |
| `https://<MAIL_HOSTNAME>/Autodiscover/Autodiscover.xml` | Autodiscover |
| `http://localhost:9001` | MinIO Web-Konsole |

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
MAIL_HOSTNAME=mail.domain.de  # Vollqualifizierter Hostname
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

---

## TLS-Zertifikate

Für die Produktion echte Zertifikate unter `infra/docker/nginx/certs/` ablegen:

```
infra/docker/nginx/certs/
├── fullchain.pem   ← Zertifikat + Zwischenzertifikate
└── privkey.pem     ← Privater Schlüssel
```

**Let's Encrypt mit Certbot:**

```bash
certbot certonly --standalone -d mail.meinedomain.de

cp /etc/letsencrypt/live/mail.meinedomain.de/fullchain.pem \
   infra/docker/nginx/certs/fullchain.pem
cp /etc/letsencrypt/live/mail.meinedomain.de/privkey.pem \
   infra/docker/nginx/certs/privkey.pem
```

Für automatische Erneuerung einen Cron-Job mit `certbot renew` und anschließendem `docker compose restart` einrichten.

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
docker pull magpeek/coremail-app:3.13.9
```

**Multi-Arch:** Das Image wird für `linux/amd64` und `linux/arm64` gebaut (Synology NAS, Raspberry Pi, Apple Silicon).

---

## Versionsverlauf

| Version | Highlights |
|---------|-----------|
| **v3.13.9** | Aufbewahrungsrichtlinien — 8 Vorlagen (1-Klick erstellt Tag + Policy + GLOBAL-Zuweisung); MFA-jetzt/Historie-Buttons aus Hauptansicht entfernt |
| **v3.13.8** | Shared Mailboxes mit voller Ordnerstruktur (INBOX/Drafts/Sent/…); Folder-CRUD im OWA (Neuer Ordner, Umbenennen, Löschen) — Standard-Folder geschützt |
| **v3.13.7** | Transportregeln aus Vorlagen — 9 Exchange-2019-typische Templates ([EXTERN]-Markierung, CEO-Phishing, PCI-DSS, …) |
| **v3.13.6** | Journaling-Feature komplett entfernt (−1 533 LOC) — DB-Tabellen `journaling_*` gedroppt |
| **v3.13.5** | E-Mail-Aliase pro User + Shared-Mailbox (XOR-Target, Adress-Kollisions-Check, SMTP-Resolution) |
| **v3.13.4** | „Weiteres Postfach öffnen" im MWA — Shared-Mailbox-Reader (3-Spalten Read-Only) über Konto-Dropdown |
| **v3.13.3** | Drag&Drop-Reparatur (React-Anti-Pattern); Shared-Mailbox-Permissions-UX |
| **v3.13.1–.2** | KPI-Drag-Reorder direkt auf den Karten; Info-Page schlanker (Top-3 Changelogs) |
| **v3.13.0** | SMTP-Audit: 5 kritische Bugs gefixt (ESMTP-Flags aus DB, maxMessageSize, localDelivery, Greylisting); IANA-Zeitzonen; OWA→MWA |
| **v3.12.0** | Journaling Exchange-2019-konform (BCC-Auflösung, .eml-Attachment, Retry, Hold) — *entfernt in 3.13.6* |
| **v3.11.0** | Aufbewahrungsrichtlinien Exchange-2019: DPT/RPT/Personal-Tags + Managed Folder Assistant + Recoverable Items |
| **v3.10.0** | eDiscovery komplett: Empfänger-Filter, Anhang-Filter, De-Duplizierung, MBOX-Export |
| **v3.9.0** | Übersicht mit Server-Info (Uptime, RAM, CPU), konfigurierbare Widgets, Drag-Reorder im Popover |
| **v3.8.0** | Öffentliche Ordner Crash-Fix + ACL READ/WRITE/FULL |
| **v3.7.9** | Admin-Panel-Audit: Pfad-Doppel-Prefix-Bug + Exchange-2019-Mailbox-Permissions |
| **v3.7.0** | DNSBL-Modul: Zonen + Aktionen + Score + IPv6 + Cache + Statistik |
| **v3.5.5** | OWA jetzt direkt unter `/` (statt `/owa/`) — Login wieder erreichbar, umbenannt zu MWA |
| **v3.2.3** | UI-Strings ECP → BCP umbenannt |
| **v2.1.30** | Listener-Reload bei DELETE/PUT/POST; neuer „Standards"-Button stellt Default-Ports sofort wieder her |
| **v2.1.29** | Port-Toggle Root-Cause-Fix: Startup liest DB-Zustand statt Ports hardcodiert zu öffnen |
| **v2.1.28** | Postfach anlegen: Domain-Dropdown zeigt nur aktive Domains |
| **v2.1.27** | SMTP/IMAP/POP3 Port-Toggle zuverlässig: simultanes close + closeAllConnections, Map-Mutation-Fix, 3-s-Timeout |
| **v2.1.26** | bcryptjs statischer Import (ESM/CJS-Interop-Fix); smtp-server Property `.server` statt `._server` |
| **v2.1.25** | bcrypt → bcryptjs (pure JS, kein native build); Port-Toggle mit closeAllConnections() |
| **v2.1.24** | Postfach-Erstellung try/catch-Fix; Services Port-Toggle via Redis pub/sub |
| **v2.1.23** | BCP Server-Seite bereinigt (Mail-Protokoll-Felder und doppelter Org-Name entfernt) |
| **v2.1.22** | ECP Theme-Unabhängigkeit (immer Microsoft-Blau); MFA TOTP für OWA (QR-Code, Backup-Codes) |
| **v2.1.21** | ECP TopBar: angemeldeter User + Avatar-Dropdown + Theme-Toggle (System/Hell/Dunkel) |
| **v2.1.20** | Toggle-Fix (Knob + Dark-Mode); Dark Mode im ECP; Navigation SMTP & Routing |
| **v2.1.19** | Grafana + Prometheus aus Stack entfernt; Synology-Compose um rspamd + clamav ergänzt |
| **v2.0.19** | OWA: Passwort ändern (Stärkemeter), Design Hell/Dunkel/System + 6 Akzentfarben |
| **v1.9.19** | SSO-Verwaltung (OIDC/OAuth2, SAML), LDAP/AD-Verwaltung (Attributzuordnung, Sync, Verbindungstest) |
| **v1.8.19** | Message Queue Management: BullMQ-native API, Dead Letter, Retry, Retention-Einstellungen |
| **v1.7.19** | Quarantäne Detail-View mit MIME-Vorschau, Bulk-Selektion, CleanupModal |
| **v1.6.19** | SMTP-Infrastruktur-Konfiguration: ESMTP, Banner, Relay, Greylisting, Verbindungslimits |
| **v1.5.19** | Rspamd 4.0 + ClamAV als separate Container, vollständige Schutzfilter-ECP-Seite |
| **v1.4.19** | OWA-Signaturen (Tiptap), Abwesenheitsassistent, Speicherübersicht |

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
  <b>CoreMail v3.13.9</b> · Der OpenSource Mailserver für kleine und mittlere Umgebungen<br>
  <sub>Entwickelt mit ❤️ · <a href="https://github.com/MAGPEEK/CoreMail">github.com/MAGPEEK/CoreMail</a></sub>
</div>
