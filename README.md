# CoreMail

Open-Source-Alternative zu Microsoft Exchange 2019 — aufgebaut auf React + Node.js/TypeScript.

## Features

- **Email**: SMTP, IMAP4rev1, POP3, EWS (Outlook Desktop), OWA (Webmail)
- **Calendaring**: CalDAV, geteilte Kalender, Besprechungsanfragen, Raumbuchung, Frei/Gebucht
- **Collaboration**: Shared Mailboxen, Verteilergruppen, Kontakte (CardDAV), Aufgaben, Notizen
- **Security**: DNSBL, Greylisting, Country-Filtering, SPF/DKIM/DMARC, ClamAV, rspamd
- **Auth**: Lokal, LDAP/Active Directory, SSO (OIDC/OAuth2), MFA (TOTP, WebAuthn)
- **Admin**: ECP-ähnliches Panel, Queue-Monitor, Log-Viewer, Service-Konfiguration
- **Backup**: PITR (WAL), User-MBOX/EML-Export, Admin-Vollbackup zu S3

## Schnellstart

```bash
# 1. Repository klonen
git clone https://github.com/your-org/coremail.git
cd coremail

# 2. Abhängigkeiten installieren
pnpm install

# 3. Konfiguration
cp .env.example .env
# → .env bearbeiten und Werte setzen

# 4. Basisstack starten
docker compose -f infra/docker/docker-compose.yml up -d postgres redis minio

# 5. Datenbank initialisieren
pnpm db:migrate

# 6. Alle Services starten
docker compose -f infra/docker/docker-compose.yml up -d
```

## URL-Struktur

| URL | Beschreibung |
|-----|-------------|
| `https://mail.domain.com/owa/` | Webmail (OWA) |
| `https://mail.domain.com/ecp/` | Admin-Panel (ECP) |
| `https://mail.domain.com/EWS/Exchange.asmx` | Exchange Web Services |
| `https://mail.domain.com/Autodiscover/` | Autodiscover (Outlook) |

## Architektur

```
packages/
├── core/             JWT, Redis, Types, Logger
├── storage/          Prisma-Schema, MinIO, MIME-Parser
├── auth-service/     Lokale Auth, LDAP, OIDC, MFA
├── auth-ldap/        LDAP/AD-Integration
├── auth-sso/         OIDC/OAuth2/SAML SSO
├── security-filter/  DNSBL, Greylisting, SPF/DKIM, ClamAV, rspamd
├── smtp-server/      SMTP Inbound + Outbound
├── imap-server/      IMAP4rev1
├── pop3-server/      POP3
├── ews-server/       Exchange Web Services (SOAP)
├── autodiscover/     Autodiscover v1 + v2
├── caldav-server/    CalDAV + CardDAV
├── api-gateway/      REST + SSE + WebSocket
├── backup-service/   Backup + Restore
├── web-client/       React OWA-UI
└── admin-panel/      React ECP-UI
```

## Entwicklung

```bash
# Einzelnes Package entwickeln
pnpm --filter @coremail/core dev
pnpm --filter @coremail/storage dev

# Alle Packages bauen
pnpm build

# Tests
pnpm test

# Linting
pnpm lint
```

## Lizenz

MIT
