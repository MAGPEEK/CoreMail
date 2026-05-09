# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

---

## [Unreleased]

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
