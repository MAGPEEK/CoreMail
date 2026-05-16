# CoreMail

> **Coremail — der OpenSource Mailserver für kleine Umgebungen.**  
> Aufgebaut auf React + Node.js/TypeScript, container-first, vollständig selbst gehostet.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22+-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue.svg)](https://www.typescriptlang.org)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED.svg)](https://www.docker.com)
[![Version](https://img.shields.io/badge/Version-1.3.8-brightgreen.svg)](https://github.com/MAGPEEK/CoreMail/releases)

**CoreMail** ist ein vollständiger, selbst gehosteter Mailserver für Klein- und Mittelunternehmen mit **10–500 Benutzern** — ohne Lizenzkosten, ohne Vendor Lock-in, mit voller Datensouveränität.

Outlook-Clients (Desktop und Mobil), iOS Mail, Android Mail und alle anderen IMAP/POP3/SMTP-Clients verbinden sich nativ. Kein VPN, kein Connector, keine Drittanbieter-Software.

> **Aktuelle Version: v1.3.8** — [Changelog](CHANGELOG.md) · [Releases](https://github.com/MAGPEEK/CoreMail/releases) · [Docker Hub](https://hub.docker.com/u/magpeek)

---

## Inhalt

1. [Features](#features)
2. [Schnellstart](#schnellstart)
3. [Zugriff](#zugriff)
4. [Konfiguration](#konfiguration)
5. [DNS-Einrichtung](#dns-einrichtung)
6. [TLS-Zertifikate](#tls-zertifikate)
7. [Docker Hub](#docker-hub)
8. [Lizenz](#lizenz)

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
| OWA — Webmail (React, Exchange-ähnliches Layout) | ✅ |
| Freigegebene Postfächer (Shared Mailboxen) | ✅ |
| Öffentliche Ordner mit Berechtigungsverwaltung | ✅ |
| Verteilergruppen (statisch & dynamisch via LDAP-Filter) | ✅ |
| Raum- und Gerätepostfächer mit Auto-Accept | ✅ |
| Abwesenheitsassistent | ✅ |
| Posteingangsregeln & Transportregeln | ✅ |
| Volltextsuche (< 200 ms, PostgreSQL GIN-Index) | ✅ |
| S/MIME — Signierung, Verschlüsselung, Verifikation | ✅ |
| SMTP-Gateway-Modus (Relay zu Upstream-MTA) | ✅ |
| Journaling-Regeln (RFC 3462) | ✅ |
| Aufbewahrungsrichtlinien (ARCHIVE / DELETE / MOVE) | ✅ |
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
| ClamAV Antivirus | ✅ |
| rspamd Anti-Spam (Bayes, selbstlernend) | ✅ |
| Adress-Blacklist (Global / Domain / Benutzer) | ✅ |
| Attachment-Filter (MIME-Typen, Doppel-Extensions) | ✅ |
| Quarantäne-Management im Admin-Panel | ✅ |
| TLS (STARTTLS + Implicit TLS) auf allen Ports | ✅ |
| eDiscovery & Legal Hold (Cross-Mailbox-Suche) | ✅ |

### Authentifizierung

| Feature | Status |
|---------|--------|
| Lokale Anmeldung (bcrypt + pepper) | ✅ |
| LDAP / Active Directory | ✅ |
| SSO via OIDC / OAuth2 (Azure AD, Keycloak, Google, Authentik, Okta) | ✅ |
| SAML 2.0 | ✅ |
| MFA: TOTP (Authenticator-App) | ✅ |
| MFA: WebAuthn / FIDO2 (YubiKey, Touch ID) | ✅ |
| MFA: Backup-Codes | ✅ |
| App-Passwörter für Mail-Clients | ✅ |
| OAuth2 Authorization Server (Modern Auth) | ✅ |

### Administration (ECP Admin-Panel)

| Feature | Status |
|---------|--------|
| RBAC mit 7 Rollen | ✅ |
| SMTP Queue-Monitor mit Mail-Details (Absender / Empfänger) | ✅ |
| Audit-Log (alle Admin-Aktionen nachvollziehbar) | ✅ |
| Service-Konfiguration (live, kein Neustart nötig) | ✅ |
| Log-Viewer mit Log-Level pro Service | ✅ |
| Backup: MBOX/EML-Export (Self-Service pro Benutzer) | ✅ |
| Backup: Admin-Vollbackup zu S3 (Point-in-Time Recovery) | ✅ |
| Kubernetes Helm Chart (HPA, HA) | ✅ |
| OpenTelemetry + Prometheus + Grafana + Loki + Tempo | ✅ |
| Web Push / VAPID-Benachrichtigungen | ✅ |
| Auto-Mailbox-Provisionierung beim ersten Login | ✅ |

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

Beim ersten Aufruf von `https://<MAIL_HOSTNAME>/ecp/` erscheint automatisch der Setup-Assistent zum Anlegen des ersten Admin-Accounts.

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

## Zugriff

| URL | Beschreibung |
|-----|-------------|
| `https://<MAIL_HOSTNAME>/owa/` | Webmail (OWA) |
| `https://<MAIL_HOSTNAME>/ecp/` | Admin-Panel |
| `https://<MAIL_HOSTNAME>/EWS/Exchange.asmx` | EWS (Outlook Desktop) |
| `https://<MAIL_HOSTNAME>/Microsoft-Server-ActiveSync` | ActiveSync (iOS / Android / Outlook Mobile) |
| `https://<MAIL_HOSTNAME>/Autodiscover/Autodiscover.xml` | Autodiscover |
| `http://localhost:9001` | MinIO Web-Konsole |
| `http://localhost:3001` | Grafana *(Observability-Profil)* |

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

# ── Objektspeicher (Anhänge) ───────────────────────────────
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=...

# ── Sicherheit ─────────────────────────────────────────────
JWT_SECRET=...                # mind. 32 Zeichen, zufällig
PEPPER=...                    # mind. 32 Zeichen, zufällig

# ── WebAuthn (MFA FIDO2) ───────────────────────────────────
WEBAUTHN_RP_NAME=CoreMail
WEBAUTHN_RP_ID=mail.domain.de
WEBAUTHN_ORIGIN=https://mail.domain.de

# ── GeoIP Country-Filter (optional) ───────────────────────
# Kostenlose Registrierung: https://www.maxmind.com/en/geolite2/signup
MAXMIND_ACCOUNT_ID=
MAXMIND_LICENSE_KEY=
```

### Observability aktivieren

```bash
docker compose -f infra/docker/docker-compose.yml \
  --profile observability up -d
```

Startet zusätzlich: Prometheus, Grafana, Tempo, Loki, Alertmanager, OTEL Collector.

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

; DKIM (Public Key aus dem ECP Admin-Panel kopieren)
coremail._domainkey.domain.de. TXT "v=DKIM1; k=rsa; p=<public-key>"

; DMARC
_dmarc.domain.de.         TXT   "v=DMARC1; p=reject; rua=mailto:dmarc@domain.de"

; Autodiscover SRV (für ältere Outlook-Versionen)
_autodiscover._tcp.domain.de. SRV 0 0 443 mail.domain.de.
```

Den DKIM-Public-Key findet man im ECP unter **Domains → Domain auswählen → DKIM**.

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

## Docker Hub

CoreMail besteht aus **einem einzigen Custom-Image** — alle Services in einem Container, verwaltet von `supervisord`.

| Image | Inhalt |
|-------|--------|
| [`magpeek/coremail-app`](https://hub.docker.com/r/magpeek/coremail-app) | Alle Services + OWA/ECP-Frontends |

Datenbank (PostgreSQL, Redis, MinIO) läuft in Standard-Docker-Images — kein eigenes Image notwendig.

```bash
# Neueste Version ziehen und starten
docker compose -f infra/docker/docker-compose.yml up -d

# Bestimmte Version
docker pull magpeek/coremail-app:1.3.8
```

**Multi-Arch:** Das Image wird für `linux/amd64` und `linux/arm64` gebaut (Synology NAS, Raspberry Pi, Apple Silicon).

---

## Mitwirken

Beiträge sind herzlich willkommen!

```bash
git checkout -b feature/mein-feature
# Änderungen vornehmen
pnpm typecheck
git push origin feature/mein-feature
# Pull Request öffnen
```

---

## Lizenz

MIT License — siehe [LICENSE](LICENSE)

---

<div align="center">
  <b>CoreMail</b> · Der OpenSource Mailserver für kleine Umgebungen<br>
  <sub>Entwickelt mit ❤️ · <a href="https://github.com/MAGPEEK/CoreMail">github.com/MAGPEEK/CoreMail</a></sub>
</div>
