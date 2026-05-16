# CoreMail

> Coremail der OpenSource Mailserver für kleine Umgebungen — aufgebaut auf **React + Node.js/TypeScript**, container-first, modular und vollständig selbst gehostet.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22+-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue.svg)](https://www.typescriptlang.org)
[![pnpm](https://img.shields.io/badge/pnpm-workspace-orange.svg)](https://pnpm.io)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED.svg)](https://www.docker.com)

---

## Inhaltsverzeichnis

1. [Über das Projekt](#über-das-projekt)
2. [Feature-Übersicht](#feature-übersicht)
3. [Architektur](#architektur)
4. [Voraussetzungen](#voraussetzungen)
5. [Schnellstart](#schnellstart)
6. [Docker Compose — Betrieb](#docker-compose--betrieb)
7. [Zugriff nach dem Start](#zugriff-nach-dem-start)
8. [TLS-Zertifikate (Produktion)](#tls-zertifikate-produktion)
9. [Erster Admin-Account](#erster-admin-account)
10. [Docker Hub Images](#docker-hub-images)
11. [Konfiguration](#konfiguration)
12. [Module im Detail](#module-im-detail)
13. [Mail-Protokolle](#mail-protokolle)
14. [Sicherheit & Anti-Spam](#sicherheit--anti-spam)
15. [Authentifizierung](#authentifizierung)
16. [Weboberfläche (OWA)](#weboberfläche-owa)
17. [Admin-Panel (ECP)](#admin-panel-ecp)
18. [Backup & Wiederherstellung](#backup--wiederherstellung)
19. [Cluster & Hochverfügbarkeit](#cluster--hochverfügbarkeit)
20. [Monitoring & Logs](#monitoring--logs)
21. [Entwicklung](#entwicklung)
22. [Deployment (Docker)](#deployment-docker)
23. [Deployment (Kubernetes)](#deployment-kubernetes)
23. [URL-Struktur](#url-struktur)
24. [Roadmap](#roadmap)
25. [Lizenz](#lizenz)

> **Aktuelle Version: v0.11.0** — [Changelog ansehen](CHANGELOG.md) · [Alle Releases](https://github.com/MAGPEEK/CoreMail/releases)

---

## Über das Projekt

**CoreMail** bietet vollständige funktionale Parität mit Coremail der OpenSource Mailserver für kleine Umgebungen in den Bereichen **E-Mail, Kalender und Zusammenarbeit** — ohne Lizenzkosten, ohne Vendor Lock-in, mit voller Datensouveränität.

Das Projekt ist für Klein- und Mittelunternehmen mit **10–500 Benutzern** ausgelegt und kann sowohl als einzelner Docker-Stack als auch als hochverfügbares Kubernetes-Cluster betrieben werden.

### Warum CoreMail?

| Kriterium | Coremail der OpenSource Mailserver für kleine Umgebungen | CoreMail |
|-----------|------------------------|---------|
| Lizenzkosten | Hoch (CAL-Modell) | Kostenlos (MIT) |
| Datensouveränität | Microsoft-Infrastruktur | Vollständig selbst gehostet |
| Outlook-Kompatibilität | Nativ | EWS + Autodiscover |
| Quellcode-Transparenz | Geschlossen | Open Source |
| Clustering | Windows-Cluster | Kubernetes / Docker Swarm |
| Anpassbarkeit | Begrenzt | Vollständig modular |

---

## Feature-Übersicht

### E-Mail

| Feature | Status |
|---------|--------|
| SMTP Inbound (Port 25, 465, 587) | ✅ Implementiert |
| SMTP Outbound mit MX-Lookup & DKIM-Signierung | ✅ Implementiert |
| IMAP4rev1 mit IDLE, CONDSTORE, ESEARCH | ✅ Implementiert |
| POP3 (Port 110, 995) | ✅ Implementiert |
| EWS — EWS Web Services (Outlook Desktop) | ✅ Implementiert |
| Autodiscover v1 + v2 (Outlook-Autokonfiguration) | ✅ Implementiert |
| **ActiveSync EAS 14.1 (iOS, Android, Outlook Mobile)** | ✅ Implementiert |
| OWA — Outlook Web Access (Webmail) | ✅ Implementiert |
| Freigegebene Postfächer (Shared Mailboxen) | ✅ Implementiert |
| **Öffentliche Ordner (Public Folders)** | ✅ Implementiert |
| **Verteilergruppen & dynamische Gruppen** | ✅ Implementiert |
| **Raum- und Gerätepostfächer (auto-accept)** | ✅ Implementiert |
| Abwesenheitsassistent (Out of Office) | ✅ Implementiert |
| Posteingangsregeln (Transport Rules) | ✅ Implementiert |
| Volltextsuche (PostgreSQL GIN-Index, < 200 ms) | ✅ Implementiert |
| **eDiscovery & Legal Hold (Cross-Mailbox-Suche)** | ✅ Implementiert |
| **PowerShell-Remoting (EMS mit 20+ Cmdlets)** | ✅ Implementiert |
| **MAPI over HTTP (Outlook 2013+ Native Transport)** | ✅ Implementiert |
| **S/MIME Inline (Signierung, Verschlüsselung, Verifikation)** | ✅ **Neu in v0.10.0** |
| **Journaling-Regeln (RFC 3462)** | ✅ **Neu in v0.10.0** |
| **Aufbewahrungsrichtlinien (ARCHIVE/DELETE/MOVE)** | ✅ **Neu in v0.10.0** |
| **Outlook Modern Auth (OAuth2 / PKCE)** | ✅ **Neu in v0.11.0** |
| **SMTP-Gateway-Modus (Relay zu Upstream-MTA)** | ✅ **Neu in v0.11.0** |

### Kalender & Zusammenarbeit

| Feature | Status |
|---------|--------|
| Persönlicher Kalender | ✅ Implementiert |
| Geteilte Teamkalender | ✅ Implementiert |
| Besprechungsanfragen (iCal-Standard) | ✅ Implementiert |
| Frei/Gebucht-Abfrage (GetUserAvailability) | ✅ Implementiert |
| **Raum- und Ressourcenbuchung (auto-accept)** | ✅ **Neu in v0.8.0** |
| CalDAV (iOS, Android, Thunderbird) | ✅ Implementiert |
| Kontakte (CardDAV) | ✅ Implementiert |
| Aufgaben / To-Do (EWS-sync) | ✅ Implementiert |
| Notizen | ✅ Implementiert |
| Globale Adressliste (GAL) | ✅ Implementiert |

### Sicherheit

| Feature | Status |
|---------|--------|
| SPF / DKIM / DMARC / ARC-Validierung | ✅ Implementiert |
| DKIM-Signierung ausgehender E-Mails | ✅ Implementiert |
| DNSBL (Spamhaus ZEN, SpamCop, konfigurierbar) | ✅ Implementiert |
| Greylisting (Redis, Auto-Whitelist) | ✅ Implementiert |
| Country-Filtering (MaxMind GeoIP) | ✅ Implementiert |
| ClamAV Antivirus | ✅ Implementiert |
| rspamd Anti-Spam (Bayes, lernfähig) | ✅ Implementiert |
| Adress-Blacklist (Global / Domain / User) | ✅ Implementiert |
| Attachment-Filter (MIME, Doppel-Extension) | ✅ Implementiert |
| Quarantäne-Management | ✅ Implementiert |
| **S/MIME — Zertifikat-Verwaltung (Signierung & Verschlüsselung)** | ✅ **Neu in v0.7.0** |
| TLS (STARTTLS + Implicit TLS) | ✅ Implementiert |

### Authentifizierung

| Feature | Status |
|---------|--------|
| Lokale Anmeldung (bcrypt + pepper) | ✅ Implementiert |
| LDAP / Active Directory | ✅ Implementiert |
| SSO via OIDC / OAuth2 (Azure AD, Keycloak, Google, Authentik, Okta) | ✅ Implementiert |
| SAML 2.0 | ✅ Implementiert |
| MFA: TOTP (Authenticator-App) | ✅ Implementiert |
| MFA: WebAuthn / FIDO2 (YubiKey, Touch ID) | ✅ Implementiert |
| MFA: Backup-Codes (10 Einmal-Codes, bcrypt-gehasht) | ✅ Implementiert |
| App-Passwörter für Mail-Clients | ✅ Implementiert |
| Session-Management (User + Admin) | ✅ Implementiert |
| **OAuth2 Authorization Server (Modern Auth)** | ✅ **Neu in v0.11.0** |

### Administration

| Feature | Status |
|---------|--------|
| ECP Admin-Panel (Coremail Admin-Panel (ECP)) | ✅ Implementiert |
| RBAC (7 Rollen, Coremail-kompatibel) | ✅ Implementiert |
| SMTP Queue-Monitor (live) | ✅ Implementiert |
| Service-Konfiguration (live, kein Neustart) | ✅ Implementiert |
| Log-Viewer mit Log-Level pro Service | ✅ Implementiert |
| Backup: User-MBOX/EML-Export (Self-Service) | ✅ Implementiert |
| Backup: Admin-Vollbackup zu S3 (PITR) | ✅ Implementiert |
| Kubernetes Helm Chart (HPA, HA) | ✅ Implementiert |
| OpenTelemetry + Prometheus + Grafana + Loki + Tempo | ✅ Implementiert |
| **Audit-Log (alle Admin-Aktionen nachvollziehbar)** | ✅ **Neu in v0.11.0** |
| **Web Push / VAPID-Benachrichtigungen** | ✅ **Neu in v0.11.0** |
| **Auto-Mailbox-Provisionierung beim ersten Login** | ✅ **Neu in v0.11.0** |

---

## Architektur

CoreMail verwendet eine **2-Container-Architektur** — alle Node.js-Services und das Frontend laufen in einem einzigen App-Container, verwaltet von `supervisord`. Kein Kubernetes erforderlich; zwei `docker compose up`-Befehle genügen.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    magpeek/coremail-app:0.9.0                                    │
│                                                                                  │
│  nginx (80/443)  ←── TLS-Termination + URL-Routing + Static Files      │
│      │                                                                            │
│      ├── /owa/      → /app/www/owa/   (React OWA, statisch)                    │
│      ├── /ecp/      → /app/www/ecp/   (React ECP, statisch)                    │
│      ├── /api/      → api-gateway     :3000                                      │
│      ├── /auth/     → auth-service    :3003                                      │
│      ├── /EWS/      → ews-server      :8080  (SOAP + MAPI over HTTP)           │
│      ├── /Autodiscover/ → autodiscover :8081                                    │
│      ├── /dav/      → caldav-server   :8082                                      │
│      └── /Microsoft-Server-ActiveSync → activesync :3005                        │
│                                                                                  │
│  supervisord verwaltet alle Prozesse:                                             │
│  smtp-server · imap-server · pop3-server · security-filter · backup-service      │
│  storage-api · auth-service · api-gateway · ews-server · autodiscover            │
│  caldav-server · activesync · nginx                                               │
│                                                                                  │
│  SMTP(:25/465/587)    IMAP(:143/993)    POP3(:110/995)                          │
└─────────────────────────────────────────────────────────────────────────────────┘
                               ▲
                      DATABASE_URL / REDIS_URL
                               │
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    magpeek/coremail-db:0.9.0                                     │
│                                                                                  │
│  PostgreSQL 16 (:5432)  +  Redis 7 (:6379)  +  MinIO (:9000/:9001)             │
│                                                                                  │
│  supervisord verwaltet alle drei Datenbank-Prozesse                              │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Inter-Service-Kommunikation

```
smtp-server  ──REST──▶  security-filter  ──TCP──▶  ClamAV
smtp-server  ──REST──▶  security-filter  ──HTTP──▶  rspamd
smtp-server  ──REST──▶  storage-api      ──ORM──▶  PostgreSQL
smtp-server  ──S3 API──▶ MinIO           (Anhänge > 256 KB)
smtp-server  ──Pub/Sub──▶ Redis ◀────────────────  imap-server (IDLE)
api-gateway  ──REST──▶  ews-server
api-gateway  ──SSE──▶   web-client       (Live-Updates)
```

### Datenspeicherung

| Daten | Speicher | Begründung |
|-------|----------|-----------|
| User, Domains, Mails (Metadaten) | PostgreSQL 16 | ACID, Volltextsuche (tsvector/GIN) |
| Mail-Rohdaten > 256 KB | MinIO (S3-kompatibel) | Skalierbar, kostengünstig |
| Anhänge | MinIO | Deduplizierung via SHA-256 |
| Sessions, Greylisting, Queues | Redis 7 | Schneller In-Memory-Zugriff |
| Mail-Outbound-Queue | BullMQ (Redis) | Retries, Dead-Letter, Monitoring |
| Quarantäne | MinIO + PostgreSQL | Rohdaten in MinIO, Metadaten in DB |

---

## Voraussetzungen

| Anforderung | Mindest-Version | Empfohlen |
|-------------|----------------|-----------|
| Node.js | 20 LTS | 22 LTS |
| pnpm | 9.0 | aktuell |
| Docker | 24.0 | aktuell |
| Docker Compose | 2.20 | aktuell |
| RAM (Entwicklung) | 4 GB | 8 GB |
| RAM (Produktion, 50 User) | 8 GB | 16 GB |
| Festplatte | 20 GB | je nach Mailvolumen |

---

## Schnellstart

> **Voraussetzung:** Docker ≥ 24 und Docker Compose ≥ 2.20 müssen installiert sein.
> Node.js / pnpm sind für den reinen Docker-Betrieb **nicht** erforderlich.

### 1. Repository klonen

```bash
git clone https://github.com/MAGPEEK/CoreMail.git
cd CoreMail
```

### 2. Ersteinrichtung (automatisch)

Das mitgelieferte Setup-Skript erstellt die `.env`-Datei und generiert
selbstsignierte TLS-Zertifikate für die lokale Entwicklung:

```bash
bash scripts/setup.sh
```

Alternativ manuell:

```bash
cp .env.example .env
bash scripts/gen-dev-certs.sh   # Entwicklungs-Zertifikate (selbstsigniert)
```

### 3. `.env` anpassen

Öffne `.env` und setze mindestens diese Werte:

```env
# Vollständiger Hostname des Mailservers (FQDN)
MAIL_HOSTNAME=mail.meinedomain.de

# Datenbank
POSTGRES_PASSWORD=sicheres-postgres-passwort

# Redis
REDIS_PASSWORD=sicheres-redis-passwort

# MinIO (Objektspeicher)
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=sicheres-minio-passwort

# JWT & Passwort-Hashing — mind. 64 Zeichen, zufällig
JWT_SECRET=$(openssl rand -hex 32)
PEPPER=$(openssl rand -hex 32)
```

Secrets direkt in der Shell generieren:
```bash
openssl rand -hex 32   # → JWT_SECRET
openssl rand -hex 32   # → PEPPER
```

---

## Docker Compose — Betrieb

Die gesamte Anwendung läuft als Docker-Stack. Der Build-Kontext ist das
Monorepo-Root — `docker compose up --build` kompiliert alle Services
vollautomatisch (TypeScript → JS, React → statische Dateien).

### Stack starten (2 Container)

Der gesamte CoreMail-Stack besteht aus **zwei Containern**:
- `coremail-app` — alle Node.js-Services + nginx + Frontends
- `coremail-db` — PostgreSQL + Redis + MinIO

```bash
# Images von Docker Hub laden und starten
docker compose -f infra/docker/docker-compose.yml up -d

# Oder lokaler Build (aus Quellcode):
docker compose -f infra/docker/docker-compose.yml up -d --build
```

### Mit Observability (Profil `observability`)

Aktiviert zusätzlich: Prometheus, Grafana, Tempo, Loki, Alertmanager, OTEL Collector:

```bash
docker compose -f infra/docker/docker-compose.yml \
  --profile observability up -d
```

### Status prüfen

```bash
docker compose -f infra/docker/docker-compose.yml ps
```

Beide Container sollten nach ca. 60–90 Sekunden den Status `healthy` erreichen.

### Einzelne Services im App-Container debuggen

```bash
# supervisorctl im App-Container
docker exec -it coremail-app supervisorctl status

# Einzelnen Service neu starten
docker exec -it coremail-app supervisorctl restart api-gateway
```

### Logs ansehen

```bash
# Alle Logs
docker compose -f infra/docker/docker-compose.yml logs -f

# Nur App-Container
docker logs -f coremail-app

# Nur DB-Container
docker logs -f coremail-db
```

### Stack stoppen

```bash
docker compose -f infra/docker/docker-compose.yml down
```

Volumes bleiben erhalten (Daten gehen nicht verloren). Zum vollständigen
Löschen inklusive Daten:
```bash
docker compose -f infra/docker/docker-compose.yml down -v
```

---

## Zugriff nach dem Start

| URL / Adresse | Beschreibung |
|---------------|-------------|
| `https://<MAIL_HOSTNAME>/owa/` | Webmail (OWA) |
| `https://<MAIL_HOSTNAME>/ecp/` | Admin-Panel (ECP) |
| `https://<MAIL_HOSTNAME>/EWS/Exchange.asmx` | EWS Web Services (Outlook) |
| `https://<MAIL_HOSTNAME>/Microsoft-Server-ActiveSync` | ActiveSync EAS 14.1 (iOS / Android / Outlook Mobile) |
| `https://<MAIL_HOSTNAME>/Autodiscover/Autodiscover.xml` | Autodiscover v1 |
| `https://<MAIL_HOSTNAME>/api/v1/` | REST API |
| `https://<MAIL_HOSTNAME>/api/v1/smime/certificates` | S/MIME Zertifikat-Verwaltung |
| `http://localhost:9001` | MinIO Web-Konsole |
| `http://localhost:9090` | Prometheus *(Observability-Profil)* |
| `http://localhost:3001` | Grafana *(Observability-Profil)* |
| `http://localhost:9093` | Alertmanager *(Observability-Profil)* |

**Mail-Ports** (erreichbar über `<MAIL_HOSTNAME>`):

| Port | Protokoll | Verschlüsselung |
|------|-----------|----------------|
| 25 | SMTP (eingehend) | STARTTLS |
| 465 | SMTPS (Submission) | Implizites TLS |
| 587 | SMTP Submission | STARTTLS |
| 143 | IMAP | STARTTLS |
| 993 | IMAPS | Implizites TLS |
| 110 | POP3 *(Profil: full)* | STARTTLS |
| 995 | POP3S *(Profil: full)* | Implizites TLS |
| 443 | ActiveSync EAS *(Profil: full, via nginx)* | TLS |

> **Hinweis Zertifikate:** In der Entwicklung nutze `scripts/gen-dev-certs.sh`
> für selbstsignierte Zertifikate. Im Browser einmalig die Warnung akzeptieren
> oder das CA-Zertifikat dem System-Keystore hinzufügen.
> In der Produktion echte Zertifikate (z.B. Let's Encrypt) unter
> `infra/docker/nginx/certs/fullchain.pem` und `privkey.pem` ablegen.

---

## TLS-Zertifikate (Produktion)

Zertifikate unter `infra/docker/nginx/certs/` ablegen:

```
infra/docker/nginx/certs/
├── fullchain.pem   ← Zertifikat + Zwischenzertifikate (z.B. Let's Encrypt)
└── privkey.pem     ← Privater Schlüssel
```

Mit **Certbot** (Let's Encrypt):

```bash
certbot certonly --standalone -d mail.meinedomain.de

# Zertifikate kopieren
cp /etc/letsencrypt/live/mail.meinedomain.de/fullchain.pem \
   infra/docker/nginx/certs/fullchain.pem
cp /etc/letsencrypt/live/mail.meinedomain.de/privkey.pem \
   infra/docker/nginx/certs/privkey.pem
```

Für automatische Erneuerung einen Cron-Job mit `certbot renew` und
anschließendem `docker compose restart nginx` einrichten.

---

## Erster Admin-Account

Nach dem ersten Start einen Admin-Benutzer über die API anlegen:

```bash
curl -s -X POST https://<MAIL_HOSTNAME>/api/v1/admin/setup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@meinedomain.de",
    "password": "sicheres-passwort",
    "displayName": "Administrator"
  }'
```

Danach unter `https://<MAIL_HOSTNAME>/ecp/` mit den Zugangsdaten anmelden.

---

## Docker Hub Images

CoreMail verwendet ab v0.9.0 eine **2-Container-Architektur** — nur noch zwei Images auf Docker Hub:

**Übersicht:** [hub.docker.com/u/magpeek](https://hub.docker.com/u/magpeek)

| Image | Tag | Inhalt |
|-------|-----|--------|
| [`magpeek/coremail-app`](https://hub.docker.com/r/magpeek/coremail-app) | `0.9.0` / `latest` | Alle Node.js-Services + nginx + OWA/ECP-Frontends |
| [`magpeek/coremail-db`](https://hub.docker.com/r/magpeek/coremail-db) | `0.9.0` / `latest` | PostgreSQL 16 + Redis 7 + MinIO |

### Was ist in `coremail-app`?

Alle CoreMail-Dienste in einem Image, verwaltet von `supervisord`:

```
smtp-server · imap-server · pop3-server · ews-server (+ MAPI)
api-gateway (+ EMS 20+ Cmdlets + eDiscovery) · auth-service
caldav-server · autodiscover · backup-service · activesync
security-filter · storage-api · nginx · OWA-Frontend · ECP-Frontend
```

### Produktion starten (ohne lokalen Build)

```bash
# Beide Images von Docker Hub laden und starten
docker compose -f infra/docker/docker-compose.yml up -d
```

### Tag-Schema

| Tag | Bedeutung |
|-----|-----------|
| `0.9.0` | Exakte Version (aktuell) |
| `0.9` | Neueste Patch-Version von 0.9.x |
| `latest` | Neuestes stabiles Release |
| `edge` | Aktueller Stand des `main`-Branches |

### CI/CD — Automatischer Build

Der GitHub Actions Workflow (`.github/workflows/docker-publish.yml`) baut und
pusht beide Images automatisch:

- **Bei Push auf `main`** → Tag `edge` + `sha-<hash>`
- **Bei Git-Tag `v0.9.0`** → Tags `0.9.0`, `0.9`, `0`, `latest`
- **Bei Pull Request** → nur Build, kein Push

**Multi-Arch:** Beide Images werden für `linux/amd64` und `linux/arm64` gebaut.

### Manueller Build und Push

```bash
# Beide Images bauen und zu Docker Hub pushen
bash scripts/docker-push.sh

# Explizite Version
bash scripts/docker-push.sh 0.9.0

# Nur bauen, nicht pushen (lokaler Test)
bash scripts/docker-push.sh 0.9.0 --no-push
```

---

## Konfiguration

Alle Umgebungsvariablen werden über die `.env`-Datei gesetzt. Jeder Service liest nur die für ihn relevanten Variablen.

### Vollständige Variablen-Referenz

```env
# ── Allgemein ──────────────────────────────────────────────────────────
NODE_ENV=production           # development | production | test
MAIL_HOSTNAME=mail.domain.de  # Vollqualifizierter Hostname des Mailservers
LOG_LEVEL=info                # error | warn | info | debug

# ── PostgreSQL ─────────────────────────────────────────────────────────
POSTGRES_PASSWORD=...         # Pflicht: sicheres Passwort

# ── Redis ──────────────────────────────────────────────────────────────
REDIS_PASSWORD=...            # Pflicht

# ── MinIO (Objektspeicher für Anhänge) ────────────────────────────────
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=...       # Pflicht

# ── JWT & Sicherheit ───────────────────────────────────────────────────
JWT_SECRET=...                # min. 32 Zeichen, zufällig
PEPPER=...                    # min. 32 Zeichen, zufällig (für Passwort-Hashing)

# ── Auth-Service ───────────────────────────────────────────────────────
AUTH_PORT=3003                # Interner Port des Auth-Service (Standard: 3003)

# ── WebAuthn (MFA FIDO2) ───────────────────────────────────────────────
WEBAUTHN_RP_NAME=CoreMail             # Anzeigename im Authenticator-Dialog
WEBAUTHN_RP_ID=mail.domain.de        # Must match MAIL_HOSTNAME
WEBAUTHN_ORIGIN=https://mail.domain.de

# ── EWS-Server ─────────────────────────────────────────────────────────
EWS_URL=https://mail.domain.de/EWS/Exchange.asmx
OWA_URL=https://mail.domain.de/owa/

# ── Autodiscover ───────────────────────────────────────────────────────
AUTODISCOVER_BASE=https://mail.domain.de
IMAP_HOST=mail.domain.de
SMTP_HOST=mail.domain.de

# ── ActiveSync (EAS 14.1) ─────────────────────────────────
EAS_URL=https://mail.domain.de/Microsoft-Server-ActiveSync  # Autodiscover-URL
EAS_PORT=3005                                                # Interner Container-Port

# ── GeoIP (optional, für Country-Filtering) ───────────────────────────
# Kostenlose Registrierung: https://www.maxmind.com/en/geolite2/signup
MAXMIND_ACCOUNT_ID=           # Leer lassen = Country-Filter deaktiviert
MAXMIND_LICENSE_KEY=
```

### Optionale Module aktivieren

Per Docker-Compose-Profile können nicht benötigte Module deaktiviert werden:

```bash
# Nur Kern-Stack (ohne POP3, CalDAV, Backup)
docker compose -f infra/docker/docker-compose.yml up -d

# Vollständiger Stack mit allen optionalen Modulen
docker compose -f infra/docker/docker-compose.yml --profile full up -d
```

| Modul | Standardmäßig | Profile |
|-------|--------------|---------|
| SMTP, IMAP, EWS, OWA, ECP | ✅ immer aktiv | — |
| POP3 | ⬜ optional | `full` |
| CalDAV / CardDAV | ⬜ optional | `full` |
| Backup-Service | ⬜ optional | `full` |
| **ActiveSync EAS 14.1** | ⬜ optional | `full` |

---

## Module im Detail

### `packages/core`
Gemeinsame Bibliothek — wird von allen anderen Modulen als Dependency eingebunden, läuft aber **nicht als eigener Service**.

- **JWT**: `signAccessToken`, `signRefreshToken`, `verifyAccessToken` (15min/30d TTL)
- **Passwort**: bcrypt (Cost 12) + pepper, App-Passwort-Generator (6-4-Gruppen-Format)
- **Redis**: Singleton-Client, Pub/Sub-Channels (`mail:new`, `mail:update`, `calendar:update`, `admin:event`), Key-Factories für Sessions, Greylisting, MFA
- **Config**: Zod-validierte Umgebungsvariablen — fehlende Pflichtfelder beenden den Service beim Start mit klarer Fehlermeldung
- **Logger**: pino mit farbiger Ausgabe in Entwicklung, strukturiertes JSON in Produktion

### `packages/storage`
Datenhaltungsschicht — ebenfalls als Bibliothek, nicht als eigener HTTP-Service. Alle Services, die PostgreSQL oder MinIO benötigen, importieren diese Bibliothek.

- **Prisma-Schema**: 34 Entitäten — User, Domain, Mailbox, Folder, Message, Attachment, SharedMailbox, Calendar, CalendarEvent, Contact, Task, Note, BackupJob, SystemLog, Quarantine, Blacklist, Session, UserMfa, AppPassword, LdapConfig, OidcProvider, SharedMailboxPerm, ActiveSyncDevice, UserCertificate, DistributionGroup, DistributionGroupMember, ResourceMailbox, ResourceCalendar, ResourceBooking, PublicFolder, PublicFolderMessage, EDiscoverySearch, LegalHold, TransportRule
- **MinIO-Client**: Upload/Download/Delete, Key-Factories (attachments/, raw/, quarantine/, backups/)
- **MIME-Parser**: parst RFC 2822-Mails via `mailparser`, extrahiert Anhänge mit SHA-256-Hash für Deduplizierung

### `packages/security-filter`
Eigenständiger HTTP-Service (Port 3002). Wird vom SMTP-Server für jede eingehende Mail aufgerufen.

Siehe [Sicherheit & Anti-Spam](#sicherheit--anti-spam) für Details.

### `packages/smtp-server`
SMTP Inbound (Port 25) und Outbound-Queue.

- **Inbound**: `smtp-server` npm-Paket, prüft Empfänger in PostgreSQL, ruft Security-Filter auf, speichert in PostgreSQL/MinIO, pusht via Redis für IMAP-IDLE
- **Outbound**: BullMQ-Queue in Redis, 10 Retries mit exponentiellem Backoff (60s Basis), MX-Lookup, nodemailer-Relay, DKIM-Signierung
- **Quarantäne**: Viren/Policy-Verstöße → MinIO-Upload + DB-Eintrag + Admin-Event
- **Verteilergruppen-Expansion** **: Eingehende E-Mails an Gruppenadresse werden rekursiv zu allen Mitgliedern expandiert (Loop-Schutz via `visited`-Set, Deduplizierung)
- **Ressourcen-Auto-Accept** **: iCal-VEVENT aus Anhängen wird geparst → Buchung automatisch als ACCEPTED/DECLINED/PENDING gespeichert

### `packages/imap-server`
IMAP4rev1-Server (Port 143 / 993).

- **RFC 3501**: CAPABILITY, LOGIN, AUTHENTICATE, SELECT, EXAMINE, LIST, FETCH, STORE, EXPUNGE, COPY, LOGOUT, NOOP
- **IDLE (RFC 2177)**: Redis-Subscription → sofortiger Push bei neuer Mail im ausgewählten Ordner
- **CONDSTORE**: HIGHESTMODSEQ-Tracking, MODSEQ in FETCH-Antworten, ENABLE CONDSTORE
- **Authentifizierung**: Hauptpasswort (bcrypt+pepper) oder App-Passwort (MFA-kompatibel)

### `packages/pop3-server` **
POP3-Server (Port 110 / 995) — RFC 1939 mit UIDL, TOP, CAPA, STLS.

### `packages/ews-server`
EWS Web Services SOAP/XML-Endpunkt (`/EWS/Exchange.asmx`) — die Schnittstelle für Outlook Desktop (2010–2024) und Outlook für Mac.

**Implementierte EWS-Operationen:**

| Operation | Beschreibung |
|-----------|-------------|
| `FindItem` | Nachrichtenliste (Paging, Sortierung), CalendarView |
| `GetItem` | Vollständige Nachricht (Body, Anhänge, BaseShape IdOnly/Default/AllProperties) |
| `CreateItem` | Entwurf (SaveOnly), Senden (SendOnly/SendAndSaveCopy), CalendarItem |
| `UpdateItem` | IsRead setzen, Flags (Flagged/NotFlagged) via SetItemField |
| `DeleteItem` | HardDelete, SoftDelete (30-Tage recoverable), MoveToDeletedItems |
| `MoveItem` | Nachricht in anderen Ordner verschieben (DistinguishedFolderId + FolderId) |
| `CopyItem` | Nachricht kopieren (neue UID, gleiche Metadaten) |
| `SyncFolderHierarchy` | Ordner-Baum delta-sync (ChangeKey-basiert) |
| `SyncFolderItems` | Nachrichten delta-sync (Create + Delete Events) |
| `ResolveNames` | Autovervollständigung aus Users + Contacts (case-insensitive) |
| `GetUserAvailability` | Frei-/Belegtzeiten aus Kalender (GetUserAvailability-Response) |
| `Subscribe` | Streaming + Push Subscription anlegen (Redis-gesichert, 30 min TTL) |
| `Unsubscribe` | Subscription beenden, Long-Poll-Verbindung schließen |
| `GetStreamingEvents` | Long-Poll SSE-ähnlich → Outlook Push-Benachrichtigungen via Redis Pub/Sub |

**Authentifizierung im EWS-Server:**
- **Bearer Token** (Outlook Modern Auth / OAuth2): JWT direkt validiert
- **Basic Auth** (Outlook Legacy): Weiterleitung an auth-service, Token-Rückgabe
- **X-AnchorMailbox / X-OpenTypeMailbox**: Shared-Mailbox-Delegation (Berechtigungsprüfung via DB)

**SOAP-Implementierung:**
- Parser: `xml2js` (tag-name Normalisierung, kein Namespace-Overhead)
- Builder: `xmlbuilder2` (streaming, kein DOM im Speicher)
- EWS-Namespace: `http://schemas.microsoft.com/exchange/services/2006/messages`

### `packages/autodiscover`
Autodiscover-Service für automatische Outlook-Konfiguration — kein manuelles Einrichten nötig.

**Autodiscover v1** (`POST /Autodiscover/Autodiscover.xml`) — Outlook 2010–2016:
- XML-basiert, E-Mail-Adresse aus `<EMailAddress>`-Element extrahiert
- Antwort enthält: EWS-URL (`EXCH`), IMAP (Port 993, SSL), SMTP (Port 587, STARTTLS)
- DisplayName aus PostgreSQL-User aufgelöst

**Autodiscover v2** (`GET /autodiscover/autodiscover.json/v1.0/{email}?Protocol=…`) — Outlook 2019/365:
- JSON-basiert, Protocol-Parameter steuert Antworttyp
- `Protocol=EWS` → EWS-URL
- `Protocol=AutodiscoverV1` → Redirect auf v1-Endpunkt (für alte Clients)
- `Protocol=IMAP` → IMAP-Host + Port
- `Protocol=SMTP` → SMTP-Host + Port

```
# Outlook fragt automatisch (ohne Benutzeraktion):
GET https://mail.domain.de/autodiscover/autodiscover.json/v1.0/user@domain.de?Protocol=AutodiscoverV1
→ {"Protocol":"AutodiscoverV1","Url":"https://mail.domain.de/Autodiscover/Autodiscover.xml"}

GET https://mail.domain.de/autodiscover/autodiscover.json/v1.0/user@domain.de?Protocol=EWS
→ {"Protocol":"EWS","Url":"https://mail.domain.de/EWS/Exchange.asmx"}
```

### `packages/auth-service`
Zentraler Authentifizierungsservice (Port 3003) — koordiniert alle Anmeldemethoden.

**Authentifizierungsfluss:**
```
POST /auth/login { email, password }
    │
    ├── 1. Lokale Authentifizierung (bcrypt + pepper)
    ├── 2. LDAP/AD-Fallback (wenn konfiguriert)
    │
    ├── MFA aktiviert? → { mfaRequired: true, challengeToken, method }
    └── MFA deaktiviert? → { accessToken, refreshToken, expiresIn: 900 }

POST /auth/mfa/verify { challengeToken, code|backupCode|webauthnResponse }
    → { accessToken, refreshToken, expiresIn: 900 }
```

**MFA-Methoden im Detail:**
- **TOTP**: Setup → QR-Code (otpauth URI), Confirm (Code bestätigt → aktiviert), Verify (±30s Fenster)
- **WebAuthn/FIDO2**: Registration (Credential in PostgreSQL als JSON), Authentication (Counter-Verifikation gegen Replay-Attacks)
- **Backup-Codes**: 10 Codes, bcrypt-gehasht, nach Nutzung automatisch entfernt
- **MFA-Challenge-Token**: 32 Bytes kryptografisch sicher, 10 min TTL in Redis

**App-Passwörter** (für IMAP/POP3/SMTP-Clients ohne Modern Auth):
- Format `XXXX-XXXX-XXXX-XXXX` (8 kryptografisch sichere Bytes als Hex)
- bcrypt-gehasht in PostgreSQL, nie im Klartext gespeichert
- Last-Used-Tracking für Audit

### `packages/auth-ldap`
LDAP/Active Directory Integration via `ldapts` (async/await, LDAPS + STARTTLS).

```yaml
# Domain-spezifische Konfiguration in PostgreSQL (LdapConfig-Tabelle)
host: ldap.company.com
port: 636              # LDAPS
baseDN: "dc=company,dc=com"
bindDN: "cn=coremail,ou=serviceaccounts,dc=company,dc=com"
userFilter: "(sAMAccountName={{username}})"
attributeMap:
  email: "mail"
  displayName: "displayName"
```

**Ablauf:** Service-Account-Bind → User-Suche per Filter → User-Bind (Passwort-Verifikation) → User automatisch in PostgreSQL anlegen/aktualisieren → CoreMail-JWT ausstellen.

**LDAP-Sync:** Stündlicher Bulk-Sync aller Verzeichnis-User per Domain (manuell auslösbar über ECP).

### `packages/auth-sso`
SSO via OIDC/OAuth2 mit `openid-client` (Panva, OIDC-zertifiziert).

**Authorization Code Flow:**
```
1. GET /auth/oidc/start?providerId=...  → Redirect zu IdP
2. IdP-Login → Callback: GET /auth/oidc/callback?code=...&state=...
3. Code → Token-Exchange → ID-Token-Validierung (JWKS)
4. User anlegen/sync in PostgreSQL
5. CoreMail JWT ausstellen
```

State + Nonce in Redis gesichert (10 min TTL), OIDC-Client pro Provider gecacht (Discovery nur einmal).

### `packages/caldav-server` **
CalDAV (RFC 4791) + CardDAV (RFC 6352) für mobile Clients (iOS, Android, Thunderbird).

### `packages/api-gateway` **
REST-API + SSE + WebSocket-Gateway für den Web-Client.

### `packages/web-client` **
React 19 OWA-UI — identisches Layout wie Coremail OWA.

### `packages/admin-panel` **
React 19 ECP-UI — Coremail Admin-Panel (ECP)-ähnliche Admin-Oberfläche.

### `packages/backup-service` **
Backup- und Wiederherstellungsservice — MBOX/EML-Export, Admin-Vollbackup zu S3.

### `packages/activesync` **

Coremail der OpenSource Mailserver für kleine Umgebungen ActiveSync EAS 14.1-Server (Port 3005) für mobile Clients: iOS Mail, Android Gmail/Outlook, Samsung Email.

**WBXML-Codec** — binäres XML-Format, das EAS für alle Kommunikation verwendet:
- Vollständige Implementierung der EAS Code Pages: AirSync, Email, FolderHierarchy, Provision, Ping, ComposeMail
- Bidirektionaler Encoder + Decoder (eigene Implementierung, keine externe Abhängigkeit)

**Implementierte EAS-Befehle:**

| Befehl | Beschreibung |
|--------|-------------|
| `OPTIONS` | Capability-Aushandlung (Protokollversionen, unterstützte Befehle) |
| `Provision` | Geräte-Registrierung, Richtlinien-Aushandlung (permissive Policy) |
| `FolderSync` | Ordnerhierarchie synchronisieren (initial + inkrementell) |
| `Sync` | Bidirektionale E-Mail-Synchronisation mit Delta-Tracking |
| `SendMail` | Ausgehende E-Mails über Redis-Queue versenden |
| `SmartReply` | Antworten mit MIME-Payload |
| `SmartForward` | Weiterleiten mit MIME-Payload |
| `Ping` | Long-Poll Push-Benachrichtigungen (Heartbeat bis 59 Minuten) |
| `GetAttachment` | Anhang-Abruf per AttachmentName |

**Authentifizierung:**
- Basic Auth (Benutzername + Passwort)
- App-Passwörter (für MFA-gesicherte Konten)

**Geräteverwaltung** — `ActiveSyncDevice`-Tabelle in PostgreSQL:
- Geräte-ID, Gerätetyp, freundlicher Name
- SyncKey-Map pro Ordner (Delta-Tracking)
- Status: OK / PENDING / BLOCKED / WIPED
- Remote-Wipe-Zeitstempel

**Autodiscover-Integration:** Autodiscover v1 gibt automatisch den ActiveSync-Protokollblock zurück — iOS und Android richten sich dadurch ohne manuelle Eingabe ein:
```xml
<Account>
  <AccountType>email</AccountType>
  <Action>settings</Action>
  <Protocol>
    <Type>ActiveSync</Type>
    <Server>https://mail.domain.de/Microsoft-Server-ActiveSync</Server>
    <LoginName>user@domain.de</LoginName>
    <SSL>on</SSL>
  </Protocol>
</Account>
```

**nginx-Konfiguration:** `/Microsoft-Server-ActiveSync` hat `proxy_read_timeout 600s` — notwendig für den Ping-Befehl (Long-Poll bis 59 Minuten).

### S/MIME API **

REST-Endpunkte unter `/api/v1/smime/` für die S/MIME-Zertifikat-Verwaltung im api-gateway:

| Endpunkt | Methode | Beschreibung |
|----------|---------|-------------|
| `/api/v1/smime/certificates` | GET | Alle eigenen Zertifikate auflisten |
| `/api/v1/smime/certificates` | POST | PKCS#12-Zertifikat importieren |
| `/api/v1/smime/certificates/:id` | PUT | Label / Standard-Flag ändern |
| `/api/v1/smime/certificates/:id` | DELETE | Zertifikat entfernen |
| `/api/v1/smime/public-key/:email` | GET | Public Key eines Kontakts für ausgehende Verschlüsselung |
| `/api/v1/smime/devices` | GET | Eigene ActiveSync-Geräte anzeigen |
| `/api/v1/smime/devices/:id` | DELETE | Gerät deregistrieren / Remote-Wipe |

**Datenspeicherung** — `UserCertificate`-Tabelle in PostgreSQL:
- SHA-256-Fingerprint (eindeutig)
- X.509 Subject-DN + Issuer-DN
- Gültigkeitszeitraum (notBefore / notAfter)
- Binäre PKCS#12-Datei in MinIO (verschlüsselt)
- `signingDefault` + `encryptDefault` Flags

### Verteilergruppen **

Statische und dynamische Verteilergruppen für SMTP-Expansion und GAL:

| Endpunkt | Methode | Beschreibung |
|----------|---------|-------------|
| `/api/v1/admin/groups` | GET | Alle Gruppen (inkl. Mitgliederanzahl) |
| `/api/v1/admin/groups` | POST | Neue Gruppe erstellen |
| `/api/v1/admin/groups/:id` | PUT | Gruppe bearbeiten |
| `/api/v1/admin/groups/:id` | DELETE | Gruppe löschen |
| `/api/v1/admin/groups/:id/members` | GET/POST | Mitglieder verwalten |
| `/api/v1/admin/groups/:id/members/:email` | DELETE | Mitglied entfernen |
| `/api/v1/admin/groups/gal/list` | GET | Sichtbare Gruppen für Adress-Autovervollständigung |

**Gruppentypen:**
- `STATIC` — manuell gepflegte Mitgliederliste
- `DYNAMIC` — LDAP-Filter-basiert (automatisch aktualisiert)

**Mitgliedertypen:** `USER`, `SHARED_MAILBOX`, `GROUP` (verschachtelt), `EXTERNAL`

**Konfigurierbar:** externe Absender erlauben/sperren, Moderierung (mit Moderatoren), GAL-Sichtbarkeit

### Raum- und Ressourcenpostfächer **

Conference-Rooms und Equipment-Postfächer mit automatischer Buchungsverarbeitung:

| Endpunkt | Methode | Beschreibung |
|----------|---------|-------------|
| `/api/v1/admin/resources` | GET/POST | Ressourcen verwalten |
| `/api/v1/admin/resources/:id` | PUT/DELETE | Ressource bearbeiten/löschen |
| `/api/v1/admin/resources/:id/bookings` | GET | Buchungen anzeigen |
| `/api/v1/admin/resources/:id/bookings/:id` | DELETE | Buchung stornieren |
| `/api/v1/admin/resources/freebusy/query` | GET | Free/Busy-Abfrage für Outlook |

**Auto-Accept-Logik:**
```
Eingehende E-Mail an raum@domain.de
  → VEVENT in iCal-Anhang erkannt
  → Konflikte prüfen (autoDeclineConflict=true)
  → Buchung als ACCEPTED / DECLINED / PENDING speichern
  → Status in ResourceBooking-Tabelle
```

**Buchungsregeln** (ECP-konfigurierbar): maximale Dauer, Buchungsvorlauf in Tagen, Genehmigungspflicht mit Delegierten, wiederkehrende Termine erlauben/sperren.

### Öffentliche Ordner **

Hierarchische Ordnerstruktur für organisationsweite Inhalte:

**Admin-API:**

| Endpunkt | Methode | Beschreibung |
|----------|---------|-------------|
| `/api/v1/admin/public-folders` | GET | Vollständigen Baum abrufen |
| `/api/v1/admin/public-folders` | POST | Neuen Ordner erstellen |
| `/api/v1/admin/public-folders/:id` | PUT/DELETE | Bearbeiten/Löschen (kaskadierend) |
| `/api/v1/admin/public-folders/:id/acl` | GET/POST | ACL verwalten |
| `/api/v1/admin/public-folders/:id/acl/:userId` | DELETE | ACL-Eintrag entfernen |

**User-API:**

| Endpunkt | Methode | Beschreibung |
|----------|---------|-------------|
| `/api/v1/public-folders` | GET | Zugängliche Ordner anzeigen |
| `/api/v1/public-folders/:id` | GET | Ordner-Detail |
| `/api/v1/public-folders/:id/messages` | GET | Beiträge lesen |
| `/api/v1/public-folders/:id/messages` | POST | Beitrag verfassen |

**ACL-Berechtigungen:** `READ` (lesen), `POST` (lesen + schreiben), `OWNER` (vollständig)

### PowerShell-Remoting & EMS REST-Bridge **

Vollständiger WSMan/WS-Management-Endpunkt für Management Shell (EMS):

```
GET  /PowerShell/   → WSDL-Beschreibung
POST /PowerShell/   → WSMan-Identify (vollständige Antwort)
                      + Cmdlets werden an EMS REST-Bridge geroutet
                      + Nicht-unterstützte Cmdlets → SOAP-Fault mit Liste
```

**Unterstützte Cmdlets (20+):**

| Kategorie | Cmdlets |
|-----------|---------|
| Postfächer | `Get-Mailbox`, `New-Mailbox`, `Set-Mailbox`, `Remove-Mailbox` |
| Gruppen | `Get-DistributionGroup`, `New-DistributionGroup`, `Set-DistributionGroup`, `Remove-DistributionGroup` |
| Grupenmitglieder | `Add-DistributionGroupMember`, `Remove-DistributionGroupMember`, `Get-DistributionGroupMember` |
| Domains | `Get-AcceptedDomain`, `New-AcceptedDomain`, `Remove-AcceptedDomain` |
| Transportregeln | `Get-TransportRule`, `New-TransportRule`, `Set-TransportRule`, `Remove-TransportRule`, `Enable-TransportRule`, `Disable-TransportRule` |
| Statistiken | `Get-MailboxStatistics` |
| Ressourcen | `Get-ResourceMailbox` |

**EMS REST-Bridge** (`/api/v1/admin/ems/`):
```
GET    /mailboxes                          → Get-Mailbox
POST   /mailboxes                          → New-Mailbox
PUT    /mailboxes/:identity                → Set-Mailbox
DELETE /mailboxes/:identity                → Remove-Mailbox
GET    /distribution-groups                → Get-DistributionGroup
POST   /transport-rules                    → New-TransportRule
GET    /mailbox-statistics/:identity       → Get-MailboxStatistics
POST   /cmdlet                             → Universeller Cmdlet-Dispatcher
```

### eDiscovery & Legal Hold **

Compliance-Suche über alle Postfächer und rechtliche Aufbewahrungssperren:

**eDiscovery-Suche:**

| Endpunkt | Methode | Beschreibung |
|----------|---------|-------------|
| `/api/v1/admin/ediscovery/searches` | GET/POST | Suchen verwalten |
| `/api/v1/admin/ediscovery/searches/:id` | GET/DELETE | Einzelne Suche |
| `/api/v1/admin/ediscovery/searches/:id/run` | POST | Suche ausführen (async via Redis) |
| `/api/v1/admin/ediscovery/searches/:id/results` | GET | Ergebnisse paginiert abrufen |
| `/api/v1/admin/ediscovery/searches/:id/export` | POST | Als MBOX exportieren (Job) |

**Suchparameter:** Schlüsselwörter, Absender, Empfänger, Datum von/bis, Betreff, Hat Anhang, Postfach-Scope

**Legal Hold:**

| Endpunkt | Methode | Beschreibung |
|----------|---------|-------------|
| `/api/v1/admin/ediscovery/holds` | GET/POST | Aufbewahrungssperren verwalten |
| `/api/v1/admin/ediscovery/holds/:id` | GET/DELETE | Sperre anzeigen / aufheben |
| `/api/v1/admin/ediscovery/holds/check/:userId` | GET | Ist User unter Legal Hold? |

Legal Hold verhindert die permanente Löschung aller E-Mails der betroffenen Postfächer.

### MAPI over HTTP **

Outlook 2013 SP1+ und Outlook 365 nutzen MAPI over HTTP als primären Transport (statt RPC/HTTP). Der EWS-Server implementiert den vollständigen Session-Lifecycle:

```
Outlook → GET  /mapi/healthcheck.htm       → "MAPI" (Connectivity-Probe)
Outlook → POST /mapi/emsmdb/ {Connect}     → Session-Cookie + Server-Info
Outlook → POST /mapi/emsmdb/ {Execute}     → ecNotSupported → EWS-Fallback
Outlook → POST /mapi/emsmdb/ {Disconnect}  → Session beenden
Outlook → POST /mapi/nspi/   {Bind}        → Adressbuch-Session
Outlook → POST /mapi/nspi/   {QueryRows}   → GAL-Einträge (aus PostgreSQL)
Outlook → POST /mapi/nspi/   {ResolveNames}→ Namensauflösung
```

**Verhalten:** Outlook öffnet eine MAPI-Session, erhält Server-Metadaten und fällt bei ROP-Befehlen (`Execute`) transparent auf EWS zurück — vollständig transparent für den Benutzer.

---

## Mail-Protokolle

### SMTP

| Port | Verschlüsselung | Verwendung |
|------|----------------|-----------|
| 25   | STARTTLS (opportunistisch) | Server-zu-Server (MX) |
| 465  | Implicit TLS | Submission (Legacy) |
| 587  | STARTTLS (Pflicht) | Submission (empfohlen) |

**Ausgehende Mails** durchlaufen die BullMQ-Queue mit automatischen Retries:
- Versuch 1: sofort
- Versuch 2: nach 1 min
- Versuch 3: nach 2 min
- Versuch 4: nach 4 min
- … bis zu 10 Versuche (≈ 17 Stunden gesamt)

### IMAP

| Port | Verschlüsselung |
|------|----------------|
| 143  | STARTTLS |
| 993  | Implicit TLS (IMAPS) |

**Unterstützte Extensions:**
`IMAP4rev1`, `IDLE`, `CONDSTORE`, `ESEARCH`, `LITERAL+`, `QUOTA`, `NAMESPACE`, `UTF8=ACCEPT`, `AUTH=PLAIN`, `AUTH=LOGIN`

### ActiveSync EAS 14.1 *(neu in v0.7.0)*

Mobile Clients (iOS Mail, Android Gmail/Outlook, Samsung Email) synchronisieren via ActiveSync (EAS) über HTTPS:

```
Endpunkt:  POST https://mail.domain.de/Microsoft-Server-ActiveSync?Cmd=<Befehl>
Protokoll: WBXML (binäres XML), Content-Type: application/vnd.ms-sync.wbxml
Auth:      Basic Auth (Benutzername + Passwort oder App-Passwort)
```

**Einrichten auf dem Smartphone:**
iOS und Android erkennen den Server automatisch über Autodiscover — nur E-Mail-Adresse und Passwort eingeben, der Rest wird automatisch konfiguriert.

Manuell:
```
Server:        mail.domain.de
Benutzername:  user@domain.de
Passwort:      Hauptpasswort oder App-Passwort (bei MFA)
SSL:           Ja
```

**Sync-Verhalten:**
- **Erstmalige Synchronisation**: alle vorhandenen Mails der letzten 30 Tage (konfigurierbar)
- **Delta-Sync**: nur Änderungen seit dem letzten Sync (SyncKey-basiert, je Ordner)
- **Push-Benachrichtigungen**: Ping-Befehl hält Verbindung offen — neue Mails werden sofort auf dem Gerät angezeigt (Heartbeat bis 59 Minuten)
- **Bidirektional**: Lesen/Löschen auf dem Gerät wird sofort ins Postfach übertragen

### EWS (EWS Web Services)

Outlook Desktop (2010–2024) und Outlook für Mac kommunizieren via EWS — SOAP/XML über HTTPS:

```
POST https://mail.domain.de/EWS/Exchange.asmx
Content-Type: text/xml; charset=utf-8
Authorization: Bearer <token>        (Modern Auth)
            oder Basic <base64>      (Legacy, Outlook 2016 und älter)

<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">
  <soap:Body>
    <m:FindItem Traversal="Shallow">
      <m:ItemShape>
        <t:BaseShape>Default</t:BaseShape>
      </m:ItemShape>
      <m:IndexedPageItemView MaxReturnsPerPage="50" Offset="0" BasePoint="Beginning"/>
      <m:ParentFolderIds>
        <t:DistinguishedFolderId Id="inbox"/>
      </m:ParentFolderIds>
    </m:FindItem>
  </soap:Body>
</soap:Envelope>
```

**Shared Mailboxen** — Outlook delegiert mit zusätzlichem Header:
```
POST /EWS/Exchange.asmx
X-AnchorMailbox: support@company.com
X-OpenTypeMailbox: support@company.com
Authorization: Basic <user-credentials>
```

**Autodiscover** — Outlook erkennt den Server automatisch, kein manuelles Setup nötig:
```
# Outlook 2019/365 (Modern Auth, v2)
GET https://mail.domain.de/autodiscover/autodiscover.json/v1.0/user@domain.de?Protocol=EWS
→ { "Protocol": "EWS", "Url": "https://mail.domain.de/EWS/Exchange.asmx" }

# Outlook 2016 und älter (v1)
POST https://mail.domain.de/Autodiscover/Autodiscover.xml
→ <EwsUrl>https://mail.domain.de/EWS/Exchange.asmx</EwsUrl>
   + IMAP (Port 993), SMTP (Port 587) in derselben Antwort
```

**Streaming Subscription** — Outlook hält eine Long-Poll-Verbindung für Push-Events:
```
Outlook → Subscribe → SubscriptionId
Outlook → GetStreamingEvents (long-poll, bis 30 min)
              ↑ Redis Pub/Sub sendet NewMailEvent
              → Outlook aktualisiert Inbox sofort
```

---

## Sicherheit & Anti-Spam

### Mail-Security-Pipeline

Jede eingehende E-Mail durchläuft eine **4-stufige Pipeline**, bevor sie zugestellt wird:

```
Eingehende SMTP-Verbindung
        │
        ▼
┌───────────────────────────────────────────────────────────┐
│  STUFE 1 — Verbindungs-Checks (vor MAIL FROM)             │
│                                                           │
│  Greylisting  →  DNSBL (Spamhaus/SpamCop)  →  GeoIP      │
│                                                           │
│  Greylisting: IP + MAIL FROM + RCPT TO als Redis-Tripel   │
│  → 5 Minuten Wartezeit beim ersten Versuch                │
│  → Nach erfolgreichem Retry: IP 30 Tage whitelisten       │
│                                                           │
│  DNSBL: Parallel-Lookup gegen konfigurierte Listen        │
│  → zen.spamhaus.org (SBL+XBL+PBL, Standard)              │
│  → bl.spamcop.net (Standard)                              │
│  → Eigene Listen konfigurierbar im ECP                    │
│                                                           │
│  GeoIP: MaxMind GeoLite2 → Länder-Whitelist/-Blacklist    │
└────────────────────────┬──────────────────────────────────┘
                         │
                         ▼
┌───────────────────────────────────────────────────────────┐
│  STUFE 2 — DNS & Sender-Authentifizierung (nach MAIL FROM)│
│                                                           │
│  SPF  →  DKIM  →  DMARC  →  ARC                          │
│                                                           │
│  Implementiert via mailauth (npm)                         │
│  DMARC-Policy: none (Header), quarantine, reject          │
└────────────────────────┬──────────────────────────────────┘
                         │
                         ▼
┌───────────────────────────────────────────────────────────┐
│  STUFE 3 — Adress-Blacklist (nach RCPT TO)                │
│                                                           │
│  Exakte Adresse  →  Wildcard (*@domain.com)  →  Regex     │
│  3 Ebenen: Global / Domain / User                         │
└────────────────────────┬──────────────────────────────────┘
                         │
                         ▼
┌───────────────────────────────────────────────────────────┐
│  STUFE 4 — Content-Filter (nach DATA)                     │
│                                                           │
│  ClamAV   →  rspamd  →  Attachment-Filter                 │
│                                                           │
│  ClamAV: INSTREAM-Protokoll (TCP 3310), Signatur-Update   │
│  rspamd: HTTP /checkv2, Bayes-Training via /learnspam     │
│  Spam-Score-Schwellenwerte (ECP-konfigurierbar):          │
│    < 3.0  → Posteingang                                   │
│    3–6    → Junk-Ordner                                   │
│    > 6.0  → Ablehnen (SMTP 550)                           │
│  Attachment: MIME-Typen-Blacklist, doppelte Erweiterungen │
└────────────────────────┬──────────────────────────────────┘
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
         Posteingang            Quarantäne
         oder Junk              + Admin-Alert
```

### TLS-Konfiguration

Alle externen Verbindungen werden TLS-verschlüsselt:

- **nginx**: TLSv1.2 + TLSv1.3, moderne Cipher-Suites
- **SMTP Port 465/993/995**: Implicit TLS
- **SMTP Port 587 / IMAP 143**: STARTTLS (Pflicht in Produktion)
- **LDAP**: LDAPS (Port 636) oder STARTTLS

### DKIM-Schlüsselverwaltung

DKIM-Schlüssel werden pro Domain in PostgreSQL gespeichert. Verwaltung über ECP:

```bash
# Neuen DKIM-Schlüssel generieren (2048-bit RSA)
openssl genrsa -out dkim_private.pem 2048
openssl rsa -in dkim_private.pem -pubout -out dkim_public.pem

# DNS-TXT-Record setzen:
# coremail._domainkey.meinedomain.de  TXT  "v=DKIM1; k=rsa; p=<public-key>"
```

---

## Authentifizierung

CoreMail unterstützt **drei Authentifizierungsquellen gleichzeitig** mit konfigurierbarer Priorität (Local → LDAP → SSO).

### Auth-Service-Endpunkte

| Endpunkt | Methode | Beschreibung |
|----------|---------|-------------|
| `/auth/login` | POST | Anmeldung (gibt accessToken oder MFA-Challenge zurück) |
| `/auth/mfa/verify` | POST | MFA-Code/WebAuthn/Backup-Code verifizieren |
| `/auth/refresh` | POST | Neuen Access-Token via Refresh-Token |
| `/auth/logout` | POST | Session invalidieren |
| `/auth/mfa/totp/setup` | POST | TOTP-Secret generieren + QR-Code |
| `/auth/mfa/totp/confirm` | POST | TOTP mit Code bestätigen (aktivieren) |
| `/auth/mfa/webauthn/register/start` | POST | WebAuthn-Registration starten |
| `/auth/mfa/webauthn/register/finish` | POST | WebAuthn-Registration abschließen |
| `/auth/mfa/backup-codes/generate` | POST | 10 neue Backup-Codes generieren |
| `/auth/app-passwords` | GET/POST/DELETE | App-Passwörter verwalten |
| `/auth/sessions` | GET/DELETE | Sessions anzeigen / beenden |

### Lokale Anmeldung

- Passwort-Hash: **bcrypt** (Cost Factor 12) + serverseitiger **pepper** (SHA-256 vorverarbeitet)
- Passwort-Richtlinien: Mindestlänge, Komplexität, Ablaufdatum (ECP-konfigurierbar)
- Konto-Sperrung: nach N Fehlversuchen (Standard: 5)
- Passwort-Reset: Token per E-Mail (TTL 1h) oder Admin-Reset über ECP

### LDAP / Active Directory

```yaml
# ECP → Organisation → Verzeichnisdienste
host: ldap.company.com
port: 636            # LDAPS (empfohlen) oder 389 + STARTTLS
baseDN: "dc=company,dc=com"
bindDN: "cn=coremail-bind,ou=serviceaccounts,dc=company,dc=com"
userFilter: "(sAMAccountName={{username}})"
attributeMap:
  email: "mail"
  displayName: "displayName"
  uid: "objectGUID"
```

**Verhalten:**
- Automatisches Anlegen/Synchronisieren des Users in PostgreSQL beim ersten LDAP-Login
- LDAP-Gruppen → CoreMail-Rollen-Mapping (konfigurierbar im ECP)
- Kein Passwort in PostgreSQL gespeichert (LDAP-User)
- Stündlicher Bulk-Sync + sofortige Sync-Option im ECP
- Unterstützt: Active Directory, OpenLDAP, FreeIPA

### SSO / OIDC

Unterstützte Provider (OIDC Discovery, Plug-and-Play):

| Provider | Protokoll | Konfiguration |
|----------|-----------|--------------|
| Microsoft Entra ID (Azure AD) | OIDC | Tenant-ID + Client-ID + Secret |
| Google Workspace | OIDC | Client-ID + Client-Secret |
| Keycloak (self-hosted) | OIDC | Realm-URL + Client-ID |
| Authentik (self-hosted) | OIDC | Server-URL + Client-ID |
| Okta | OIDC | Domain + Client-ID |
| Beliebiger SAML 2.0 IdP | SAML | IdP-Metadata-URL |

**OIDC-Flow:**
```
Benutzer klickt "Mit SSO anmelden"
    → GET /auth/oidc/start?providerId=<id>
    → Redirect zu IdP (state + nonce in Redis)
    → IdP-Login
    → Callback: GET /auth/oidc/callback?code=...&state=...
    → JWKS-Validierung des ID-Tokens
    → User anlegen/aktualisieren in PostgreSQL
    → CoreMail JWT ausgeben → OWA-Session
```

### Multi-Faktor-Authentifizierung (MFA)

| Methode | Bibliothek | Beschreibung |
|---------|-----------|-------------|
| **TOTP** | `otpauth` + `qrcode` | Google/Microsoft Authenticator, Authy — 6-stelliger Code, 30s |
| **WebAuthn / FIDO2** | `@simplewebauthn/server` | YubiKey, Touch ID, Windows Hello |
| **Backup-Codes** | `bcrypt` + crypto | 10 Einmal-Codes (Format: `XXXX-XXXX`, bcrypt-gehasht) |
| **E-Mail OTP** | SMTP-intern | Fallback-Code per E-Mail (deaktivierbar) |

**MFA-Durchsetzung (ECP-konfigurierbar):**
- Optional (User wählt selbst)
- Pflicht für Admin-Rollen (immer)
- Pflicht für bestimmte Domains
- Pflicht für AD-Gruppen

**MFA bei IMAP/POP3/SMTP (Outlook, Thunderbird):**

Da Outlook keine MFA über Basic Auth unterstützt, bietet CoreMail **App-Passwörter**:

```
1. OWA → Einstellungen → Sicherheit → "Neues App-Passwort"
   → Name eingeben (z.B. "Outlook auf MacBook")
   → Einmalig angezeigter Code: ABCD-1234-EF56-7890

2. In Outlook / Thunderbird:
   Server: mail.domain.de
   Benutzername: user@domain.de
   Passwort: ABCD-1234-EF56-7890   ← App-Passwort statt Hauptpasswort

3. MFA-Schutz für den Web-Zugriff bleibt vollständig aktiv
```

App-Passwörter sind bcrypt-gehasht und werden nie im Klartext gespeichert. Jedes Passwort kann einzeln widerrufen werden.

### Session-Management

Jede erfolgreiche Anmeldung erstellt eine Session (Refresh-Token in PostgreSQL):

```
GET  /auth/sessions         → Aktive Sessions mit IP, User-Agent, Erstellungsdatum
DELETE /auth/sessions/{id}  → Eigene Session beenden
DELETE /auth/sessions/admin/{userId}  → Admin: alle Sessions eines Users beenden (ECP)
```

---

## Weboberfläche (OWA)

Die Weboberfläche orientiert sich am Layout von **Coremail OWA** und ist in **React 19** implementiert.

### Layout (Webmail)

```
┌────────────────────────────────────────────────────────────────────┐
│  ≡  CoreMail     [🔍 Suche.....................] [🔔] [⚙] [?] [👤]│
├───────────────┬──────────────────────┬────────────────────────────┤
│ Ordner-Baum   │  Nachrichten-Liste   │  Lesebereich               │
│               │                      │                            │
│ 📥 Posteingang│ ● Max M.  Projekt..  │ Von: max@firma.de          │
│ 📝 Entwürfe 3 │   Re: Meeting  14:22 │ Betreff: Projekt Update    │
│ 📤 Gesendet   │ ● Anna S.  Update..  │                            │
│ 🗑 Gelöscht   │   Fwd: Bericht 13:55 │ [Antworten] [Allen] [→]   │
│ ⚠ Junk        │                      │ [Löschen] [Archiv] [...]  │
│ 📦 Archiv     │   ...virtualisiert..  │                            │
│               │                      │  Nachrichtentext...        │
│ Meine Ordner  │                      │                            │
│ 📁 Projekt A  │                      │  📎 Anhang.pdf  (234 KB)  │
│ 📁 Rechnung   │                      │                            │
│               │ [+ Neue E-Mail]      │                            │
│ ─ Navigation ─│                      │                            │
│ [✉][📅][👥][✓]│                      │                            │
└───────────────┴──────────────────────┴────────────────────────────┘
```

### Hauptfunktionen

- **Live-Updates**: Neue Mails erscheinen sofort ohne Seitenreload (SSE via Redis Pub/Sub)
- **Desktop-Benachrichtigungen**: Browser Notification API bei neuen Mails im Hintergrund
- **Schnellsuche**: Eingabe → Debounce 200ms → Ergebnis < 200ms (PostgreSQL GIN-Index)
- **Shared Mailboxen**: Freigegebene Postfächer in der Sidebar einhängen (wie Outlook)
- **Compose**: Rich-Text-Edtor (Tiptap), CC/BCC, Dateianhänge per Drag & Drop
- **Kalender**: Tag/Woche/Monat-Ansicht (FullCalendar), Drag & Drop, geteilte Kalender
- **Kontakte**: Globale Adressliste + persönliche Kontakte, Autovervollständigung beim Verfassen
- **Aufgaben**: Fälligkeitsdatum, Priorität, Status — synchronisiert mit Outlook-Aufgaben via EWS

### Technologie-Stack (Frontend)

| Paket | Zweck |
|-------|-------|
| React 19 + Vite | Framework + Build |
| TailwindCSS + shadcn/ui | Komponenten (Coremail-ähnlich) |
| TanStack Query v5 | Server-State, Caching, Auto-Refetch |
| TanStack Virtual | Virtualisierte Listen (10.000+ Mails) |
| Zustand | Client-State (aktiver Ordner, Compose) |
| Tiptap | Rich-Text-Editor |
| FullCalendar | Kalender-Komponente |
| EventSource API | SSE-Live-Updates |

---

## Admin-Panel (ECP)

Das Admin-Panel unter `/ecp/` orientiert sich an **Coremail ECP** und bietet dieselbe Gliederung.

### Sektionen

| Sektion | Inhalt |
|---------|--------|
| **Empfänger** | Postfächer, Verteilergruppen (statisch/dynamisch), Ressourcen (Räume/Equipment), Kontakte, Shared Mailboxen, Öffentliche Ordner, Migration |
| **Berechtigungen** | Admin-Rollen (RBAC), Benutzerrollen, Rollenzuweisungen |
| **Compliance** | eDiscovery, Aufbewahrungsrichtlinien, Journaling, Nachrichtenablaufverfolgung |
| **Organisation** | Freigaberichtlinien, Apps/Add-ins, Adresslisten (GAL), Einstellungen |
| **Schutz** | Malware-Filter (ClamAV), Verbindungsfilter (DNSBL/IP), Anti-Spam (rspamd), Quarantäne |
| **Nachrichtenfluss** | Transportregeln, Connectors, Akzeptierte Domains, E-Mail-Adressrichtlinien |
| **Mobile** | Gerätezugriffsrichtlinien, Geräteverwaltung (ActiveSync) |
| **Server** | Virtuelle Verzeichnisse, TLS-Zertifikate, Health-Dashboard |
| **Monitoring** | Queue-Monitor, Service-Konfiguration, Log-Viewer, System-Metriken |

### RBAC — Rollenbasierte Zugriffssteuerung

| Rolle | Berechtigungen |
|-------|---------------|
| `OrganizationManagement` | Vollzugriff auf alle ECP-Bereiche |
| `RecipientManagement` | Postfächer, Gruppen, Ressourcen, Shared Mailboxen |
| `ViewOnlyOrganization` | Nur-Lesen-Zugriff auf alle Einstellungen |
| `HelpDesk` | Passwort-Reset, Postfach-Status, Quota |
| `ComplianceManagement` | eDiscovery, Journaling, Aufbewahrung |
| `HygieneManagement` | Spam-/Malware-Filter, Quarantäne, Blacklists |
| `ServerManagement` | Services, Zertifikate, Queues, Logs |

### Monitoring-Dashboard

#### Queue-Monitor

Echtzeit-Ansicht der SMTP-Warteschlange (BullMQ):
- Ausstehende, aktive, fehlgeschlagene, abgeschlossene Jobs
- Einzelne Jobs neu starten, in Dead-Letter verschieben oder löschen
- Queue pausieren / fortsetzen

#### Log-Viewer

Durchsuchbarer Log-Stream mit Filterung nach Service, Level und Zeitraum:
- Log-Level pro Service live anpassen (kein Neustart nötig)
- Kategorien: `MAIL_FLOW`, `SECURITY`, `AUTH`, `QUEUE`, `SYSTEM`
- Export als CSV/JSON

---

## Backup & Wiederherstellung

### Server-seitiges Backup

| Methode | RPO | Technologie |
|---------|-----|-------------|
| WAL-Archivierung | < 5 Minuten | PostgreSQL + S3/MinIO |
| MinIO-Replikation | Kontinuierlich | MinIO Site Replication |
| Redis-Persistenz | < 1 Sekunde | AOF + stündlicher RDB-Snapshot |

Wiederherstellung über Point-in-Time Recovery (PITR):
```bash
# Auf Zeitpunkt 2026-05-01 14:30 wiederherstellen
pnpm --filter @coremail/backup-service restore \
  --target "2026-05-01T14:30:00Z" \
  --user user@domain.de
```

### User-Self-Service-Backup

Nutzer können ihr Postfach jederzeit über OWA → Einstellungen → Backup herunterladen:

| Format | Kompatibilität |
|--------|---------------|
| **MBOX** | Thunderbird, Apple Mail, mutt |
| **EML-ZIP** | Alle E-Mail-Clients (einzelne .eml-Dateien) |

Auswahl: ganzes Postfach / einzelne Ordner / Zeitraum. Der Export wird asynchron erstellt und per Benachrichtigung bereitgestellt.

### Admin-Vollbackup

Geplante Backups per Cron (täglich vollständig, stündlich inkrementell):

```env
# Backup-Ziel: S3-kompatibel (MinIO, AWS S3, Backblaze B2)
BACKUP_S3_ENDPOINT=https://s3.amazonaws.com
BACKUP_S3_BUCKET=coremail-backup
BACKUP_ENCRYPTION=true   # AES-256

# Retention-Policy
BACKUP_RETAIN_DAILY=7
BACKUP_RETAIN_WEEKLY=4
BACKUP_RETAIN_MONTHLY=12
```

### Gelöschte Mails wiederherstellen

E-Mails werden beim Löschen **30 Tage lang soft-deleted** (nur als gelöscht markiert, nicht wirklich entfernt). In dieser Zeit können sie über OWA oder das Admin-Panel wiederhergestellt werden.

---

## Cluster & Hochverfügbarkeit

Alle CoreMail-Services sind **stateless** — State liegt ausschließlich in PostgreSQL + Redis. Damit können beliebig viele Instanzen parallel betrieben werden.

### Docker Swarm (einfache HA)

```yaml
# docker-compose.yml Erweiterung
services:
  smtp-server:
    deploy:
      replicas: 3
      restart_policy:
        condition: on-failure
```

### Kubernetes (Produktions-HA)

```bash
# Helm-Chart installieren
helm install coremail ./infra/k8s/helm \
  --set mailHostname=mail.domain.de \
  --set postgres.replicas=3 \
  --set redis.cluster.enabled=true
```

| Komponente | HA-Strategie |
|-----------|-------------|
| CoreMail-Services | Deployment + HPA (min 2, max 10 Pods) |
| PostgreSQL | CloudNativePG: Primary + 2 Read Replicas, auto-failover |
| Redis | Bitnami Redis Cluster: 3 Master + 3 Replicas |
| MinIO | Distributed Mode: 4+ Nodes, Erasure Coding |
| nginx | Deployment mit 2 Replicas hinter Service |

### PodDisruptionBudget

```yaml
# Immer mindestens 1 Pod pro Service verfügbar
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: coremail-smtp
```

---

## Monitoring & Logs

### Observability-Stack

```
CoreMail-Services
      │
      ▼ OpenTelemetry SDK
  OTLP Collector
      ├──▶ Prometheus (Metriken)
      ├──▶ Tempo (Traces)
      └──▶ Loki (Logs)
              │
              ▼
          Grafana Dashboard
```

### Prometheus-Metriken

Jeder Service exponiert Metriken unter `/metrics`:

| Metrik | Beschreibung |
|--------|-------------|
| `coremail_smtp_messages_total` | Empfangene Mails gesamt |
| `coremail_smtp_rejected_total` | Abgelehnte Mails (mit Grund) |
| `coremail_queue_depth` | Aktuelle Outbound-Queue-Tiefe |
| `coremail_imap_connections_active` | Aktive IMAP-Verbindungen |
| `coremail_spam_score_histogram` | Spam-Score-Verteilung |
| `coremail_storage_bytes_total` | Gespeichertes Mailvolumen |

### Log-Formate

```json
// Produktion (JSON — maschinenlesbar)
{"level":"info","time":1715271123456,"service":"smtp:inbound","from":"user@example.com","to":"local@domain.de","size":45231,"msg":"Message stored"}

// Entwicklung (farbige Ausgabe)
14:22:31 INFO smtp:inbound — Message stored { from: 'user@example.com', size: 45231 }
```

---

## Entwicklung

### Repository-Struktur

```
CoreMail/
├── packages/
│   ├── core/              # Gemeinsame Bibliothek
│   ├── storage/           # Prisma + MinIO + MIME
│   ├── security-filter/   # Mail-Security-Pipeline
│   ├── smtp-server/       # SMTP Inbound + Outbound
│   ├── imap-server/       # IMAP4rev1 + IDLE
│   ├── pop3-server/       # POP3
│   ├── auth-service/      # Auth: Lokal + LDAP + OIDC + MFA
│   ├── auth-ldap/         # LDAP/AD-Connector
│   ├── auth-sso/          # OIDC/OAuth2/SAML-Connector
│   ├── ews-server/        # EWS (EWS Web Services)
│   ├── autodiscover/      # Autodiscover v1 + v2 (inkl. ActiveSync)
│   ├── caldav-server/     # CalDAV + CardDAV
│   ├── api-gateway/       # REST + SSE + S/MIME API
│   ├── activesync/        # ActiveSync EAS 14.1
│   ├── backup-service/    # Backup + Restore
│   ├── web-client/        # React OWA-UI
│   └── admin-panel/       # React ECP-UI
├── infra/
│   ├── docker/            # Docker Compose + Dockerfiles + nginx
│   ├── k8s/               # Kubernetes Helm Chart
│   ├── observability/     # Prometheus, Grafana, Tempo, Loki, Alertmanager
│   └── postgres/          # Migrations, Init-SQL
├── CLAUDE.md              # Projektgedächtnis für Claude Code
└── docs/
    ├── ews-protocol/      # EWS SOAP-Dokumentation
    └── api/               # OpenAPI-Spezifikation
```

### Entwicklungsworkflow

```bash
# 1. Infrastruktur starten
pnpm docker:up -- postgres redis minio clamav rspamd

# 2. Datenbank initialisieren
pnpm db:migrate

# 3. Einzelnes Paket im Watch-Modus bauen
pnpm --filter @coremail/smtp-server dev

# 4. Alle TypeScript-Pakete prüfen
pnpm typecheck

# 5. Linting
pnpm lint

# 6. Tests ausführen
pnpm test

# 7. Prisma Studio (Datenbank-Browser)
pnpm --filter @coremail/storage prisma:studio
```

### Neues Paket hinzufügen

```bash
# Verzeichnis anlegen
mkdir -p packages/my-module/src

# package.json + tsconfig.json analog zu bestehenden Paketen erstellen
# tsconfig.json Referenz in root tsconfig.json eintragen
# Service in docker-compose.yml eintragen
# Dockerfile erstellen (Vorlage von smtp-server kopieren)
```

### Datenbankmigrationen

```bash
# Migration nach Schema-Änderungen erstellen
pnpm db:migrate -- --name "add-calendar-acl"

# Prisma Client neu generieren
pnpm db:generate

# Schema direkt anwenden (nur Entwicklung, keine Migration)
pnpm db:push
```

---

## Deployment (Docker)

Detaillierte Anleitung für den Docker-Betrieb (inkl. Synology NAS, Heimserver, Produktion):

📄 **[docs/deployment-docker.md](docs/deployment-docker.md)**

---

## Deployment (Kubernetes)

### Voraussetzungen

- Kubernetes 1.28+
- Helm 3.x
- `cert-manager` für automatische TLS-Zertifikate
- `CloudNativePG` Operator für PostgreSQL HA
- Ingress Controller (nginx-ingress empfohlen)

### Installation

```bash
# Operators installieren
helm install cnpg cloudnative-pg/cloudnative-pg -n cnpg-system --create-namespace
helm install cert-manager jetstack/cert-manager -n cert-manager --create-namespace \
  --set installCRDs=true

# CoreMail installieren
helm install coremail ./infra/k8s/helm \
  --namespace coremail \
  --create-namespace \
  --set global.mailHostname=mail.meinedomain.de \
  --set global.storageClass=standard \
  --set postgres.storage=50Gi \
  --set minio.storage=500Gi
```

### DNS-Einträge (Pflicht)

```
; A-Records
mail.domain.de.           A     <Server-IP>
autodiscover.domain.de.   A     <Server-IP>

; MX-Record
domain.de.                MX 10 mail.domain.de.

; SPF
domain.de.                TXT   "v=spf1 mx -all"

; DKIM (aus ECP kopieren)
coremail._domainkey.domain.de. TXT "v=DKIM1; k=rsa; p=<public-key>"

; DMARC
_dmarc.domain.de.         TXT   "v=DMARC1; p=reject; rua=mailto:dmarc@domain.de"

; Autodiscover SRV (für ältere Outlook-Versionen)
_autodiscover._tcp.domain.de. SRV 0 0 443 mail.domain.de.
```

---

## URL-Struktur

CoreMail verwendet **Coremail-kompatible URL-Pfade** — bestehende Outlook-Konfigurationen funktionieren ohne Änderungen.

| URL | Service | Beschreibung |
|-----|---------|-------------|
| `/owa/` | `web-client` | Outlook Web Access (Webmail) |
| `/ecp/` | `admin-panel` | Coremail Admin-Panel (ECP) |
| `/EWS/Exchange.asmx` | `ews-server` | Web Services EWS (SOAP) |
| `/mapi/` | `ews-server` | MAPI over HTTP (Outlook 2016+) |
| `/Autodiscover/Autodiscover.xml` | `autodiscover` | Autodiscover v1 |
| `/autodiscover/autodiscover.json/v1.0/` | `autodiscover` | Autodiscover v2 |
| `/OAB/` | `ews-server` | Offline Address Book |
| `/Microsoft-Server-ActiveSync` | `activesync` | ActiveSync EAS 14.1 (iOS, Android, Outlook Mobile) |
| `/PowerShell/` | `api-gateway` | PowerShell-Remoting (EMS mit 20+ Cmdlets) |
| `/api/v1/` | `api-gateway` | CoreMail REST-API |
| `/api/v1/public-folders/` | `api-gateway` | Öffentliche Ordner (User-Zugriff) |
| `/api/v1/admin/groups/` | `api-gateway` | Verteilergruppen-Verwaltung |
| `/api/v1/admin/resources/` | `api-gateway` | Raum-/Ressourcenpostfächer |
| `/api/v1/admin/public-folders/` | `api-gateway` | Öffentliche Ordner (Admin) |
| `/api/v1/admin/ediscovery/` | `api-gateway` | eDiscovery-Suchen & Legal Hold |
| `/api/v1/admin/ems/` | `api-gateway` | EMS REST-Bridge (Cmdlet-Dispatcher) |
| `/health` | `api-gateway` | Health-Check-Endpunkt |

---

## Roadmap

| Phase | Inhalt | Version | Status |
|-------|--------|---------|--------|
| **Phase 1** | Monorepo, Core (JWT/bcrypt/Redis), Storage (Prisma/MinIO/MIME), Docker Compose | — | ✅ Abgeschlossen |
| **Phase 2** | Security-Filter (DNSBL/Greylisting/GeoIP/ClamAV/rspamd), SMTP Inbound+Outbound, IMAP4rev1+IDLE+CONDSTORE | — | ✅ Abgeschlossen |
| **Phase 3** | EWS SOAP/XML (13 Operationen), Autodiscover v1+v2, Auth-Service (Local/LDAP/OIDC/MFA/App-Passwörter) | — | ✅ Abgeschlossen |
| **Phase 4** | CalDAV (RFC 4791) + CardDAV (RFC 6352), REST API-Gateway (SSE/WebSocket), React OWA-Webclient, React ECP-Admin-Panel | — | ✅ Abgeschlossen |

---

## Mitwirken

Beiträge sind herzlich willkommen! Bitte lies zunächst die Contribution Guidelines (folgen in Kürze).

```bash
# Fork → Branch erstellen
git checkout -b feature/mein-feature

# Änderungen + Tests
pnpm test
pnpm typecheck
pnpm lint

# Pull Request öffnen
```

---

## Lizenz

MIT License — siehe [LICENSE](LICENSE)

---

<div align="center">
  <sub>Entwickelt mit ❤️ als Coremail der OpenSource Mailserver für kleine Umgebungen</sub>
</div>
