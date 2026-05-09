# CoreMail

> Open-Source-Alternative zu Microsoft Exchange 2019 — aufgebaut auf **React + Node.js/TypeScript**, container-first, modular und vollständig selbst gehostet.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org)
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
6. [Konfiguration](#konfiguration)
7. [Module im Detail](#module-im-detail)
8. [Mail-Protokolle](#mail-protokolle)
9. [Sicherheit & Anti-Spam](#sicherheit--anti-spam)
10. [Authentifizierung](#authentifizierung)
11. [Weboberfläche (OWA)](#weboberfläche-owa)
12. [Admin-Panel (ECP)](#admin-panel-ecp)
13. [Backup & Wiederherstellung](#backup--wiederherstellung)
14. [Cluster & Hochverfügbarkeit](#cluster--hochverfügbarkeit)
15. [Monitoring & Logs](#monitoring--logs)
16. [Entwicklung](#entwicklung)
17. [Deployment (Kubernetes)](#deployment-kubernetes)
18. [URL-Struktur](#url-struktur)
19. [Roadmap](#roadmap)
20. [Lizenz](#lizenz)

---

## Über das Projekt

**CoreMail** bietet vollständige funktionale Parität mit Microsoft Exchange 2019 in den Bereichen **E-Mail, Kalender und Zusammenarbeit** — ohne Lizenzkosten, ohne Vendor Lock-in, mit voller Datensouveränität.

Das Projekt ist für Klein- und Mittelunternehmen mit **10–500 Benutzern** ausgelegt und kann sowohl als einzelner Docker-Stack als auch als hochverfügbares Kubernetes-Cluster betrieben werden.

### Warum CoreMail?

| Kriterium | Microsoft Exchange 2019 | CoreMail |
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
| EWS — Exchange Web Services (Outlook Desktop) | 🔧 Phase 3 |
| Autodiscover v1 + v2 (Outlook-Autokonfiguration) | 🔧 Phase 3 |
| OWA — Outlook Web Access (Webmail) | 🔧 Phase 4 |
| Freigegebene Postfächer (Shared Mailboxen) | 🔧 Phase 4 |
| Öffentliche Ordner | 🔧 Phase 4 |
| Verteilergruppen & dynamische Gruppen | 🔧 Phase 4 |
| Raum- und Gerätepostfächer | 🔧 Phase 4 |
| Abwesenheitsassistent (Out of Office) | 🔧 Phase 4 |
| Posteingangsregeln (Transport Rules) | 🔧 Phase 4 |
| Volltextsuche (PostgreSQL GIN-Index, < 200 ms) | 🔧 Phase 4 |

### Kalender & Zusammenarbeit

| Feature | Status |
|---------|--------|
| Persönlicher Kalender | 🔧 Phase 4 |
| Geteilte Teamkalender | 🔧 Phase 4 |
| Besprechungsanfragen (iCal-Standard) | 🔧 Phase 4 |
| Frei/Gebucht-Abfrage (GetUserAvailability) | 🔧 Phase 4 |
| Raum- und Ressourcenbuchung | 🔧 Phase 4 |
| CalDAV (iOS, Android, Thunderbird) | 🔧 Phase 4 |
| Kontakte (CardDAV) | 🔧 Phase 4 |
| Aufgaben / To-Do (EWS-sync) | 🔧 Phase 4 |
| Notizen | 🔧 Phase 4 |
| Globale Adressliste (GAL) | 🔧 Phase 4 |

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
| TLS (STARTTLS + Implicit TLS) | ✅ Implementiert |

### Authentifizierung

| Feature | Status |
|---------|--------|
| Lokale Anmeldung (bcrypt + pepper) | 🔧 Phase 3 |
| LDAP / Active Directory | 🔧 Phase 3 |
| SSO via OIDC / OAuth2 (Azure AD, Keycloak, Google) | 🔧 Phase 3 |
| SAML 2.0 | 🔧 Phase 3 |
| MFA: TOTP (Authenticator-App) | 🔧 Phase 3 |
| MFA: WebAuthn / FIDO2 (YubiKey, Touch ID) | 🔧 Phase 3 |
| App-Passwörter für Mail-Clients | 🔧 Phase 3 |
| Session-Management (Admin-seitig) | 🔧 Phase 3 |

### Administration

| Feature | Status |
|---------|--------|
| ECP Admin-Panel (Exchange Control Panel) | 🔧 Phase 4 |
| RBAC (7 Rollen, Exchange-kompatibel) | 🔧 Phase 4 |
| SMTP Queue-Monitor (live) | 🔧 Phase 4 |
| Service-Konfiguration (live, kein Neustart) | 🔧 Phase 4 |
| Log-Viewer mit Log-Level pro Service | 🔧 Phase 4 |
| Backup: User-MBOX/EML-Export (Self-Service) | 🔧 Phase 5 |
| Backup: Admin-Vollbackup zu S3 (PITR) | 🔧 Phase 5 |
| Kubernetes Helm Chart (HPA, HA) | 🔧 Phase 5 |

---

## Architektur

CoreMail folgt dem **Container-first, Microservice-Prinzip**: Jedes Modul ist ein eigenständiger Container mit eigenem Dockerfile. Module kommunizieren ausschließlich über REST-APIs, Redis Pub/Sub oder die Queue — nie direkt über gemeinsamen Code zur Laufzeit.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        nginx Reverse Proxy                               │
│         TLS-Termination · Rate-Limiting · Exchange-URL-Routing          │
└────┬──────┬────────┬───────┬──────┬──────┬────────┬─────────┬──────────┘
     │      │        │       │      │      │        │         │
     ▼      ▼        ▼       ▼      ▼      ▼        ▼         ▼
  [EWS]  [API-GW] [OWA]  [ECP]  [Auto- [Cal-  [Backup]  [Auth-
  :8080  :3000   :4000  :4001  disc.] DAV]   :8085    Service]
                               :8081  :8082            :3003

  SMTP(:25/465/587)     IMAP(:143/993)     POP3(:110/995)

  ┌─────────────────────────────────────────────────────────────┐
  │              Gemeinsame Infrastruktur                        │
  │  PostgreSQL 16 · Redis 7 · MinIO · rspamd · ClamAV · GeoIP │
  └─────────────────────────────────────────────────────────────┘
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

### 1. Repository klonen

```bash
git clone https://github.com/MAGPEEK/CoreMail.git
cd CoreMail
```

### 2. Abhängigkeiten installieren

```bash
corepack enable
pnpm install
```

### 3. Konfiguration erstellen

```bash
cp .env.example .env
```

Mindest-Pflichtfelder in `.env` anpassen:

```env
MAIL_HOSTNAME=mail.meinedomain.de
POSTGRES_PASSWORD=sicheres-passwort-hier
REDIS_PASSWORD=redis-passwort-hier
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=minio-passwort-hier
JWT_SECRET=mindestens-32-zeichen-langer-zufaelliger-string
PEPPER=mindestens-32-zeichen-langer-zufaelliger-string-2
```

Zufällige Secrets generieren:
```bash
openssl rand -hex 32   # für JWT_SECRET
openssl rand -hex 32   # für PEPPER
```

### 4. Infrastruktur starten

```bash
# Nur Datenbank, Redis und MinIO (für Entwicklung)
pnpm docker:up -- postgres redis minio

# Warten bis PostgreSQL bereit ist
docker compose -f infra/docker/docker-compose.yml exec postgres \
  pg_isready -U coremail
```

### 5. Datenbank initialisieren

```bash
pnpm db:migrate
```

### 6. Alle Services starten

```bash
# Vollständiger Stack
pnpm docker:up

# Oder mit optionalen Modulen (POP3, CalDAV, Backup)
docker compose -f infra/docker/docker-compose.yml \
  --profile full up -d
```

### 7. Zugriff

| URL | Beschreibung |
|-----|-------------|
| `https://localhost/owa/` | Webmail (OWA) |
| `https://localhost/ecp/` | Admin-Panel |
| `https://localhost/EWS/Exchange.asmx` | EWS-Endpunkt |
| `http://localhost:9001` | MinIO-Konsole |

> **Hinweis:** Für Localhost-Entwicklung selbstsigniertes Zertifikat unter `infra/docker/nginx/certs/` ablegen.

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

- **Prisma-Schema**: 22 Entitäten — User, Domain, Mailbox, Folder, Message, Attachment, SharedMailbox, Calendar, CalendarEvent, Contact, Task, Note, BackupJob, SystemLog, Quarantine, Blacklist, Session, UserMfa, AppPassword, LdapConfig, OidcProvider, SharedMailboxPerm
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

### `packages/imap-server`
IMAP4rev1-Server (Port 143 / 993).

- **RFC 3501**: CAPABILITY, LOGIN, AUTHENTICATE, SELECT, EXAMINE, LIST, FETCH, STORE, EXPUNGE, COPY, LOGOUT, NOOP
- **IDLE (RFC 2177)**: Redis-Subscription → sofortiger Push bei neuer Mail im ausgewählten Ordner
- **CONDSTORE**: HIGHESTMODSEQ-Tracking, MODSEQ in FETCH-Antworten, ENABLE CONDSTORE
- **Authentifizierung**: Hauptpasswort (bcrypt+pepper) oder App-Passwort (MFA-kompatibel)

### `packages/pop3-server` *(Phase 2 — optional)*
POP3-Server (Port 110 / 995) — RFC 1939 mit UIDL, TOP, CAPA, STLS.

### `packages/ews-server` *(Phase 3)*
Exchange Web Services SOAP/XML-Endpunkt (`/EWS/Exchange.asmx`).

Implementiert alle für Outlook-Kompatibilität notwendigen EWS-Operationen:
`FindItem`, `GetItem`, `CreateItem`, `UpdateItem`, `DeleteItem`, `SyncFolderHierarchy`, `SyncFolderItems`, `StreamingSubscription`, `GetUserAvailability`, `ResolveNames`.

### `packages/autodiscover` *(Phase 3)*
Autodiscover-Service (`/Autodiscover/` und `/autodiscover/`) — ermöglicht Outlook die automatische Serverkonfiguration ohne manuelle Eingabe.

### `packages/auth-service` *(Phase 3)*
Zentraler Authentifizierungsservice — koordiniert lokale Auth, LDAP/AD-Sync und OIDC/SSO-Flows.

### `packages/caldav-server` *(Phase 4)*
CalDAV (RFC 4791) + CardDAV (RFC 6352) für mobile Clients (iOS, Android, Thunderbird).

### `packages/api-gateway` *(Phase 4)*
REST-API + SSE + WebSocket-Gateway für den Web-Client.

### `packages/web-client` *(Phase 4)*
React 19 OWA-UI — identisches Layout wie Exchange 2019 OWA.

### `packages/admin-panel` *(Phase 4)*
React 19 ECP-UI — Exchange Control Panel-ähnliche Admin-Oberfläche.

### `packages/backup-service` *(Phase 5)*
Backup- und Wiederherstellungsservice — MBOX/EML-Export, Admin-Vollbackup zu S3.

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

### EWS (Exchange Web Services)

Outlook Desktop (2010–2024) und Outlook für Mac kommunizieren via EWS:

```
POST https://mail.domain.de/EWS/Exchange.asmx
Content-Type: text/xml; charset=utf-8
Authorization: Basic <base64>

<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Body>
    <m:FindItem Traversal="Shallow">
      ...
    </m:FindItem>
  </soap:Body>
</soap:Envelope>
```

**Autodiscover** — Outlook erkennt den Server automatisch:
```
GET https://mail.domain.de/autodiscover/autodiscover.json/v1.0/user@domain.de?Protocol=EWS
→ { "Protocol": "EWS", "Url": "https://mail.domain.de/EWS/Exchange.asmx" }
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

CoreMail unterstützt **drei Authentifizierungsquellen** — gleichzeitig aktivierbar mit konfigurierbarer Priorität.

### Lokale Anmeldung

- Passwort-Hash: bcrypt (Cost 12) + pepper
- Passwort-Richtlinien: Mindestlänge, Komplexität, Ablaufdatum (ECP-konfigurierbar)
- Konto-Sperrung: nach N Fehlversuchen (Standard: 5)

### LDAP / Active Directory

```yaml
# ECP → Organisation → Verzeichnisdienste
host: ldap.company.com
port: 636            # LDAPS
baseDN: "dc=company,dc=com"
bindDN: "cn=coremail-bind,ou=serviceaccounts,dc=company,dc=com"
userFilter: "(sAMAccountName={{username}})"
attributeMap:
  email: "mail"
  displayName: "displayName"
```

AD-Gruppen werden automatisch auf CoreMail-Rollen gemappt (konfigurierbar im ECP).

### SSO / OIDC

Unterstützte Provider:

| Provider | Protokoll |
|----------|-----------|
| Microsoft Entra ID (Azure AD) | OIDC |
| Google Workspace | OIDC |
| Keycloak (self-hosted) | OIDC |
| Authentik (self-hosted) | OIDC |
| Okta | OIDC |
| Beliebiger SAML 2.0 IdP | SAML |

### Multi-Faktor-Authentifizierung (MFA)

| Methode | Beschreibung |
|---------|-------------|
| **TOTP** | Google Authenticator, Microsoft Authenticator, Authy |
| **WebAuthn / FIDO2** | YubiKey, Touch ID, Windows Hello |
| **Backup-Codes** | 10 Einmal-Codes für Notfälle |
| **E-Mail OTP** | Fallback-Methode (deaktivierbar) |

### App-Passwörter für Mail-Clients

Da Outlook und Thunderbird über IMAP/SMTP keine MFA unterstützen, bietet CoreMail **App-Passwörter** (wie Google/Microsoft):

1. In OWA → Einstellungen → Sicherheit → App-Passwort erstellen
2. Einmal angezeigten Code in Outlook/Thunderbird eintragen
3. MFA-Schutz bleibt für den Web-Zugriff aktiv

---

## Weboberfläche (OWA)

Die Weboberfläche orientiert sich am Layout von **Exchange 2019 OWA** und ist in **React 19** implementiert.

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
| TailwindCSS + shadcn/ui | Komponenten (Exchange-ähnlich) |
| TanStack Query v5 | Server-State, Caching, Auto-Refetch |
| TanStack Virtual | Virtualisierte Listen (10.000+ Mails) |
| Zustand | Client-State (aktiver Ordner, Compose) |
| Tiptap | Rich-Text-Editor |
| FullCalendar | Kalender-Komponente |
| EventSource API | SSE-Live-Updates |

---

## Admin-Panel (ECP)

Das Admin-Panel unter `/ecp/` orientiert sich an **Exchange 2019 ECP** und bietet dieselbe Gliederung.

### Sektionen

| Sektion | Inhalt |
|---------|--------|
| **Empfänger** | Postfächer, Verteilergruppen, Ressourcen, Kontakte, Shared Mailboxen, Migration |
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
│   ├── ews-server/        # EWS (Exchange Web Services)
│   ├── autodiscover/      # Autodiscover v1 + v2
│   ├── caldav-server/     # CalDAV + CardDAV
│   ├── api-gateway/       # REST + SSE + WebSocket
│   ├── backup-service/    # Backup + Restore
│   ├── web-client/        # React OWA-UI
│   └── admin-panel/       # React ECP-UI
├── infra/
│   ├── docker/            # Docker Compose + Dockerfiles
│   ├── k8s/               # Kubernetes Helm Chart
│   └── postgres/          # Migrations, Init-SQL
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

CoreMail verwendet **Exchange 2019-kompatible URL-Pfade** — bestehende Outlook-Konfigurationen funktionieren ohne Änderungen.

| URL | Service | Beschreibung |
|-----|---------|-------------|
| `/owa/` | `web-client` | Outlook Web Access (Webmail) |
| `/ecp/` | `admin-panel` | Exchange Control Panel |
| `/EWS/Exchange.asmx` | `ews-server` | Exchange Web Services (SOAP) |
| `/mapi/` | `ews-server` | MAPI over HTTP (Outlook 2016+) |
| `/Autodiscover/Autodiscover.xml` | `autodiscover` | Autodiscover v1 |
| `/autodiscover/autodiscover.json/v1.0/` | `autodiscover` | Autodiscover v2 |
| `/OAB/` | `ews-server` | Offline Address Book |
| `/Microsoft-Server-ActiveSync` | `activesync` | ActiveSync (Phase 6) |
| `/api/v1/` | `api-gateway` | CoreMail REST-API |
| `/health` | `api-gateway` | Health-Check-Endpunkt |

---

## Roadmap

| Phase | Inhalt | Status |
|-------|--------|--------|
| **Phase 1** | Monorepo, Core, Storage, Docker Compose | ✅ Abgeschlossen |
| **Phase 2** | Security-Filter, SMTP, IMAP4rev1 | ✅ Abgeschlossen |
| **Phase 3** | EWS, Autodiscover, Auth (LDAP/OIDC/MFA) | 🔧 In Arbeit |
| **Phase 4** | CalDAV, REST-API, OWA (React), ECP (React) | 📅 Geplant |
| **Phase 5** | Backup-Service, Kubernetes Helm Chart, Observability | 📅 Geplant |
| **Phase 6** | ActiveSync, S/MIME, PowerShell-Remoting-Stub | 📅 Geplant |

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
  <sub>Entwickelt mit ❤️ als Open-Source-Alternative zu Microsoft Exchange</sub>
</div>
