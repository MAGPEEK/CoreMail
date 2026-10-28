# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

> **Note:** For readability, only the three most recent releases are listed here.
> The complete history of all older versions is available via the git history:
> `git log -p --follow CHANGELOG.md` or via the GitHub repository.

---

## [Unreleased]

---

## [5.9.0] — 2026-10-28 — English-only repository

### Changed

- **Everything on GitHub is English now**: `README.md` (German version kept as
  `README.de.md` with a language switch at the top), `CHANGELOG.md` including the full
  history, `CLAUDE.md`, `COMMANDS.md`, `docs/**` (JMAP, CLI, Docker deployment, release
  notes), all code comments in every package (`packages/*/src`, Prisma schema), and all
  infrastructure comments (`docker-compose*.yml`, `Dockerfile.app`, supervisord, entrypoint,
  rspamd/nginx configs, scripts, GitHub workflow, `.env.example`).
- **Admin CLI output is English** (`coremail …` messages, table headers, help texts,
  prompts). The `--yes`/`-y` flag and all command names are unchanged.
- **Developer-facing log messages (pino) and test names are English** in all services.
  Not changed on purpose: HTTP API response texts, SMTP/IMAP/POP3 protocol strings,
  texts persisted to the database, mail/DSN content and the MWA/BCP i18n values.
- `docker-compose.yml`: the `${VAR:?…}` guard messages for the five required `.env`
  values are English.
- No functional changes: UI strings of MWA/BCP (i18n DE/EN) and API response texts are
  untouched. The image tag for this release is `magpeek/coremail-app:5.9.0`; it also
  contains everything from 5.8.0 (admin CLI, new Docker Compose, EWS tied to the MAPI
  switch), which did not get its own image.

### Security

- `CLAUDE.md`: removed a plaintext SSH root password of the live server from the
  repository (rotate the password on the host).

---

## [5.8.0] — 2026-10-28 — Admin CLI `coremail`, new Docker Compose, EWS tied to MAPI

### Added

**Admin CLI `coremail`** — new package `packages/cli/` (commander), installed in the app image as
`/usr/local/bin/coremail` (`docker exec -it coremail coremail --help`).
Talks to the same REST admin API as the BCP → same role checks, same audit log.

| Group | Commands |
|--------|---------|
| `login` / `logout` / `whoami` | Admin login with password + MFA (TOTP/backup code), session in `~/.config/coremail/credentials.json` (0600), automatic token refresh; alternatively `COREMAIL_TOKEN` or `COREMAIL_ADMIN_EMAIL`/`_PASSWORD`/`_TOTP` |
| `user` | `list [--domain] [--inactive]`, `show`, `create --name [--password] [--role] [--quota] [--domain]`, `update [--name|--role|--quota|--enable|--disable]`, `set-password`, `delete [--yes]` |
| `mailbox` | `list [--sort used|quota|email]`, `show` (folders + counters), `quota <size>`, `recalculate [user]` |
| `shared` | `list`, `show`, `create --name [--quota]`, `grant <shared> <user> <perms…>`, `revoke`, `delete` |
| `domain` | `list` |
| `connector` | `status` (SMTP/SMTP-Send/IMAP/POP3 listeners + JMAP + MAPI/EWS), `enable|disable <svc> [--port]`, `listener list|add|set|delete|restore-defaults` |
| `smtp banner` | `show`, `set <text>`, `reset` |
| `cert` | `list`, `show`, `self-signed --domains [--services] [--days]`, `letsencrypt --domains --email [--services] [--staging] [--no-auto-renew]`, `activate --https/--protocol`, `deactivate-https`, `renew`, `delete` |

- Global options `--server <url>`, `--json`; delete commands prompt for confirmation (`--yes` for scripts);
  exit code 1 on errors with HTTP status. Sizes as `5GB`/`500MB`.
- Docs: `docs/cli.md`; README section "Admin CLI".

### Changed

- **`infra/docker/docker-compose.yml` rewritten**: only the parameters the stack
  actually needs (internal service URLs/ports have defaults in the image). The five
  required values (`JWT_SECRET`, `PEPPER`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD`,
  `MINIO_ROOT_PASSWORD`) are checked with `${VAR:?…}` → `docker compose up` aborts with
  a meaningful message instead of starting half-way. Header comment with 3-step guide,
  port overview, volume explanation; `COREMAIL_VERSION`, `TZ` as variables; MinIO console
  still bound to `127.0.0.1` only.
- **`.env.example` new**: required (5 values) clearly separated from optional, everything optional commented out.
- **`scripts/setup.sh` new**: checks Docker/openssl, generates `.env` with `openssl rand`
  (chmod 600), symlinks it next to the Compose file, shows the next steps.
  Old nginx dev-certificate steps removed.
- **EWS tied to the MAPI switch**: `/EWS/Exchange.asmx` and `/OAB/*` return 404
  as long as `ServerSettings.mapiHttpEnabled` is off (default). Autodiscover v2
  `?Protocol=EWS` then answers `NoSuchProtocol`. EWS is no longer a standalone
  client path (Outlook 2024 LTSC/M365 do not speak Basic-Auth EWS against
  third-party servers), but remains as a companion protocol of MAPI over HTTP (free/busy,
  out-of-office, OAB). The BCP card is now called "MAPI over HTTP + EWS".
- README: EWS removed as a standalone path from the protocol overview, client table and access table;
  Compose/configuration sections switched to the new file; JMAP in the
  feature table; image tags bumped to 5.8.0.
- `docs/deployment-docker.md`: EWS lines adjusted, JMAP URL added.

### Docs

- `docs/jmap.md`: architecture diagram, client setup (Ltt.rs, Thunderbird, web apps),
  curl examples (reading, flags/moving, sending with `onSuccessUpdateEmail`, attachments,
  EventSource, WebSocket, Blob/Quota) and FAQ.
- `docs/releases/v5.7.1.md` and `docs/releases/v5.8.0.md`: release notes for GitHub Releases
  including a proposal for the repository description and topics.

### Upgrade Notes

- Anyone who previously connected Outlook via EWS (without MAPI) enables
  "MAPI over HTTP + EWS" in BCP → Server or switches to IMAP.
- Existing `.env` files remain valid; the new Compose reads the same variables.
  Dropped Compose variables (internal ports/URLs) are stored as image defaults.

---

## [5.7.1] — 2026-10-27 — JMAP Server (RFC 8620/8621 + 8887/9404/9425/9670/9749)

### Added

**New package `packages/jmap-server/` (port 3006)** — JSON Meta Application
Protocol as a modern IMAP/SMTP replacement, reachable behind the api-gateway:

| Path | Purpose |
|------|-------|
| `GET /.well-known/jmap` | Discovery → 301 to `/jmap/session` (RFC 8620 §2.2) |
| `GET /jmap/session` | Session resource with capabilities, accounts, URLs |
| `POST /jmap/api` | Method calls (result references, creation ids, limits) |
| `POST /jmap/upload/{accountId}/` · `GET /jmap/download/{accountId}/{blobId}/{name}` | Blobs |
| `GET /jmap/eventsource` | Push via Server-Sent Events (`types`, `closeafter`, `ping`) |
| `WS /jmap/ws` | JMAP over WebSocket, subprotocol `jmap` (RFC 8887) |

- **RFC 8620 Core**: session, `Core/echo`, standard errors (`urn:ietf:params:jmap:error:*`,
  method/set errors), `PushSubscription/get|set` with PushVerification flow
  (new table `jmap_push_subscriptions`), state strings per data type.
- **RFC 8621 Mail**: `Mailbox/get|changes|query|set`, `Email/get|changes|query|set|copy|import|parse`,
  `Thread/get|changes`, `Identity/get|changes|set`, `EmailSubmission/get|changes|query|set`
  (incl. `onSuccessUpdateEmail`/`onSuccessDestroyEmail`, delayed sending +
  cancellation via the BullMQ queue `smtp-outbound`), `SearchSnippet/get`,
  `VacationResponse/get|set` (on `UserSettings.oof*`).
- **RFC 8887 WebSocket**: `Request`/`Response`/`RequestError`/`StateChange`,
  `WebSocketPushEnable|Disable`; the upgrade is forwarded by the api-gateway (HTTP + integrated
  TLS proxy) to the jmap-server.
- **RFC 9404 Blob**: `Blob/upload` (asText/asBase64/blobId slices), `Blob/get`
  (`data:*`, `digest:sha`, `digest:sha-256`, `size`, offset/length), `Blob/lookup`.
- **RFC 9425 Quota**: `Quota/get|changes|query|queryChanges` from `quotaBytes`/`usedBytes`.
- **RFC 9670 Sharing**: `Principal/*` (user = individual, Shared Mailbox = group),
  `ShareNotification/*` (currently empty), `urn:ietf:params:jmap:principals:owner` per account.
- **RFC 9749 VAPID**: session capability `urn:ietf:params:jmap:webpush-vapid`
  with `applicationServerKey` from `VAPID_PUBLIC_KEY`.
- **Accounts**: own mailbox (`accountId = userId`), Shared Mailboxes
  (`shared-<id>`, FULL_ACCESS/READ_ONLY), delegated mailboxes (MailboxDelegate).
- **Auth**: Bearer (session JWT, also `?access_token=` for EventSource/WS) and
  Basic (password; with MFA only app password; LDAP/OIDC via auth-service), 60s cache.
- **Threads**: new column `Message.threadId` (lazily derived from `inReplyTo`).
- **Switch**: `ServerSettings.jmapEnabled @default(true)`, BCP → Server →
  card "JMAP", hot reload via Redis `settings:reload`; off → 404.
- **MinIO**: lifecycle `jmap-upload/` 7 days, helper `jmapUploadKey()`.
- Unit tests (`node --test`): dispatcher/result references, keywords, state codecs.
- Docs: `docs/jmap.md` (setup, clients, method overview, limitations).

### Known Limitations

- `Email/queryChanges`, `Mailbox/queryChanges`: `cannotCalculateChanges` (client reloads).
- Deleted messages have no tombstones → `Email/changes` returns
  `cannotCalculateChanges` after a hard delete.
- An email lives in exactly one folder (`maxMailboxesPerEmail: 1`).
- Filters `header`, `*InThreadHaveKeyword` → `unsupportedFilter`; sort `to` → `unsupportedSort`.
- `bodyStructure` is synthesized from the DB fields (text/plain, text/html, attachments).

### Infra

- `Dockerfile.app`, `supervisord-app.conf`, `docker-compose*.yml` (`JMAP_SERVICE_URL`, `JMAP_PORT`),
  root `tsconfig.json`: package `jmap-server` registered.

---

## [5.7.0] — 2026-10-27 — MAPI over HTTP optionally back + build hardening

### Added

**MAPI over HTTP as an optional feature (default OFF).** The MAPI/HTTP stack
removed in v5.4.0 (v4.0–v5.2, MS-OXCMAPIHTTP/ROPS/NSPI, ~9,000 LOC)
has been restored from the git history and put behind a switch:

- New field `ServerSettings.mapiHttpEnabled Boolean @default(false)`.
- BCP → Server → card "MAPI over HTTP" with checkbox + limitation notice.
- `PUT /api/v1/admin/servers/settings` accepts `mapiHttpEnabled` (optional,
  so that older BCP builds can keep saving).
- ews-server: `src/mapi/feature-flag.ts` — `isMapiHttpEnabled()` with 60s cache,
  invalidation via Redis `CHANNEL_SETTINGS_RELOAD` (hot reload, no restart).
  Gate `requireMapiEnabled` returns **404** on `/mapi/*` (incl.
  `/healthcheck.htm`) as long as the switch is off. Fail-closed on DB error.
- api-gateway: proxy `/mapi` → ews-server active again, `/mapi` in `API_PREFIXES`.
- autodiscover: `<Protocol Type="mapiHttp">` only if `cfg.mapiHttpEnabled`;
  `ServerConfig.mapiHttpEnabled` (env fallback `ENABLE_MAPI_HTTP=true` without DB).
- NSPI GAL without DistributionGroup (v5.6.1 adjustment), active users only.
- 35 MAPI codec tests (`node --test`) run again.

**Not included**: ADFS emulation (v5.3.0) — remains removed. This means:
Outlook 2013–2021 connect via Basic Auth as an Exchange account; Outlook 2024
LTSC / M365 Classic enforce Modern Auth against Entra/ADFS and stay on the
IMAP path; new Outlook + Outlook for Mac do not support MAPI.

### Changed

- **pnpm pinned**: `packageManager: pnpm@11.28.9` in the root
  `package.json`, `Dockerfile.app` uses `corepack prepare pnpm@11` instead of
  `pnpm@latest` (pnpm 12 via corepack broke the install).
- **Frontend builds no longer emit JS next to the sources**: `noEmit: true`
  in `admin-panel`/`web-client` tsconfig. 70 stale, checked-in
  `src/**/*.js` artifacts (as of v3.18.34, incl. `OAuthClientsPage.js`) removed.
- Stale comments about OAuth2/ADFS/MAPI/distribution groups cleaned up
  (api-gateway `server.ts`, `contacts.ts`, ews-server `auth/middleware.ts`,
  smtp-server `inbound/handler.ts`, `schema.prisma`).

### Migration

- `prisma db push` creates `server_settings.mapiHttpEnabled` (false) — non-
  destructive. Behavior after the upgrade is identical to v5.6.1 until the switch
  is set in the BCP.

---

## [5.6.1] — 2026-05-27 — Distribution groups (DistributionGroups) completely removed

### Removed (Major)

**Distribution groups completely removed from the stack.**
User decision: "Remove distribution groups as well". In practice,
distribution groups were rarely used — modern teams prefer Shared Mailboxes
(`/admin/shared-mailboxes/`) for team mailboxes with aliases, or external
listserv tools for pure distribution lists. Reduces code complexity and one
maintenance point in the BCP. Analogous to v3.18.5 (eDiscovery), v3.18.31 (Public
Folders), v3.18.33 (ExternalMailContacts), v5.4.0 (MAPI), v5.6.0 (OAuth2).

### Prisma Schema (DESTRUCTIVE Migration)

**2 models + 1 enum deleted** — tables are dropped via `prisma db push
--accept-data-loss` at container start:
- `DistributionGroup` → table `distribution_groups`
- `DistributionGroupMember` → table `distribution_group_members`
- enum `GroupType { STATIC, DYNAMIC }`
- `Domain.distributionGroups` relation removed

### Frontend (BCP / admin-panel)

- **BCP `/groups/` page**: deleted (`packages/admin-panel/src/pages/GroupsPage.tsx`)
- Sidebar entry "Distribution groups" + Users icon import removed
- Route `/groups` removed from `main.tsx`
- i18n keys `nav_groups` (DE+EN) removed
- OrganisationPage GAL section: "Distribution groups" column removed
- SmtpConfigPage local-delivery hint: "Distribution groups are resolved" removed

### Backend (api-gateway)

- **`packages/api-gateway/src/routes/admin/groups.ts`**: deleted
- Mount `/api/v1/admin/groups` removed from server.ts
- **EMS REST bridge** (`routes/admin/ems.ts`): all DistributionGroup CRUD
  endpoints removed (~150 LOC) incl. `formatGroup()` helper:
  - `GET/POST /distribution-groups`
  - `GET/PUT/DELETE /distribution-groups/:id`
  - `GET/POST/DELETE /distribution-groups/:id/members`
  - Cmdlet routes for Get-/New-/Set-/Remove-DistributionGroup +
    Get-/Add-/Remove-DistributionGroupMember removed
- **PowerShell Remoting** (`routes/powershell.ts`): 6 DistributionGroup
  cmdlets removed from the `SUPPORTED_CMDLETS` set
- **GAL endpoint** (`routes/contacts.ts`):
  - `/contacts?q=` autocomplete: DistributionGroup search removed
  - `/contacts/gal` (both search and detail): DistributionGroup
    source removed, `GROUP` kind removed from `GalEntry` type
- **Dashboard** (`routes/admin/dashboard.ts`): `distributionGroup.count()`
  → constant 0
- **Organisation** (`routes/admin/organisation.ts`): GAL section
  `groups` array stays empty

### Backend (smtp-server)

- **`packages/smtp-server/src/handlers/expand.ts`**: completely rewritten —
  `expandRecipients()` now only resolves email aliases (cycle protection via
  visited set is preserved); no more DistributionGroup lookup.
- **`packages/smtp-server/src/inbound/handler.ts`**: `verifyRecipient()`
  Promise.all drops the DistributionGroup lookup; inbound mails to
  former group addresses are rejected as unknown recipient
  (550 5.1.1).

### Migration Note

Existing DistributionGroups + memberships are irrevocably lost with the
upgrade. Use-case recommendation:
- **Team mailbox with a shared inbox** → Shared Mailbox + members
  via permissions
- **Pure distribution list (outbound)** → external listserv (Mailman, listmonk)
  or maintain the recipient list directly in the user clients

---

## [5.6.0] — 2026-05-27 — OAuth2 / Modern Auth completely removed from the stack

### Removed (Major)

**OAuth2 / Modern Auth / JWT RS256 infrastructure completely deleted.** User
decision: "Remove and strip from the code: BCP OAuth2 / Modern Auth".

Background: After the MAPI removal in v5.4.0 + the IMAP OAuth decision in v5.5.0,
OAuth2 has no practical use case left in the stack. Mail clients use IMAP/
SMTP/POP3 with app passwords (MFA-capable). MWA + BCP use session JWTs
via `/auth/login`. The complete OAuth2 codebase is dead weight.

### Frontend

- **BCP `/oauth-clients/` page**: deleted (`packages/admin-panel/src/pages/OAuthClientsPage.tsx`)
- BCP sidebar entry "OAuth2 Clients" + i18n keys removed
- BCP route `/oauth-clients` removed
- **MWA `/oauth-consent/` page**: deleted (`packages/web-client/src/pages/OAuthConsentPage.tsx`)
- MWA route `/oauth-consent` removed
- MWA LoginPage: OAuth2 flow detection removed (login goes directly to `/mail`)

### Backend

- **`packages/auth-service/src/oauth2/`**: entire directory deleted (router + 970 LOC)
- **`packages/api-gateway/src/routes/admin/oauth-clients.ts`**: deleted
- api-gateway: `/oauth2/*` proxy removed
- api-gateway: `/api/v1/admin/oauth/*` mount removed
- api-gateway: `/.well-known/openid-configuration` + `/.well-known/jwks.json` handlers removed
- auth-service: `/oauth2` mount removed
- ews-server middleware: Bearer branch completely removed (audience validation, OAuth token revocation check) — Basic Auth only

### JWT back to HS256

- **`packages/core/src/auth/jwt-keys.ts`**: deleted (RS256 key management was only for JWKS)
- `packages/core/src/auth/jwt.ts`: completely rewritten back to HS256 with the `JWT_SECRET` env var (as pre-v5.2.17)
- `initJwtKeys()` removed from api-gateway, auth-service, ews-server, backup-service, caldav-server startup

### Prisma Schema (DESTRUCTIVE Migration)

**4 models deleted** — tables are dropped via `prisma db push --accept-data-loss` at container start:
- `OAuthClient` → table `oauth_clients`
- `OAuthAuthorizationCode` → table `oauth_authorization_codes`
- `OAuthToken` → table `oauth_tokens`
- `OAuthConsent` → table `oauth_consents`

**`User` relations** removed: `oauthCodes`, `oauthTokens`, `oauthConsents`.

**`ServerSettings` fields removed:** `jwtPrivateKey`, `jwtPublicKey`,
`jwtKeyId`, `jwtKeyCreated`.

### What remains

- **App passwords** (`AppPassword` model + `/auth/app-passwords` router) — the pragmatic MFA bypass for IMAP/SMTP/POP3/EWS
- **Session JWTs** (HS256-signed with `JWT_SECRET`) for REST API + MWA/BCP login
- **MFA/TOTP/WebAuthn** (`UserMfa` model + `/auth/mfa` router) — for interactive logins
- **SSO/OIDC provider integration** (`SsoConfig` model + `/sso` routes) — for external IdP login (NOT for our own tokens)

### Migration Impact

- Existing OAuth client data is lost (but was never used in this installation)
- RS256 JWTs become invalid → users log in again once (HS256 JWTs are issued)
- API consumers that used our `/oauth2/token` would have to switch to `/auth/login` (none known)

### Stack Simplification

| Before (v5.5.0) | After (v5.6.0) |
|-----------------|------------------|
| 2 frontend pages (OAuthClientsPage + OAuthConsentPage) | — |
| 1 backend router (oauth2/router.ts, 970 LOC) | — |
| 1 backend module (jwt-keys.ts, 130 LOC) | — |
| 1 admin API router (oauth-clients.ts, 220 LOC) | — |
| 4 Prisma models + relations | — |
| JWT keys persisted in DB | JWT_SECRET env var |
| 9 endpoints under /oauth2/* | — |
| 2 well-known endpoints | — |

**Total removed: ~1,500 LOC** in addition to MAPI's 12,000 LOC from v5.4.0.

---

## [5.5.0] — 2026-05-27 — IMAP4rev2 RFC compliance + docs update

### Added

**IMAP RFC 3501 + RFC 9051 (IMAP4rev2) compliance:**

| Feature | RFC | Effect |
|---------|-----|---------|
| **AUTHENTICATE PLAIN** | 3501 §6.2.2 + 4616 | SASL standard, instead of only the LOGIN command |
| **AUTHENTICATE LOGIN** | obsolete but common | Multi-step `Username:` → `Password:` |
| **SASL-IR** | 4959 | Initial response on the same line |
| **UNSELECT** | 3691 / IMAP4rev2 mandatory | Deselect folder without EXPUNGE (vs CLOSE) |
| **ID** | 2971 | Client/server identification |
| **STARTTLS** | 3501 §6.2.1 | Stub on port 143 (points to 993 — a full upgrade needs a socket refactor) |

**CAPABILITY list extended with:** `IMAP4rev2`, `MOVE`, `UNSELECT`, `UIDPLUS`, `STATUS=SIZE`. Plus dynamic `STARTTLS`/`LOGINDISABLED` toggle (only on plain connections).

### Architecture decision: NO XOAUTH2 for mail protocols

Research result (Grommunio + Mozilla + Microsoft Docs):
- **Apple Mail**: hardcoded provider list (iCloud/Gmail/Microsoft/Yahoo) — no UI for custom OAuth servers
- **Outlook 2024 LTSC**: Microsoft has explicitly stated: no OAuth for POP/IMAP
- **Thunderbird**: theoretically yes, in practice a `prefs.js` hack per account → unsuitable for end users
- **eM Client / K-9 Mail**: large providers only

**Verdict**: XOAUTH2 for non-Microsoft servers has a ~1% real user base (mutt/isync power users). They can use **app passwords** instead, which are already implemented. The OAuth2 server remains under `/oauth2/*` for REST API + web app integration.

### Changed — docs completely updated

**README.md:**
- MAPI section removed
- "Connect Outlook natively" section → **"Connecting clients"** with IMAP setup table for all common clients (Outlook 2024 LTSC, Apple Mail, Thunderbird, eM Client, K-9, iOS Mail)
- App passwords section with step-by-step guide
- IMAP4rev2 badge instead of MAPI/HTTP badge
- Version history updated: v5.x = "IMAP4rev2 + RFC compliance + MAPI cleanup"

**CLAUDE.md:**
- "Current version" → 5.5.0
- New section "Architecture decisions (v5.4.0+)" — MAPI removal rationale, OAuth2 scope, IMAP4rev2 status
- `/mapi/*` removed from the routing table
- "MAPI over HTTP" section → note about the v5.4.0 removal

---

## [5.4.0] — 2026-05-27 — MAPI completely removed from the stack

### Removed (Major)

**MAPI-over-HTTP implementation completely deleted.** User decision:
"discard the MAPI concept and remove it". Background: Outlook 2024
LTSC enforces Modern Auth on Exchange endpoints and does not accept
non-Microsoft OAuth providers. A custom ADFS emulation would have required 3-4 weeks
of effort with no guarantee of success (see research from v5.3.0).

Consistent cleanups:

| Component | Status | Size |
|------------|--------|-------|
| `packages/ews-server/src/mapi/` | **deleted** | ~12,000 LOC |
| `<Protocol Type="mapiHttp">` in Autodiscover XML | **removed** | Autodiscover now only announces IMAP+SMTP+ActiveSync |
| `/mapi/*` proxy in api-gateway | **removed** | — |
| `/adfs/oauth2/*`, `/adfs/ls/`, `/FederationMetadata/*` routes | **removed** | Was for MAPI Modern Auth |
| `provisionWellKnownOAuthClients()` (Outlook native client_ids) | **removed** | — |
| `packages/storage/src/oauth-clients-bootstrap.ts` | **deleted** | — |
| `ENABLE_MAPI_HTTP` environment flag | **removed** | Was dead code only |

### Kept

- **IMAP/IMAPS** port 143/993 — fully functional (see v5.3.1 + v5.3.5 fixes)
- **SMTP/Submission** port 25/465/587 — STARTTLS + Basic Auth
- **POP3/POP3S** port 110/995 — with app-password fallback (v5.3.1)
- **EWS** port 8080 — stays for Outlook Web App compatibility
- **CalDAV** port 8082 — calendar via Apple Calendar, Thunderbird Lightning, etc.
- **CardDAV** port 8082 — contacts in sync
- **ActiveSync** port 3005 — EAS 14.1 for mobile clients
- **OAuth2 server** under `/oauth2/*` — for web apps + API clients
- **MWA + BCP** — fully functional web UIs

### Recommended Client Setups

| Client | Account type | Protocols |
|--------|-----------|------------|
| **Outlook 2024 LTSC** | "Other email accounts" → **IMAP** | IMAP+SMTP |
| **Outlook 2021 LTSC** | IMAP or Exchange (Exchange via EWS) | IMAP+SMTP |
| **Apple Mail (Mac + iOS)** | IMAP account | IMAP+SMTP+CalDAV+CardDAV |
| **Thunderbird** | IMAP account | IMAP+SMTP+CalDAV (Lightning)+CardDAV (TbSync) |
| **eM Client** | IMAP account | IMAP+SMTP+CalDAV+CardDAV |
| **Android K-9 Mail** | IMAP account | IMAP+SMTP |
| **iOS Mail.app** | "Other" → IMAP | IMAP+SMTP+CalDAV+CardDAV (Apple Calendar/Contacts separately) |

### Changed/preserved version numbers in the roadmap

The MAPI roadmap v4.0→v5.2 (phases 1-7 + FINAL) is preserved as git history and
README documentation, but is no longer active code. If
Microsoft ever relaxes Modern Auth or a realistic path
emerges, the code can be reactivated from the git archive.

---

## [5.3.1] — 2026-05-27 — IMAP completeness + POP3 app password + byte stuffing

### Fixed — IMAP (Mac Mail folder management broken)

User observation: Mac Mail can connect and sees the standard
folders, but **new folders are not created** and **mails in the
folders are not displayed**. Root cause: major IMAP commands were missing.

Implemented in `packages/imap-server/src/commands/index.ts`:

| Command | RFC | Effect |
|---------|-----|---------|
| `CREATE` | 3501 §6.3.3 | "Create new folder" in Mac Mail |
| `DELETE` | 3501 §6.3.4 | Delete folder (messages soft-deleted) |
| `RENAME` | 3501 §6.3.5 | Rename folder |
| `APPEND` | 3501 §6.3.11 | Mac Mail uploads local drafts/sent to the server |
| `COPY` / `UID COPY` | 3501 §6.4.7 | Drag-drop "copy to folder" |
| `MOVE` / `UID MOVE` | 6851 | Atomic move without EXPUNGE round trip |
| `SEARCH` / `UID SEARCH` | 3501 §6.4.4 | **CRITICAL** — Mac Mail uses this on every folder open |
| `CLOSE` | 3501 §6.4.2 | Deselect folder + implicit EXPUNGE |
| `CHECK` | 3501 §6.4.1 | Server sync (NOOP for us) |

**SEARCH was the most important fix**: when opening a folder, Mac Mail first
runs `UID SEARCH ALL` to fetch the UID list, THEN
`UID FETCH 1:* (UID FLAGS …)`. Without SEARCH, Mac Mail got `BAD Command
not recognized` → the folder appeared empty although messages existed.

### Fixed — IMAP UID Command Variants

The dispatcher now recognizes `UID <SUB>` as a compound command (before: only the
first token was uppercased, so `UID FETCH` was wrongly handled as `cmd='UID'` with `args[0]
='FETCH'`). Now: all 6 variants — `UID FETCH`,
`UID STORE`, `UID COPY`, `UID MOVE`, `UID SEARCH`, `UID EXPUNGE`.

### Fixed — IMAP Sequence-Set Parser

`parseSequenceSet()` now supports, in addition to UID mode, the
sequence-number mode (1-based positions) for the non-UID variants
of COPY/MOVE/SEARCH/STORE/FETCH. Backward-compatible: default `byUid=true`.

### Fixed — POP3 App Password + Bare Username

User observation: POP3 with an MFA user → login error. Previously only
`User.passwordHash` was checked. Now analogous to IMAP/EWS:
1. `verifyPassword(pw, User.passwordHash)`
2. Fallback: `verifyPassword(pw, AppPassword.hash)` for all app passwords
3. Bare username (`admin` without `@domain`) is completed with the primary
   domain (before: user lookup with `email='admin'` → 401)

### Fixed — POP3 Byte Stuffing (RFC 1939 §3)

**Critical**: Multi-line mails with `.` at the start of a line were truncated
by POP3 clients. Before: `eml.replace(/^\./, '..')` —
replaced only the FIRST character. Now: every line starting with `.`
is escaped to `..` (line by line). Standard requirement
for POP3 servers.

---

## [5.3.0] — 2026-05-27 — ADFS emulation foundation (Phase C + E + ADFS aliases)

### Major Feature

Start of the **ADFS emulation for Outlook 2024 LTSC Modern Auth**.
Background: research (Grommunio source, Microsoft Q&A, MS Docs) showed
that Outlook Win32 (incl. 2024 LTSC) accepts **no** non-Microsoft OAuth2
provider. Modern Auth in the ADAL/MSAL stack is effectively hardcoded
to `login.microsoftonline.com` OR **ADFS** (Active Directory Federation
Services). Therefore CoreMail v5.3+ emulates the ADFS protocol step by step.

This v5.3.0 is the **foundation** — full end-to-end integration
follows in v5.4.0 (WS-Trust 1.3) + v5.5.0 (login UI) + v5.6.0 (E2E test).

### Added — Phase C: Well-Known OAuth2 Clients

`packages/storage/src/oauth-clients-bootstrap.ts` idempotently provisions
the hardwired Microsoft/Apple client IDs at api-gateway boot:

- `d3590ed6-52b3-4102-aeff-aad2292ab01c` — Outlook Desktop (Win + Mac)
- `27922004-5251-4030-b22d-91ecd9a37ea4` — Outlook Mobile (iOS + Android)
- `f8d98a96-0999-43f5-8af3-69971c7bb423` — iOS Mail.app
- `00000003-0000-0000-c000-000000000000` — Microsoft Graph (catch-all)

All as public clients (no secret), PKCE mandatory, trusted (no
consent prompt). With `redirect_uris` for `msauth://`, `urn:ietf:wg:oauth:
2.0:oob`, `ms-appx-web://Microsoft.AAD.BrokerPlugin/*`.

### Added — Phase E: Bearer Token Audience Validation

`packages/ews-server/src/auth/middleware.ts` now validates the `aud`
claim of incoming Bearer tokens. Accepts:
- Tokens without `aud` (legacy CoreMail tokens — refresh sets `aud`)
- `aud` = server FQDN (`https://mail.example.de`)
- `aud` = `https://outlook.office365.com` (Outlook default)
- `aud` = `00000002-0000-0ff1-ce00-000000000000` (Office 365 Exchange ID)

Protection against token substitution / cross-tenant.

### Added — ADFS Endpoint Aliases

The API gateway now routes `/adfs/oauth2/*` to the same auth-service
backend as `/oauth2/*`:
- `/adfs/oauth2/authorize` ← Outlook 2024 LTSC looks there, hardwired
- `/adfs/oauth2/token`
- `/adfs/oauth2/jwks`
- `/adfs/oauth2/.well-known/openid-configuration`

### Added — Federation Metadata XML

New endpoint `GET /FederationMetadata/2007-06/FederationMetadata.xml`
returns minimal but valid WS-Federation 1.2 metadata with:
- `<EntityDescriptor>` with the server FQDN as entityID
- `<RoleDescriptor xsi:type="fed:SecurityTokenServiceType">`
- `<KeyDescriptor use="signing">` with our RS256 public key
- `<fed:TokenTypesOffered>` JWT
- `<fed:PassiveRequestorEndpoint>` points to `/adfs/oauth2/authorize`

### Added — EWS/MAPI Bearer Challenge with authorization_uri (RFC 6750)

When an unauthenticated request to `/EWS/Exchange.asmx` or
`/mapi/emsmdb/` arrives, the server now responds with:
```
WWW-Authenticate: Bearer realm="https://mail.example.de",
                  authorization_uri="https://mail.example.de/adfs/oauth2/authorize",
                  scope="EWS.AccessAsUser.All", Basic realm="CoreMail EWS"
```
Outlook 2024 LTSC reads `authorization_uri` and starts its
OAuth2 flow against the endpoint given there.

### Roadmap to the complete Outlook 2024 LTSC integration

| Version | Content | Effort |
|---------|--------|---------|
| **v5.3.0** (today) | Foundation: Phase C+E, ADFS aliases, FederationMetadata, Bearer challenge | ✅ |
| **v5.4.0** | WS-Trust 1.3 endpoint (`/adfs/services/trust/13/usernamemixed`) — SOAP-based UsernameToken auth | ~6-8h |
| **v5.5.0** | ADFS login page (`/adfs/ls/`) with browser flow + token audience adjustment | ~4-6h |
| **v5.6.0** | Autodiscover OAuth2 hint + real Outlook 2024 test + bug fixes | ~2-4h |

---

## [5.2.19] — 2026-05-27 — IMAP parseLine bug: empty quoted strings (LIST "" "*")

### Fixed

After the v5.2.18 deploy, live logs showed:
`SyntaxError: Invalid regular expression: /^*.*$/i: Nothing to repeat`
on every LIST + LSUB call from Mac Mail → the IMAP connection threw 500.

Root cause: `parseLine()` in `packages/imap-server/src/server/index.ts`
treats empty quoted strings (`""`) as "not present" and skips
them. Mac Mail sends `LIST "" "*"` (RFC 3501 standard) → our parser
turned it into `args=['*']` instead of `args=['', '*']` → `reference` was
wrongly set to `*` → regex `^*.*$` invalid (asterisk at the
start with no preceding character).

### Changes

- `parseLine()`: tracks a `quotedToken` flag — empty quoted tokens are now
  correctly pushed as an empty string
- `handleList` + `handleLsub`: defensive — `reference` is escaped before building the RegExp,
  plus try/catch around the RegExp construction (fallback: match all
  folders)

Effect: Mac Mail / iOS Mail / Thunderbird / all IMAP clients now see
their folder list correctly. Before this fix, effectively every
`LIST "" "*"` was broken — the bug had been latent for a long time, but masked
because our test clients (openssl without `""`) did not trigger it.

---

## [5.2.18] — 2026-05-27 — IMAP SPECIAL-USE + LSUB + NAMESPACE + STATUS (Mac Mail fix)

### Fixed

User observation: Mac Mail can log in via IMAP, but only shows INBOX.
The other system folders (Drafts/Sent/Trash/Junk/Archive) are hidden in the
sidebar, and mails from these folders do not appear — even
if they are visible in the MWA.

### Root Cause

Our IMAP server returned:
- LIST responses WITHOUT SPECIAL-USE flags (`\Drafts`, `\Sent`, `\Trash`, `\Junk`,
  `\Archive`). Mac Mail recognizes system folders exclusively via these flags
  — without them it only sees INBOX as a "standard folder" and hides everything
  else.
- LSUB not implemented → Mac Mail got `BAD Command not recognized`,
  fell back to INBOX only.
- SUBSCRIBE / UNSUBSCRIBE not implemented.
- NAMESPACE not implemented (CAPABILITY announced it, but there was no
  handler).
- STATUS not implemented (Mac Mail uses it for folder refresh without
  SELECT — if the answer is a `BAD`, the folder is marked as "unsynced").

### Added

- **`specialUseFlag(name)`** in `packages/imap-server/src/commands/index.ts`
  maps folder names (case-insensitive, EN + DE) to SPECIAL-USE flags:
  - `INBOX` / `Posteingang` → no flag (INBOX is always `*`)
  - `Drafts` / `Entwürfe` → `\Drafts`
  - `Sent` / `Gesendet` → `\Sent`
  - `Trash` / `Gelöscht` → `\Trash`
  - `Junk` / `Spam` → `\Junk`
  - `Archive` / `Archiv` → `\Archive`
- **handleList** now emits SPECIAL-USE flags next to `\HasNoChildren`
- **handleLsub** — same output as LIST (all standard folders count
  as auto-subscribed)
- **handleSubscribe** / **handleUnsubscribe** — RFC 3501 §6.3.6/6.3.7,
  accept subscriptions (no-op)
- **handleNamespace** — RFC 2342, returns the personal namespace `(""  ".")`
- **handleStatus** — RFC 3501 §6.3.10, MESSAGES/UIDNEXT/UIDVALIDITY/UNSEEN/
  RECENT/HIGHESTMODSEQ

### CAPABILITY

Now additionally announces: `SPECIAL-USE`, `LIST-EXTENDED`, `LIST-STATUS`,
`CHILDREN`. Mac Mail checks these explicitly.

### Effect

Apple Mail / Mac Mail / iOS Mail / Thunderbird now see all standard
folders with the correct icon (briefcase for Drafts, paper plane for Sent,
trash can for Trash, …) AND all messages contained in them.

---

## [5.2.17] — 2026-05-27 — Modern Auth Foundation (RS256 JWT + OIDC Discovery)

### Why

Outlook 2024 LTSC enforces Modern Auth (OAuth2/OIDC) and no longer accepts a
Basic-Auth fallback (not even with the `EnableADAL=0` registry key). Live logs
on the server showed `scheme:"bearer"` on every connection attempt — Outlook
sends OAuth2 tokens exclusively, never Basic-Auth credentials.

Until now CoreMail had OAuth2 server endpoints under `/oauth2/*`, but JWT was
signed with HS256 (HMAC, symmetric) — so the JWKS endpoint could not
provide a public key → OIDC clients (Outlook, mobile apps with Modern
Auth) rejected tokens.

### Changed

- **JWT signing switched from HS256 to RS256.** RSA-2048 asymmetric, keys
  are generated automatically on first service start and persisted in
  `ServerSettings.jwtPrivateKey/jwtPublicKey/jwtKeyId`.
  Happens idempotently via the new `initJwtKeys(prisma)` function in
  `@coremail/core`, called at boot of api-gateway, auth-service,
  ews-server, backup-service, caldav-server.

- **JWKS endpoint** (`/oauth2/jwks` + new `/.well-known/jwks.json`) now
  returns the public key as JWK (RFC 7517). Outlook + other clients can
  thereby verify JWT signatures themselves.

- **OIDC Discovery** (`/oauth2/.well-known/openid-configuration` + new
  `/.well-known/openid-configuration` at the root) announces RS256 as
  `id_token_signing_alg_values_supported` and adds Microsoft Graph scopes
  (`EWS.AccessAsUser.All`, `Mail.Read/ReadWrite/Send`,
  `Calendars.Read/ReadWrite`, `Contacts.Read/ReadWrite`, `offline_access`).

- **OAuth2 proxy in api-gateway**: `/oauth2/*` is now forwarded to the auth-service
  so that clients can access `https://mail.../oauth2/authorize`
  and `.../oauth2/token` directly.

### Schema

`ServerSettings` gets 4 new fields:
- `jwtPrivateKey String?` — PEM RSA private key
- `jwtPublicKey  String?` — PEM RSA public key (PKCS#1/SPKI)
- `jwtKeyId      String?` — stable key ID for JWK `kid`
- `jwtKeyCreated DateTime?` — generation time (for future rotation)

### Migration impact

- **Existing sessions/tokens are invalidated** (HS256-signed, now
  RS256 verify). Users must log in again once. Access tokens have
  only a 15min TTL anyway.
- **Schema migration**: `prisma db push --accept-data-loss` at first
  container start adds the new fields. No data loss.

### What is still missing for Outlook 2024 LTSC end-to-end

Phase A+B (this version) is the infrastructure. For a working Outlook
2024 LTSC connection, phases C–F are still missing (in progress, coming in v5.3.0+):

- Auto-provision the Microsoft Outlook native client ID
- Extend Autodiscover XML with an OAuth2 endpoint hint
- Bearer token audience validation in the EWS/MAPI middleware
- Browser login flow specifically for Outlook

---

## [5.2.15] — 2026-05-27 — Outlook Auth: case-insensitive schemes + bare-username fallback

### Fixed

User observation after v5.2.14: "Password typed correctly in the Outlook client
and the password window keeps popping up again." The live log showed
`Autodiscover v1: Basic-Auth-Header malformed → 401` — the auth header arrived,
but was rejected by our parsing logic.

Two root causes:

1. **Case sensitivity of the auth scheme.** Outlook LTSC on current
   Win11 patches sends `basic` (lowercase) instead of `Basic` — RFC 7235 §2.1
   explicitly says "case-insensitive", but our code used
   `authHeader.startsWith('Basic ')`, which is strictly case-sensitive. Fix:
   `authHeader.split(' ')[0]?.toLowerCase()` → now matches
   `Basic`/`basic`/`BASIC`. Applies to Autodiscover V1 + EWS middleware
   (also Bearer/Negotiate/NTLM analogously).

2. **Bare username without @domain.** In NTLM style, Outlook sometimes sends
   only `admin` (without @stefanwuestner.de). Before: DB lookup with `email='admin'`
   → no match → 401. Fix: if the user part contains no `@`, complete it with the
   primary domain (`admin` → `admin@stefanwuestner.de`).

3. **Whitespace tolerance**: `authHeader.slice(6)` assumes that
   exactly one space sits between scheme and token. Outlook sometimes inserts
   several. Fix: `indexOf(' ')` + `.trim()` on the token part.

### Files

- `packages/autodiscover/src/v1.ts`
- `packages/ews-server/src/auth/middleware.ts`

---

## [5.2.14] — 2026-05-27 — Outlook auth loop FIX (Autodiscover now validates passwords)

### Security

- **Autodiscover V1 accepted ANY arbitrary password as valid.**
  Previous comment in the code: "We do NOT validate the credentials here —
  that is customary for Exchange." That is WRONG — Exchange Autodiscover
  does validate credentials and responds with 401 on a wrong password.
  The previous code returned the full XML with all user details
  (DisplayName, LegacyDN, SMTPAddress) for every valid email address —
  an information-disclosure bug.

### Fixed

- **Outlook Classic endless auth prompt** (also chased in v5.2.1-v5.2.5,
  now really fixed).  Root cause chain:

  1. Outlook calls Autodiscover V2 (`?Protocol=AutodiscoverV1`) → gets the
     V1 URL back
  2. Outlook calls Autodiscover V1 with Basic Auth → V1 **always returned 200**
     (even with a wrong password!) → Outlook accepted the config
  3. Outlook tried EWS/MAPI with the same password → 401 (EWS checks
     correctly)
  4. Outlook asks the user for the password again
  5. → back to step 1 → **endless loop**, the user believes their
     password is not being transmitted

  **Fix** (`packages/autodiscover/src/v1.ts`): V1 now validates Basic Auth
  against `User.passwordHash` AND `AppPassword.hash` (same
  multi-verification as the EWS middleware from v5.2.1).  On a wrong password
  → 401 + multi-scheme `WWW-Authenticate` header.  On a correct password
  → 200 + XML config.
  Outlook now aborts the Autodiscover loop on a genuinely wrong password
  and prompts only ONCE per attempt, instead of chasing the token endlessly through
  Autodiscover/EWS.

  **Also visible in the SystemLog (BCP)**: failed
  Autodiscover auth attempts are logged with `category='MAPI_AUTH'`,
  `reason='WRONG_PASSWORD_OR_USER'`.

  **Note for MFA accounts**: As with EWS/IMAP — with active MFA the
  only way is an **app password** from MWA → Settings → Security.

---

## [5.2.13] — 2026-05-27 — Audit log: 5 new translations

### Fixed

- **Audit log entries `certificates.letsencrypt.post` and
  `smtp-config.settings.put` remained technical and unintelligible.**

  New mappings in `packages/admin-panel/src/pages/AuditLogPage.tsx`:

  | Action string                          | Display                                |
  |----------------------------------------|----------------------------------------|
  | `certificates.letsencrypt.post`        | Let's Encrypt certificate requested    |
  | `letsencrypt.post` (legacy, pre-v3.18.34) | Let's Encrypt certificate requested |
  | `smtp-config.settings.get`             | SMTP outbound configuration retrieved  |
  | `smtp-config.settings.put`             | SMTP outbound configuration changed    |
  | `smtp-config.test-smarthost.post`      | Smarthost connection tested            |

---

## [5.2.12] — 2026-05-27 — Setup loop after successful completion fixed

### Fixed

- **Setup wizard immediately restarted from the beginning after successful completion** —
  bug introduced with the v5.2.11 SetupGuard.  Cause: SetupPage navigated via
  `react-router navigate('/login')` (soft routing).  But SetupGuard still
  had the initial state `setupRequired=true` (from the first mount) and
  ran the effect: `setupRequired===true && pathname!=='/setup'` →
  `navigate('/setup', { replace: true })` → SetupPage remounted with
  `step='form'` → loop.

  **Fix** (`packages/web-client/src/pages/SetupPage.tsx`): The "Go to
  login" button now does a **hard reload** via
  `window.location.href = '/login'` instead of a React Router navigate.  On
  reload, SetupGuard remounts from scratch and fetches `/api/v1/setup/status`
  fresh — `setupRequired=false` → passes through to the login page.

  This also reliably clears the auth state / query cache;
  setup is a one-time event, a full reload is semantically
  correct here.

---

## [5.2.11] — 2026-05-27 — Setup guard for BCP + MWA hardening

### Changed

- **MWA SetupGuard now applies TOP-LEVEL** (`packages/web-client/src/App.tsx`):
  blocks not only the protected routes, but also `/login`,
  `/forgot-password`, `/reset-password`.  As long as setup is not completed,
  every URL lands on `/setup`.  Once setup is done, a direct
  call to `/setup` is redirected back to `/login` (prevents an accidental
  second setup).
- **BCP gets a SetupGuard** (`packages/admin-panel/src/main.tsx`):
  At admin panel start, `/api/v1/setup/status` is checked.  If
  setup is required, redirect via `window.location.href = '/setup'` to the
  MWA setup wizard (leaves the `/bcp` basename completely).  Previously
  an admin could navigate directly to the BCP login page without setup ever having
  been done — login failed (no user), but the welcome UI
  was visible and confusing.

### Why

User observation: "When opening /bcp you land on the login screen instead of the
setup wizard, although no admin has ever been created."  It is now guaranteed
that the initial setup is the first visible screen — no more accidental
entry of wrong credentials into a half-finished system.

---

## [5.2.10] — 2026-05-27 — Self-signed cert always mail.localhost (fresh-install baseline)

### Fixed

- **The self-signed cert at initial setup used the entered hostname
  (`mail.stefanwuestner.de`) instead of the expected default `mail.localhost`.**
  When running the setup wizard, the self-signed cert was generated from the configured
  `publicHostname` — when renaming or on a
  fresh installation with a real domain this produced a "genuine-looking"
  but actually confidentiality-insecure cert.

  **Fix**: As of v5.2.10 the self-signed cert uses a
  **hardcoded CN=`mail.localhost`** in all four code paths:

  1. `packages/api-gateway/src/routes/setup.ts:147` — initial setup wizard
  2. `packages/smtp-server/src/server.ts:182` — SMTP fallback when no
     protocol cert in DB
  3. `packages/imap-server/src/server.ts:49` — IMAP fallback
  4. `packages/pop3-server/src/server.ts:50` — POP3 fallback

  The admin then swaps the self-signed cert via BCP → SSL/TLS
  for a real Let's Encrypt or custom cert. The
  `loadProtocolCert()` logic built in v5.2.9 prioritizes a real cert with
  `isActiveProtocol=true` over the self-signed fallback.

  **Advantage of a fixed CN**: The self-signed cert is not accidentally regenerated when
  `publicHostname` is renamed; the admin consistently sees
  "mail.localhost" as the baseline and knows that it is not
  a production cert.

---

## [5.2.1] — 2026-05-27 — Hotfix: Outlook endless password prompt

### Fixed

- **EWS/MAPI Basic-Auth middleware** (`packages/ews-server/src/auth/middleware.ts`):
  Previously went through the `/auth/login` endpoint of the auth-service, which with
  active MFA returns `{ mfaRequired: true, challengeToken: ... }`
  **without** `accessToken`. Outlook cannot answer an MFA challenge with Basic Auth
  → middleware fell back to 401 → Outlook prompted
  endlessly for the password.

  **User symptom**: In the BCP the login works (MFA is solved
  interactively), but in Outlook the password prompt keeps appearing
  although the password is correct.

  **Fix**: The middleware now verifies directly against `User.passwordHash`
  AND `AppPassword.hash` via `verifyPassword()` from `@coremail/core` —
  same logic as the IMAP/SMTP/POP3 servers since v3.x. With active MFA the
  user must create an **app password** in MWA → Settings → Security
  and enter it in Outlook (instead of their regular
  password). Without MFA the regular password continues to work directly.

- **Username normalization**: Outlook LTSC sometimes sends, NTLM-style,
  `DOMAIN\user` instead of `user@domain` — we now normalize to the
  last backslash part.

- **Detailed logging** for auth failures: user lookup status,
  password hash match, app password match, auth header type — so that
  future problems can be diagnosed faster.

### Outlook setup with MFA

1. User logs in to the MWA and solves MFA
2. MWA → Settings → Security → Generate app password → name "Outlook"
3. In Outlook: password dialog → enter the **app password** instead of the regular password
4. The Outlook account connects natively as Exchange via MAPI/HTTP

---

---

## [5.2.0] — 2026-05-27 — MAPI/HTTP FINAL (Cached Mode + Recurrence + Embedded + Multi-Value + gzip + RTF)

**Final release** of the MAPI/HTTP implementation. Bundles all features
from the originally planned v5.2 / v5.3 / v5.4 / v5.5 milestones into one
final release. Marks MAPI/HTTP as **feature-complete** for typical
Outlook workflows.

### Added — Cached Mode (MS-OXCFXICS)

- **`packages/ews-server/src/mapi/rop/sync.ts`** — complete ICS sync
  implementation for Outlook Cached Mode (default mode since Outlook 2007):

  - `RopSyncConfigure` — creates a FastTransfer source handle
  - `RopFastTransferSourceGetBuffer` — chunked ICS stream (max 28KB/chunk,
    TransferStatus 1=Partial/3=Done)
  - `RopFastTransferSourceCopyFolder` / `CopyMessages` / `CopyProperties`
  - `RopFastTransferDestinationConfigure` / `PutBuffer`
  - `RopSyncImportMessageChange` / `ImportHierarchyChange` / `ImportDeletes` /
    `ImportMessageMove`
  - `RopSyncUploadStateStreamBegin` / `Continue` / `End`
  - `RopSyncOpenCollector`
  - `RopGetLocalReplicaIds`
  - `RopSyncGetTransferState`

- **ICS stream format**: Per message one StartMessage opcode (0x40000003) +
  TaggedProperties (PR_MID, PR_SUBJECT_W, PR_SENDER_NAME_W,
  PR_SENDER_EMAIL_ADDRESS_W, PR_MESSAGE_DELIVERY_TIME, PR_MESSAGE_FLAGS,
  PR_MESSAGE_SIZE) + EndMessage opcode (0x40000004). Maximum 200 messages
  per sync — larger folders via repeated sync calls.

### Added — Calendar Recurrence Pattern

- **`packages/ews-server/src/mapi/recurrence-pattern.ts`** with
  `encodeRecurrencePattern(rrule, dtStart, dtEnd)` — parses iCal RRULE
  (RFC 5545) and converts it into PidLidAppointmentRecur binary
  (MS-OXOCAL §2.2.1.44):
  - FREQ=DAILY/WEEKLY/MONTHLY/YEARLY
  - INTERVAL (e.g. "every 2 weeks")
  - BYDAY (Mon-Sun bitmask)
  - BYMONTHDAY, BYMONTH
  - COUNT / UNTIL

- Outlook now shows the correct recurrence pattern in the appointment editor
  ("weekly on Monday/Wednesday", "monthly on the 15th", etc.).

### Added — PR_RTF_COMPRESSED Stream

- **`packages/ews-server/src/mapi/rtf-compress.ts`**:
  - `htmlOrTextToRtfCompressed()` — wraps HTML/text in
    MELA-uncompressed RTF (MS-OXRTFCP). Outlook accepts it without CRC.
  - `decodeRtfCompressed()` — LZ77 decoder for Outlook→server RTF bodies
    (RTF_PREFIX dictionary init, 4096-byte ring, FullString/Sub/Prefix).

- **`handleRopOpenStream`** on `PR_RTF_COMPRESSED` (0x10090102) now
  functional.

### Added — gzip Transport Compression

- **Middleware in `handler.ts`**: `X-CompressedRequest: 1` triggers
  transparent `gunzipSync` decompression before the handler. Saves bandwidth
  on large ROP streams (typically 60-70% reduction during sync).

### Added — Multi-Value Properties

- **`property-codec.ts`** extended with PT_MV_INT16/INT32/STRING/UNICODE/
  SYSTIME/BINARY (MS-OXCDATA §2.11.1.6) — read + write round trip.

### Added — RopOpenEmbeddedMessage

- **`packages/ews-server/src/mapi/rop/v52-handlers.ts`** — forward mail as
  attachment. Creates a sub-message handle on an attachment, Outlook can
  then read the embedded IPM.Note via OpenStream.

### Added — Search Folders / Rules / Permissions

- **`RopGetSearchCriteria`** + **`RopSetSearchCriteria`** — minimal
  workflow (no crash on Outlook "saved search").
- **`RopGetRulesTable`** + **`RopUpdateRules`** — empty table + SUCCESS.
  Outlook rules remain client-local (CoreMail MailRules via MWA).
- **`RopGetPermissionsTable`** + **`RopModifyPermissions`** — the Outlook
  "Permissions" dialog no longer crashes (ACL management stays in the BCP).

### Added — Misc Message ROPs

- **`RopAbortSubmit`**, **`RopReloadCachedInformation`** (Outlook cached
  refresh), **`RopGetMessageStatus`** / **`RopSetMessageStatus`** for
  read tracking.

### Improved — NSPI

- **Cursor pagination** via StartMid + RowCount from the request body
- **Alphabetical sorting** by displayName (locale 'de')
- **Hard limit** of 1000 instead of 500

### Added — RopIds

- `GetRulesTable: 0x3F`, `UpdateRules: 0x41`
- `GetPermissionsTable: 0x3E`, `ModifyPermissions: 0x40`

### Outlook behavior after v5.2.0

- **Cached Mode works** (the `.ost` file is filled initially, Outlook
  is offline-capable)
- **Recurring appointments** show the recurrence pattern correctly
- **Embedded mails** open on double-click
- Clicking "**Search Folders**" no longer crashes
- **Rules dialog** can be opened (stored locally)
- **Permissions dialog** read-only without errors
- **RTF mails** are displayed correctly formatted
- **Large GAL** (>500 entries) is fully paginated
- **gzip compression** reduces bandwidth by ~60-70% during sync

### MAPI/HTTP roadmap completion

```
v4.0.0  Foundation (codec, sessions, HTTP headers)
v4.1.0  ROP infra + Logon + folder browse
v4.2.0  Reading mail
v4.3.0  Composing + sending mail
v4.4.0  Attachments + Move/Delete
v4.5.0  Push notifications (Redis pub/sub)
v4.6.0  Virtual PIM folders
v4.7.0  NSPI fallback + server-side search
v5.0.0  Production GA (default-on + tests)
v5.1.0  Named Properties + PIM detail views + native NSPI
v5.2.0  FINAL — Cached Mode + Recurrence + Multi-Value + gzip + RTF + Embedded
```

Effort: ~12,000 lines of MAPI code in one contiguous sprint instead of
6-9 months of estimated weekly work.

Optionally open for v5.3+:
- Full ICS OPCODE records with real delta sync via change numbers
- DAV ACL mapping to MAPI permissions (complete)
- RTF→HTML conversion via LZ77 decoder (Outlook→server path)

---

## [5.1.0] — 2026-05-27 — MAPI/HTTP: Named Properties + PIM detail views + native NSPI

Closes the last v5.x items from the v5.0.0 release: complete
Calendar/Contact/Task/Note detail view and native MS-OXNSPI binary
implementation instead of the EWS fallback.

### Added — Named Properties

- **`packages/ews-server/src/mapi/named-properties.ts`**: PSETID GUIDs
  (PSETID_Appointment / PSETID_Address / PSETID_Task / PSETID_Note /
  PSETID_Common / PSETID_Meeting / PS_INTERNET_HEADERS / PS_PUBLIC_STRINGS)
  + standard LIDs from MS-OXOCAL / MS-OXOCNTC / MS-OXOTASK / MS-OXONOTE
  (LID_APPOINTMENT_START_WHOLE 0x820D, LID_LOCATION 0x8208,
  LID_BUSY_STATUS 0x8205, LID_TASK_COMPLETE 0x811C,
  LID_PERCENT_COMPLETE 0x8102, LID_NOTE_COLOR 0x8B00 etc.).

- **`resolveNamedProperties()`** assigns local uint16 IDs starting at 0x8000 in
  the session state (`mapi:session:<token>.namedPropMap`). Idempotent:
  already-allocated IDs are reused.

- **`reverseNamedProperties()`** for the GetNamesFromPropertyIds round trip.

- **`RopGetPropertyIdsFromNames`** + **`RopGetNamesFromPropertyIds`**
  (`rop/named-props-handler.ts`) — complete binary implementation
  incl. GUID encoding (4-2-2-8 format) and LID/name kind differentiation.

- **ROP codec**: Both named-prop ROPs now get the complete
  payload (instead of a pass-through stub).

### Added — PIM Detail Views

- **`packages/ews-server/src/mapi/rop/pim-properties.ts`** with
  `buildPimPropertyList(sessionToken, kind, itemId)`: loads
  CalendarEvent/Contact/Task/Note from Prisma and maps each item to a
  complete property set:

  | Kind | Standard MAPI | Named Properties |
  |------|---------------|------------------|
  | IPM.Appointment | Subject, Body, Times, MessageClass | Location, AppointmentStartWhole, EndWhole, Duration, AllDay (SubType), BusyStatus, Sequence, Recurring |
  | IPM.Contact | DisplayName, Body, SenderName/Email | Email1/2 DisplayName/Type/Address, FileAs + PR_COMPANY_NAME_W, PR_TITLE_W, PR_DEPARTMENT_NAME_W, PR_BUSINESS_TEL_W, PR_MOBILE_TEL_W |
  | IPM.Task | Subject, Body, Times, Priority | TaskStatus (NotStarted/InProgress/Completed/Waiting/Deferred), PercentComplete, StartDate, DueDate, DateCompleted, Complete flag, Owner |
  | IPM.StickyNote | Subject, Body, Times | NoteColor (yellow=3 default), NoteWidth, NoteHeight |

- **`handleRopGetPropertiesAll`** + **`handleRopGetPropertiesSpecific`**
  in `rop/message.ts` dispatch to `buildPimPropertyList()` when the
  message handle has `pimKind !== 'mail'` (instead of the standard message
  property mapping).

- **`openVirtualPimMessage`** now sets `pimKind`
  (appointment/contact/task/note) on the message handle.

- **`RopObject.message` type** extended with a `pimKind` field.

### Added — Native NSPI Binary

- **`packages/ews-server/src/mapi/nspi-handler.ts`** replaces the v4.7.0
  SUCCESS-empty fallback with a complete MS-OXNSPI binary
  implementation:

  - **GetSpecialTable** — returns "Global Address List" as the root entry
  - **QueryRows** — paginates users + DistributionGroups (max 500)
  - **ResolveNames** + **GetMatches** — substring match on
    displayName + email
  - **GetProps** — properties of a single entry by MinId
  - **DnToMinId** — legacy DN string (`/o=…/cn=Recipients/cn=<email>`)
    → MinEntryID
  - **GetPropList** — standard property set for GAL entries

- **MinEntryID** = FNV-1a 32-bit hash of `userId`/`groupId` in the range
  [0x10000000, 0xFFFFFFFF] (MS-OXNSPI-compliant).

- **Standard property set per row**: PR_DISPLAY_NAME_W,
  PR_EMAIL_ADDRESS_W, PR_SMTP_ADDRESS_W, PR_ADDRTYPE_W='SMTP',
  PR_OBJECT_TYPE (6=MAILUSER/8=DISTLIST),
  PR_DISPLAY_TYPE (0/1).

- **`handler.ts`** now dispatches NSPI operations to
  `handleNspiOperation()` from `nspi-handler.ts` instead of returning
  SUCCESS-empty.

### Outlook behavior after v5.1.0

- **Calendar detail view**: Double-clicking an appointment in Outlook
  opens the full appointment window with subject, location, start/end,
  all-day flag, BusyStatus display (Free/Busy/Out of Office/Tentative).
- **Contact detail view**: Contact shows all fields (company, job title,
  department, phones, Email1/Email2).
- **Task detail view**: Task shows due date, percent progress,
  status (NotStarted/InProgress/Completed).
- **Note detail view**: Note with color code.
- **Outlook address book natively populated**: GAL via direct NSPI connection
  (no EWS round trips) — faster, less latency, less
  server load for large mailboxes.

---

## [5.0.0] — 2026-05-27 — MAPI/HTTP production hardening + default-enabled (major release)

### Changed

- **Autodiscover MAPI/HTTP ENABLED BY DEFAULT** (`packages/autodiscover/src/v1.ts`):
  Feature flag `ENABLE_MAPI_HTTP` is now opt-OUT (`!== 'false'`) instead of
  opt-in. Outlook 2013 SP1+ discovers the `<Protocol Type="mapiHttp">` block
  automatically and sets itself up natively as an **Exchange account** (instead of
  the IMAP fallback as before). The complete ROP feature set from v4.1–v4.7
  is available.

### Added

- **Unit tests `property-codec.test.ts`** (13 round-trip tests):
  FILETIME ↔ Date, PT_LONG, PT_INT64, PT_BOOLEAN, PT_UNICODE (with umlauts
  + emojis), PT_BINARY, PT_SYSTIME, writeTaggedProperty, writePropertyRow
  (multi-column + default-for-type), makePropTag constants.

- **Unit tests `entry-id.test.ts`** (6 tests):
  cuidToFolderId64 determinism, uint64 range, collision-freedom for 4
  different IDs, virtual folder IDs are unique.

- Together with the 16 codec tests from v4.0.0 now **35 round-trip tests**
  for the MAPI codec layer.

### Outlook behavior after v5.0.0

User enters mail+password → Autodiscover → Outlook detects MAPI/HTTP →
account type "Exchange" → full feature set (read/compose/
send mail with attachments, push notifications <1s, server-side search,
virtual PIM folders for calendar/contacts/tasks/notes).

No more "IMAP fallback" notice needed. Full native MS-OXNSPI (instead of
the EWS fallback) remains optional for v5.1+ hardening, but is not strictly
required by Outlook — a SUCCESS-empty NSPI response switches Outlook
to EWS.

### Roadmap Status

The 6-9 month plan from v4.0.0-ARCHITECTURE.md implemented in one focused
sprint:

| Phase   | Content |
|---------|--------|
| v4.0.0  | Foundation (codec, sessions, HTTP headers) |
| v4.1.0  | ROP infra + RopLogon + folder browse |
| v4.2.0  | Reading mail (OpenMessage + Properties + stream read) |
| v4.3.0  | Composing + sending mail (Create/SetProps/Submit + BullMQ) |
| v4.4.0  | Attachments + Move/Delete |
| v4.5.0  | Push notifications via Redis pub/sub |
| v4.6.0  | Virtual PIM folders (calendar/contacts/tasks/notes) |
| v4.7.0  | NSPI address book + server-side search |
| v5.0.0  | Production GA (default-on + tests + docs) |

### Opt-Out

`ENABLE_MAPI_HTTP=false` disables the MAPI/HTTP block in Autodiscover
and falls back to IMAP/SMTP only — for sites that want to turn MAPI off
temporarily.

---

## [4.7.0] — 2026-05-27 — MAPI/HTTP Phase 7: NSPI address book fallback + server-side search

### Changed (NSPI)

- **NSPI endpoint** (`packages/ews-server/src/mapi/handler.ts`):
  All NSPI operations (`QueryRows / ResolveNames / GetMatches /
  GetSpecialTable / GetProps / DnToMinId / GetPropList`) now return
  `SUCCESS-empty` (StatusCode=OK, ErrorCode=OK, RowCount=0, HasValue=0)
  instead of binary `ecNotSupported` (0x80040102). Outlook interprets
  SUCCESS-empty as "no matches" and automatically falls back to the
  EWS-based ResolveNames/FindPeople path (functional in CoreMail since
  v3.x). A full MS-OXNSPI implementation remains for v5.x as
  optional hardening.

### Added (Search — bundled from the planned v4.8.0)

- **RopRestrict** (`packages/ews-server/src/mapi/rop/search.ts`):
  Parses the MS-OXCDATA §2.12 restriction format (ResAnd / ResOr / ResNot /
  ResContent / ResProperty / ResExist) and persists the parsed
  restriction on the table handle (dynamic field `restriction`).

- **RopFindRow**: Accepts FindRowFlags + Restriction + Origin +
  Bookmark; v4.7.0 minimally returns "no match" (HasRowData=0) —
  Outlook typically uses RopRestrict + a subsequent
  RopQueryRows as the search workflow, which works fully.

- **restrictionToPrismaWhere()**: Converts a ParsedRestriction into a
  Prisma `where` clause. Property-tag → DB-field mapping supports
  PR_SUBJECT_W → `subject`, PR_BODY_W → `bodyText`, PR_HTML →
  `bodyHtml`, PR_SENDER_NAME_W → `fromName`, PR_SENDER_EMAIL_ADDRESS_W
  → `fromAddr`, PR_DISPLAY_TO_W → `toAddrs`, PR_MESSAGE_DELIVERY_TIME
  → `date`, PR_MESSAGE_SIZE → `rawSize`, PR_MESSAGE_FLAGS → `flags`.
  Content fuzzy levels: FullString/Substring/Prefix + ignore-case.
  Property RelOps: LT/LE/GT/GE/EQ/NE.

- **QueryRows integration**: For the standard mail contents table the
  restriction is applied as an additional filter next to `folderId`
  (`{ folderId, ...restrictionWhere }`).

- **ROP codec extension**: Correct payload parsing for RopRestrict
  (RestrictFlags + RestrictionSize + Restriction) and RopFindRow
  (FindRowFlags + RestrictionSize + Restriction + Origin + BookmarkSize +
  Bookmark).

### Outlook behavior after v4.7.0

- No more "NSPI error" in the Outlook connection status
- Recipient autocomplete in the To/CC/BCC field works seamlessly (EWS FindPeople)
- "Check Names" (Ctrl+K) works (EWS ResolveNames)
- GAL browse shows users + distribution groups (EWS FindFolder + FindItem)
- **Server-side search** (Ctrl+E in Outlook) filters inbox/folders directly
  via MAPI Restriction → Prisma WHERE — no more client-side scan for
  large mailboxes with >1000 mails.

---

## [4.6.0] — 2026-05-27 — MAPI/HTTP Phase 6: Calendar/Contacts/Tasks/Notes virtual folders

### Added

- **containerClassFor(folderName)** (`packages/ews-server/src/mapi/rop/folder.ts`):
  Maps a folder name to the Outlook MAPI container class (PR_CONTAINER_CLASS_W).
  Values per MS-OXOSFLD §2.2.3: IPF.Note (mail, default), IPF.Appointment,
  IPF.Contact, IPF.Task, IPF.StickyNote, IPF.Journal. Case-insensitive match
  for English + German standard names (Calendar/Kalender, Contacts/Kontakte,
  Tasks/Aufgaben, Notes/Notizen).

- **VIRTUAL_FOLDERS constant**: 4 synthetic PIM folders with fixed IDs
  (`virtual-calendar`, `virtual-contacts`, `virtual-tasks`, `virtual-notes`).
  CoreMail stores this data in separate Prisma models (CalendarEvent,
  Contact, Task, Note) — but Outlook MAPI sees them as mailbox folders.

- **GetHierarchyTable extended**: At root level (`parentFolderId === ''`)
  the rowCount is increased by VIRTUAL_FOLDERS.length.

- **QueryRows on hierarchy**: Injects `virtualFolderToPropRow()` for the
  4 PIM folders with PR_DISPLAY_NAME_W + PR_FOLDER_ID + PR_CONTAINER_CLASS_W.
- **OpenFolder extended**: Also matches virtual IDs via
  `cuidToFolderId64(VIRTUAL_FOLDERS[*].id)`.

- **GetContentsTable extended**: Virtual folders return counts from
  `prisma.calendarEvent / contact / task / note` instead of `prisma.message`.

- **QueryRows on contents**: `parentFolderId.startsWith('virtual-')` →
  `loadVirtualContents()` loads events/contacts/tasks/notes from Prisma and
  maps them to PropRows with:
  - PR_MESSAGE_CLASS_W = 'IPM.Appointment' / 'IPM.Contact' / 'IPM.Task' /
    'IPM.StickyNote'
  - PR_SUBJECT_W = summary / displayName / subject
  - PR_BODY_W = description / body
  - PR_MESSAGE_DELIVERY_TIME = dtStart / dueDate / createdAt
  - PR_DISPLAY_NAME_W, PR_SENDER_NAME_W, PR_SENDER_EMAIL_ADDRESS_W
    (for contact rows)

- **GetRowCount extended** for virtual folders.

- **OpenMessage extended**: Detects virtual folder IDs and delegates to
  `openVirtualPimMessage()`, which finds the item via hash match in the respective
  PIM table (`calendarEvent / contact / task / note`).

- **folderToPropRow** now uses `containerClassFor(name)` instead of hardcoded
  'IPF.Note' — existing folders named 'Calendar'/'Kontakte' etc.
  are also classified correctly.

### Outlook behavior after v4.6.0

4 additional folders appear in Outlook under the mailbox: "Calendar",
"Contacts", "Tasks", "Notes" — with the correct icon according to Outlook's
folder-type detection. The list view shows the respective items (appointments/contacts/
tasks/notes) with subject and date.

Read-only browsing of the PIM data is functional. A full property round trip
on individual items (detail display of appointments, contacts etc.) still
needs full named-property mapping (PSETID_Appointment etc.) — coming in
v5.0.0 or optionally as a v4.6.1 patch. For full bidirectional calendar/
contact sync we continue to recommend the "Outlook CalDav Synchronizer"
from the setup page (Settings → External Clients).

---

## [4.5.0] — 2026-05-26 — MAPI/HTTP Phase 5: Push notifications via Redis pub/sub

### Added

- **RopRegisterNotification** (`packages/ews-server/src/mapi/rop/notification.ts`):
  Outlook subscribes via ROP to the desired event types (NewMail / MessageDeleted /
  MessageModified / FolderChanged) on a folder or mailbox handle.
  The subscription is dynamically persisted on the handle (subscription field via
  JSON round trip through Redis).

- **NotificationWait real long-poll** (`packages/ews-server/src/mapi/emsmdb-handler.ts`):
  Until now Outlook polled with long NotificationWait requests that returned after 30s
  with EventPending=false → noticeable delay. Now:
  duplicate()-ed ioredis client (subscribe needs a dedicated connection
  per ioredis requirement), subscribe to `coremail:mapi:notify:<userId>`,
  race between Redis event and 30s timeout, clean cleanup (unsubscribe +
  disconnect + clearTimeout) on both outcomes, plus `req.on('close')`
  for client disconnect handling. Responds immediately on event with
  EventPending=1, otherwise after timeout with EventPending=0.

- **publishNotifyEvent helper** in `rop/notification.ts` with
  `notifyChannelFor(userId)` channel generator. Event shape:
  `{ kind, userId, folderId?, messageId?, subject? }`.

- **SMTP hook** (`packages/smtp-server/src/handlers/message.ts`):
  `storeInboundMessage()` now additionally publishes, after the existing `CHANNEL_MAIL_NEW`
  publish, to `coremail:mapi:notify:<userId>` with a
  MAPI notify event (`{kind:'NewMail', userId, folderId, messageId, subject}`)
  — non-fatal `.catch(() => {})` for backward compatibility when MAPI
  is not active.

- **NotifyEvent TypeScript interface** exported for other modules that
  trigger push events (e.g. future hooks for MessageDeleted / FolderChanged).

### Outlook behavior after v4.5.0

New mail appears in Outlook within <1s (instead of waiting up to 30s
before). Toast notification on new mail works. The folder refresh
cache is invalidated. Battery drain on mobile Outlook clients significantly
reduced (no more constant polling).

---

## [4.4.0] — 2026-05-26 — MAPI/HTTP Phase 4: Attachments + Move/Delete

### Added

- **RopGetAttachmentTable** (`packages/ews-server/src/mapi/rop/attachment.ts`):
  Creates a table object handle for the attachments of a message. New
  table type `attachments` (in `RopObject.table.tableType`), where
  `parentFolderId` contains the MessageId.

- **RopOpenAttachment**: Loads the attachment via index (PR_ATTACH_NUM from QueryRows),
  creates an attachment handle.

- **RopCreateAttachment**: Creates a draft attachment handle (`attachmentId=null`,
  `pendingBuffer`, `pendingProperties`). On SaveChangesAttachment it is
  persisted in DB+MinIO. AttachmentId = next free index in the
  message attachment list.

- **RopDeleteAttachment**: Removes the attachment DB record.

- **RopSaveChangesAttachment**: SHA256 hash, MinIO upload to
  `attachments/{messageId}/{sha256}`, DB insert (or update for an existing
  attachment) with `filename/mimeType/size/sha256/storagePath/contentId`.

- **RopDeleteMessages** (`packages/ews-server/src/mapi/rop/folder-ops.ts`):
  Parses the MessageId array (uint64 FNV hashes), deletes via `prisma.message.delete`,
  decrements folder counters. Response returns the PartialCompletion flag.

- **RopMoveCopyMessages**: Source handle (input) + destination handle (output),
  parses WantCopy flag + MessageId array. Move = folder update, copy = duplicate
  message via `prisma.message.create` with all original fields. Updates
  folder counters (source -= moved, dest += moved).

- **OpenStream on attachment**: Extension of `handleRopOpenStream` —
  for `kind === 'attachment'`, PR_ATTACH_DATA_BIN is loaded from MinIO via
  `loadAttachmentBytes()` (or empty for a draft attachment).
  WriteStream accumulates in `pendingBuffer`, CommitStream persists
  via SaveChangesAttachment.

- **ROP codec**: Correct payload parsing for GetAttachmentTable (TableFlags),
  OpenAttachment (AttachmentId uint32), CreateAttachment, DeleteAttachment,
  SaveChangesAttachment, DeleteMessages (WantAsync + NotifyNonRead +
  MessageIdCount + MessageIds[uint64]), MoveCopyMessages (DestHandleIndex +
  WantAsync + WantCopy + MessageIds[uint64]).

- **RopObject extended**:
  - `attachment` variant with `attachmentId:string|null`, `attachNum`,
    `pendingProperties`, `pendingBuffer`
  - `table` variant with new `tableType:'attachments'`

- **table.ts extended**: `attachmentToPropRow()` maps attachment →
  PR_ATTACH_NUM/LONG_FILENAME_W/MIME_TAG_W/SIZE/METHOD/CONTENT_ID_W.
  GetRowCount supports 'attachments' tables.

- **buildMessagePropertyList extended**: Loads `_count.attachments` from Prisma
  and sets `PR_HAS_ATTACH=true` + `PR_MESSAGE_FLAGS` HasAttach bit (0x10).

- **SubmitMessage extended**: Loads `msg.attachments` (filename/mimeType/
  storagePath/size) from the DB and fills `OutboundJob.message.attachments` with
  `{filename, minioPath, contentType, size}` — the existing worker builds
  RFC 5322 with real attachments via `buildRawFromMessage`.

- **New property tags**: PR_ATTACH_NUM, PR_ATTACH_METHOD,
  PR_ATTACH_LONG_FILENAME_W, PR_ATTACH_FILENAME_W, PR_ATTACH_MIME_TAG_W,
  PR_ATTACH_SIZE, PR_ATTACH_CONTENT_ID_W, PR_ATTACH_DATA_BIN,
  PR_ATTACHMENT_LINKID.

### Outlook behavior after v4.4.0

Attaching a file to a new mail (drag & drop or "Insert file") works
end-to-end — stored in MinIO, passed to the outbound queue with
`minioPath` on send, the worker loads + signs + sends. Received mails
with attachments: Outlook shows the paperclip icon, attachment list, double-click
opens the file. Moving mails (drag-and-drop into other folders) +
multi-delete via the Delete key works. Push notifications on new
mail: not yet (v4.5.0).

---

## [4.3.0] — 2026-05-26 — MAPI/HTTP Phase 3: Composing + sending mail

### Added

- **RopCreateMessage** (`packages/ews-server/src/mapi/rop/message.ts`):
  Creates a new draft message handle (`messageId=null`, `isDraft=true`,
  `pendingProperties={}`, `pendingRecipients=[]`). Folder lookup via
  CUID→uint64 FNV-1a hash. Response: ReturnValue + HasMessageId(0).

- **RopSetProperties**: Parses the PropertyValueArray (PropertyValueSize +
  PropertyValueCount + TaggedPropertyValues) and accumulates the tagged
  property values in `pendingProperties` on the message handle. JSON-safe
  encoding for session persistence in Redis (Buffer → {_t:'Buffer',data},
  BigInt → {_t:'BigInt',v}, Date → {_t:'Date',iso}).

- **RopModifyRecipients**: Parses the ColumnCount/Columns + RowCount/Rows
  structure from MS-OXCMSG §2.2.3.1.2. Extracts RecipientType (1=TO/2=CC/3=BCC)
  + DisplayName + EmailAddress from the RecipientRow header bytes. Stores
  the list in `pendingRecipients` on the message handle.

- **RopSaveChangesMessage**: Persists draft properties+recipients to the
  Prisma DB. With `messageId === null` (new draft) a new message
  record is created in the current folder (typically Drafts) with
  `flags: ['\\Draft']`, UID increment on the mailbox, ModSeq update. For an
  existing message: update. Response: FolderId(uint64) + MessageId(uint64).

- **RopWriteStream** (`packages/ews-server/src/mapi/rop/stream.ts`):
  Appends data to the stream buffer (at the current offset). Outlook calls
  WriteStream repeatedly for long bodies — the buffer is accumulated in the stream handle
  until CommitStream. Supports overwrite-in-place and
  sparse write (padding with null bytes if offset > buffer length).

- **RopCommitStream**: Writes the accumulated stream buffer into the
  parent message. For a saved message: direct Prisma update on
  bodyText/bodyHtml/subject (UTF-16-LE decode for PR_BODY_W/PR_SUBJECT_W,
  UTF-8 for PR_HTML). For a draft stream: update of `pendingProperties`
  on the parent message handle.

- **RopSubmitMessage**: Submits the persisted message for sending via the BullMQ
  smtp-outbound queue. Builds a StructuredMessage from the
  Prisma message + loads the DKIM key of the sender domain + From/To/CC/BCC.
  Moves the message to the Sent folder after submit (or logs a
  warning on error — non-fatal). Local BullMQ queue instance on
  queue name `'smtp-outbound'` (shared convention with the
  consumer in the smtp-server, no cross-package import needed).

- **RopObject type extended**: The `message` variant now has
  `messageId: string | null`, `isDraft`, `pendingProperties` (Record),
  `pendingRecipients` (Array). The `stream` variant has
  `writable`, `parentMessageHandle` for draft streams.

- **Helper `updateRopObject`** (`rop-handle-table.ts`): Patch update
  of an existing handle object in Redis (for pending-property
  accumulation during a compose workflow).

- **PR_* constants added**: PR_EMAIL_ADDRESS_W, PR_ADDRTYPE_W,
  PR_SMTP_ADDRESS_W, PR_7BIT_DISPLAY_NAME_W, PR_RECIPIENT_TYPE,
  PR_RECIPIENT_FLAGS, PR_RECIPIENT_DISPLAY_NAME_W, PR_OBJECT_TYPE,
  PR_DISPLAY_TYPE.

- **ROP codec ModifyRecipients payload**: Until now only 64 bytes were sliced
  and the rest discarded — now the handler gets the complete
  rest of the buffer, because ModifyRecipients has no fixed size.

### Dependencies

- **`bullmq` added to the `@coremail/ews-server` dependencies** —
  for the direct queue connection to `'smtp-outbound'`.

### Outlook behavior after v4.3.0

Compose window in Outlook: create a new mail, type subject + body + recipients,
click "Send" → the mail arrives at the recipient. The Sent folder
shows the copy. Reply/Forward via the Outlook buttons works the same way
(Outlook loads the original via v4.2.0 → writes a draft via v4.3.0 → submitted).
Attachments: still empty (coming in v4.4.0). Push notification on new
mail: not yet (coming in v4.5.0).

---

## [4.2.0] — 2026-05-26 — MAPI/HTTP Phase 2: Reading mail (OpenMessage + stream read)

### Added

- **RopOpenMessage** (`packages/ews-server/src/mapi/rop/message.ts`):
  Opens a message by `FolderId` + `MessageId` from the contents table,
  stores a message handle in the session handle table. Response returns
  ReturnValue + HasNamedProperties + SubjectPrefix/NormalizedSubject + Recipients/Columns/Rows.
  Folder ID lookup via CUID→uint64 FNV-1a hash (see `entry-id.ts`).

- **RopGetPropertiesAll** + **RopGetPropertiesSpecific**: Both handlers return
  the complete list of all message properties (or a selection specified by the
  client). `buildMessagePropertyList` maps Prisma `Message` →
  MAPI properties: PR_SUBJECT_W, PR_SENDER_NAME_W, PR_SENDER_EMAIL_ADDRESS_W,
  PR_SENT_REPRESENTING_*, PR_DISPLAY_TO_W/CC_W/BCC_W, PR_MESSAGE_DELIVERY_TIME,
  PR_CLIENT_SUBMIT_TIME, PR_MESSAGE_FLAGS, PR_MESSAGE_SIZE, PR_BODY_W, PR_HTML,
  PR_MESSAGE_CLASS_W (IPM.Note), PR_HAS_ATTACH, PR_INTERNET_MESSAGE_ID_W,
  PR_PRIORITY, PR_IMPORTANCE.

- **RopOpenStream** (`packages/ews-server/src/mapi/rop/stream.ts`):
  Opens a stream on a message property. PR_BODY_W (UTF-16-LE),
  PR_HTML (UTF-8), PR_SUBJECT_W (UTF-16-LE). The property value is loaded completely
  into the stream object buffer, the response returns StreamSize.

- **RopReadStream**: Chunked read with offset tracking in the session.
  Max 30 KB per chunk (MAX_STREAM_CHUNK_BYTES) — Outlook expects
  responses under 32 KB. ReadStream request format: Uint16 ByteCount,
  or 0xBABE marker + Uint32 ExtendedByteCount for large reads.

- **RopGetStreamSize**: Returns the buffer size in bytes.

- **ROP codec extension** (`packages/ews-server/src/mapi/rop-codec.ts`):
  Parsing for OpenMessage, GetPropertiesAll, GetPropertiesSpecific,
  OpenStream, ReadStream, GetStreamSize, CreateMessage, SaveChangesMessage,
  SetProperties, SubmitMessage, WriteStream, CommitStream, SetMessageReadFlag,
  SetReadFlags. Plus stub parsing for v4.4+ ROPs (MoveCopyMessages,
  DeleteMessages, OpenAttachment, CreateAttachment, RegisterNotification,
  ModifyRecipients, ReadRecipients, RemoveAllRecipients,
  GetPropertyIdsFromNames, GetNamesFromPropertyIds) — all consume
  their payload and are answered by the dispatcher with ecNotSupported,
  so that the ROP stream does not break off.

- **ROP dispatcher extension**: Switch cases for all v4.2.0 handlers
  (real implementation) + v4.3.0 stubs (CreateMessage, SetProperties,
  SaveChangesMessage, SubmitMessage, WriteStream, CommitStream — all
  return ecNotSupported, implemented in v4.3.0).

- **RopId**: `MoveCopyMessages` (0x33) + `DeleteMessages` (0x1E) added
  in `rop-types.ts` (preparation for v4.4.0).

### Outlook behavior after v4.2.0

Profile build (Logon + folder browse from v4.1.0) is unchanged. New:
Outlook can now open the list of mails in the inbox AND display a
single mail with subject, sender, body. Writing (Reply/Forward/
Compose), sending, attachments, notifications: still ecNotSupported, coming
in v4.3.0 (composing mail) + v4.4.0 (attachments) + v4.5.0 (push).

---

## [4.1.0] — 2026-05-26 — MAPI/HTTP Phase 1: ROP infrastructure + Logon + folder browse

### Added

- **ROP stream codec** (`packages/ews-server/src/mapi/rop-codec.ts`): Parser
  for the binary ROP buffer from EcDoRpcExt2 — RopSize header, ROP header
  (RopId + LogonId + input/output handle indexes), server object handle table.
  `RopResponseBuilder` for mirroring into the response.

- **ROP types constants** (`packages/ews-server/src/mapi/rop-types.ts`):
  RopId enum with all relevant ROPs from MS-OXCROPS (Logon, OpenFolder,
  GetHierarchyTable, GetContentsTable, SetColumns, QueryRows, OpenMessage,
  CreateMessage, SubmitMessage, RegisterNotification, ...). PropType enum
  (PT_LONG, PT_UNICODE, PT_BINARY, PT_SYSTIME, etc.). Property tag dictionary
  with the most important PR_* from MS-OXPROPS (folder, mailbox, message).

- **Property codec** (`packages/ews-server/src/mapi/property-codec.ts`):
  `writePropertyValue` + `readPropertyValue` for the 8 most important
  PropertyTypes. FILETIME ↔ JavaScript Date conversion. `writeTaggedProperty`
  + `writePropertyRow` for table row serialization.

- **EntryID helpers** (`packages/ews-server/src/mapi/entry-id.ts`):
  EntryID encoder/decoder with CoreMail's own ProviderUID. CUID → uint64
  FNV-1a hash for PR_FOLDER_ID.

- **ROP handle table** (`packages/ews-server/src/mapi/rop-handle-table.ts`):
  Typed object descriptors (mailbox, folder, message, table, stream,
  attachment) persisted in the session state. `putRopObject`,
  `getRopObject`, `releaseRopObject`, `resolveHandleIndex`.

- **ROP dispatcher** (`packages/ews-server/src/mapi/rop-dispatcher.ts`):
  Main dispatch function that parses the binary Execute request, dispatches each ROP to
  its handler, collects response buffers, and builds the final
  ROP stream response.

- **Handlers v4.1.0**:
  - `rop/logon.ts`: **RopLogon** — Outlook mailbox login, loads the user from
    Prisma, builds the folder IDs array (Inbox, Drafts, Sent, Trash, Subtree),
    creates the mailbox handle in the session. Response with MailboxGuid,
    ReplGuid, LogonTime, GwartTime, StoreState.
  - `rop/folder.ts`: **RopOpenFolder**, **RopGetHierarchyTable**,
    **RopGetContentsTable** (stub count).
  - `rop/table.ts`: **RopSetColumns**, **RopQueryRows**, **RopGetRowCount**,
    **RopRelease**. Property row serialization with dynamic column selection.

- **Execute handler refactor** (`packages/ews-server/src/mapi/emsmdb-handler.ts`):
  `handleExecute` now uses `dispatchRopBuffer` instead of returning `ecNotSupported`.
  Outlook sees genuinely working ROPs.

### Skeleton files for subsequent phases

- `rop/message.ts` — v4.2.0 (reading mail) + v4.3.0 (composing mail)
- `rop/stream.ts` — v4.2.0 (read) + v4.3.0 (write)
- `rop/submit.ts` — v4.3.0 (sending mail via BullMQ bridge)
- `rop/attachment.ts` — v4.4.0
- `rop/notification.ts` — v4.5.0 (push via Redis pub/sub)
- `rop/calendar.ts` — v4.6.0 (IPM.Appointment property mapping)
- `rop/contacts.ts` — v4.7.0 (NSPI + IPM.Contact)

Each skeleton file contains a detailed implementation plan + property
mapping + Microsoft spec references.

### Tests

- 16 codec round-trip tests all green
  (uint8/16/32/64, ASCII/UTF-16-LE strings, GUIDs, complex Connect request
  sequence, range errors)

### Outlook functionality

With v4.1.0, after Connect Outlook can:
- ✅ Perform RopLogon successfully
- ✅ Request the folder hierarchy table
- ✅ See the standard folders (Inbox, Drafts, Sent, Trash)
- ❌ Read mails (coming in v4.2.0 — `OpenMessage`/`GetProperties`/`ReadStream`)
- ❌ Write mails (coming in v4.3.0)
- ❌ Push notifications (coming in v4.5.0)

The Outlook profile build gets considerably further after Connect than in v4.0.0, but
the first mail click will return ecNotSupported.

---

## [4.0.0] — 2026-05-26 — MAPI-over-HTTP foundation + External Clients setup page

**Major version bump**: Start of the MAPI-over-HTTP implementation for native
Outlook Exchange integration. This foundation lays down the protocol layer, codec,
session store, architecture plan. Full Outlook functionality comes iteratively
in v4.0.x / v4.1.0+ (see `packages/ews-server/src/mapi/ARCHITECTURE.md`).

### Added

- **MAPI/HTTP foundation** (`packages/ews-server/src/mapi/`):
  - `ARCHITECTURE.md`: Complete implementation plan incl. protocol
    layer, ROP mapping, version roadmap v4.0.0 → v5.0.0
  - `codec.ts`: Binary buffer reader/writer for the MS-OXCRPC wire format
    (little-endian uint8/16/32/64, ASCII/UTF-16-LE null-terminated strings,
    GUIDs in MS-DTYP format, AUX header blocks)
  - `codec.test.ts`: 16 round-trip tests for all read/write pairs (all green)
  - `http-headers.ts`: Header parsing + response header setting (X-RequestType,
    X-RequestId, X-ResponseCode, X-ExpirationInfo, X-PendingPeriod,
    Set-Cookie management)
  - `session-store.ts`: Redis-backed session store for emsmdb + nspi with
    10-min TTL and auto-renew on every call
  - `emsmdb-handler.ts`: Binary Connect/Disconnect/NotificationWait functional;
    Execute returns `ecNotSupported` (ROPs come in v4.1.0+)
  - `handler.ts` refactor: Express `raw()` body parser for `/mapi/emsmdb/` +
    `/mapi/nspi/` (binary bodies instead of JSON)

- **Autodiscover MAPI/HTTP protocol block** (feature-flagged):
  Env `ENABLE_MAPI_HTTP=true` enables `<Protocol Type="mapiHttp" Version="1">`
  in the Autodiscover response. Default off, because ROP execution is not yet
  functional. Once RopLogon+folder browse are done in v4.1.0: default on.

- **Setup page "External Clients & Outlook" in OWA** (pulled forward from v3.18.40):
  `packages/web-client/src/pages/SettingsPage.tsx` new section + backend
  endpoint `GET /api/v1/user/client-config`. Shows IMAP/SMTP data, CalDAV
  + CardDAV URLs, app-password notice with MFA, step-by-step for the "Outlook
  CalDav Synchronizer" plugin (free, OSS) — until MAPI/HTTP fully
  works, the mature solution for calendar + contacts in Outlook.

### Roadmap (v4.x — see `ARCHITECTURE.md`)

| Version | Content | Effort |
|---------|--------|---------|
| v4.0.0  | Foundation (codec, session, Connect handshake)         | ✅ current |
| v4.1.0  | RopLogon + folder browse (Outlook can log in + see folders) | ~2 wks |
| v4.2.0  | Reading mail (RopGetContentsTable, OpenMessage, Stream)   | ~2 wks |
| v4.3.0  | Composing + sending mail (CreateMessage, SubmitMessage)  | ~1 wk |
| v4.4.0  | Attachments + Move/Delete                                | ~1 wk |
| v4.5.0  | Push notifications (NotificationWait + Redis pub/sub)   | ~2 wks |
| v4.6.0  | Calendar (IPM.Appointment)                              | ~3 wks |
| v4.7.0  | Contacts (NSPI QueryRows + IPM.Contact)                 | ~2 wks |
| v4.8.0  | Search (RopFindRow, Restrict)                            | ~2 wks |
| v5.0.0  | Production hardening + Outlook compat tests             | ~4 wks |

**Estimated total effort**: 6–9 months for a 2-person team.

### Migration / Breaking

No breaking changes — all existing functions unchanged. Outlook
continues to use the IMAP fallback from v3.18.39 until v4.1.0.

---

## [3.18.40] — 2026-05-26 — External Clients & Outlook setup page in OWA

### Added

- **New OWA settings section "External Clients & Outlook"**
  (`packages/web-client/src/pages/SettingsPage.tsx`, `packages/api-gateway/src/routes/user.ts`):
  Central setup help page for all external clients. Prominently shows:
  - **IMAP/SMTP/POP3 data** with copy buttons (host, port, encryption)
  - **CalDAV account URL** + direct URLs per calendar
  - **CardDAV account URL** + default address book URL
  - **App-password notice** when MFA is active
  - **Step-by-step guide for "Outlook CalDav Synchronizer"**
    (free OSS plugin) — use calendar + contacts via Outlook
  - **Notes on alternatives**: OWA in the browser, Apple Calendar/Contacts,
    Thunderbird + TbSync, eM Client, DAVx⁵ (Android)

- **New backend endpoint** `GET /api/v1/user/client-config`
  (`packages/api-gateway/src/routes/user.ts`): Returns all setup data
  consolidated — email/displayName, IMAP/SMTP/POP3 hosts from `ServerSettings`,
  CalDAV account URL + per calendar, CardDAV account + default URL,
  `requiresAppPassword` flag based on the user's MFA status.

### Background

Microsoft Outlook Desktop has no native CalDAV/CardDAV support built in.
A full MAPI-over-HTTP implementation (for native Outlook Exchange integration
with calendar + contacts) is several weeks of work and comes as a separate
future feature. Until then, the "Outlook CalDav Synchronizer"
(GitHub: `aluxnimm/outlookcaldavsynchronizer`) is the mature OSS plugin
path for Outlook users. The new settings page bundles all necessary data
+ provides the installation guide directly in the UI.

---

## [3.18.39] — 2026-05-26 — Outlook: EXCH+EXPR removed from Autodiscover → IMAP fallback

### Fixed

- **Outlook LTSC hung for minutes in an RPC/TCP connect loop, then error
  "This set of folders cannot be opened — error logging on
  to Exchange"** (`packages/autodiscover/src/v1.ts`): The user's connection status
  showed several VIDs with status "connecting" and protocol **RPC/TCP**
  on `mail.<domain>`. Root cause: Our Autodiscover response returned
  `<Protocol Type="EXCH">` and `<Protocol Type="EXPR">` blocks — both
  signal to Outlook that the server supports **MAPI/RPC** (intra-Exchange RPC
  or RPC-over-HTTPS via `rpcproxy.dll`). But we have only implemented **EWS** + stubs
  of MAPI-over-HTTP. Outlook attempted RPC connects for minutes,
  which hung.

  **Pragmatic fix** until the full MAPI/HTTP implementation:
  **EXCH and EXPR blocks REMOVED** from the Autodiscover XML. Outlook recognizes:
  - The server is not an Exchange server for direct MAPI profiles
  - Automatically falls back to **IMAP account configuration**
  - Mail works immediately via `<Protocol Type="IMAP">` + `<Protocol Type="SMTP">`
  - Calendar + contacts go via CalDAV/CardDAV (Apple Calendar,
    Thunderbird, eM Client) or directly via OWA in the browser

  Outlook then automatically configures the account as "IMAP" (the user still
  sees the email-address-only setup flow, but the connection becomes
  IMAP instead of Exchange).

### Roadmap

A full MAPI-over-HTTP implementation (`EcDoConnectEx`, ROP verbose binary
protocol, NSPI Bind/QueryRows) for native Outlook Exchange integration is
several weeks of work. Until then, IMAP is the pragmatic path for
Outlook desktop users.

---

## [3.18.38] — 2026-05-26 — Outlook LTSC "no password prompt" + Autodiscover completion

### Fixed

- **CRITICAL ROOT CAUSE: EWS answered the first request with 200 OK
  instead of 401 — Outlook never asks for a password** (`packages/ews-server/src/server.ts`):
  User symptom: Outlook "connected" after Autodiscover without a credential
  prompt, but then only showed "Personal Folders" (local PST) instead of the
  Exchange mailbox, plus the error message "The Microsoft Exchange information service
  in your profile is missing required information". Root cause:
  Outlook LTSC first probes `GET /EWS/Exchange.asmx` BEFORE it sends
  any `Authorization` header at all. The previous GET handler returned
  200 + WSDL stub unauthenticated → Outlook assumed no
  auth was needed, never sent credentials, and the setup landed on the
  local default PST ("Personal Folders"). **Fix**: `ewsAuthMiddleware` now
  also before the GET handler and before the `/mapi/*` router (except
  `/mapi/healthcheck.htm` — stays anonymous for the Outlook probe). MAPI and
  OAB endpoints now also correctly send `WWW-Authenticate: Basic
  realm="CoreMail EWS"` when the auth header is missing.

- **`auth-service` URL was wrong** (`packages/ews-server/src/auth/middleware.ts`):
  The Basic-Auth fallback in EWS called `http://auth-service:3001/auth/login` —
  but port 3001 is the `storage-api`, not the `auth-service` (which runs on
  3003). Plus, in the monolithic app container everything is reachable under
  `localhost`, not under service hostnames. Fix: env variable
  `AUTH_SERVICE_URL` with default `http://localhost:3003/auth/login`.

- **Autodiscover v1 XML had Outlook-mandatory fields missing or wrong**
  (`packages/autodiscover/src/v1.ts`): Research of Microsoft Docs +
  the Grommunio implementation showed:
  - `AuthPackage` MUST be `Basic` (capital B) — some Outlook LTSC builds
    are case-sensitive. Was `basic` (lowercase b).
  - `<User><LegacyDN>` mandatory: Outlook uses it as the internal user identity
    (format `/o=CoreMail/ou=Exchange Administrative Group
    (FYDIBOHF23SPDLT)/cn=Recipients/cn=<user-id>`). Was missing completely.
  - `<User><AutoDiscoverSMTPAddress>` added (mandatory for profile binding).
  - `<GroupingInformation>default</GroupingInformation>` in the EXPR block —
    required since Exchange 2013 SP1 for sharing discovery.
  - `<PublicFolderInformation><SmtpAddress>publicfolder@<root-domain>` as
    dummy — otherwise Outlook logs "PublicFolder discovery failed" and
    classifies the profile as incomplete.
  - `ServerDN`/`MdbDN` with correct Exchange 2019 topology
    (`Exchange Administrative Group (FYDIBOHF23SPDLT)` instead of just
    `Exchange`).
  - `<EcpUrl>` added (points to OWA — Outlook uses it for the web-open link).

### Background research

Sources: Microsoft Learn (MS-OXDSCLI, MS-OXCMAPIHTTP, POX Autodiscover),
msxfaq.de (HTTP 401 Negotiate flow), Grommunio Docs (KB Outlook bugs),
Mailcow Docs (no EWS, hence no Outlook Exchange support). Comparisons
with Stalwart + Mailcow (open-source mail servers) confirm: without EWS +
correct 401 behavior, Outlook cannot build Exchange profiles.

---

## [3.18.37] — 2026-05-26 — Outlook LTSC Autodiscover XML extended + audit translations

### Fixed

- **Outlook LTSC (Exchange 2019) could not connect despite correctly
  delivered Autodiscover** (`packages/autodiscover/src/v1.ts`): The
  XML response had only a minimal `<Protocol><Type>EXCH</Type>...`
  block without `AuthPackage`, `OABUrl`, `ASUrl`, `OOFUrl`, `MdbDN`,
  `ServerVersion` and without the **EXPR block** (Outlook Anywhere / MAPI-
  over-HTTP fallback). Outlook 2016+ strictly expects these fields —
  without them the setup wizard aborts with "Something went wrong".

  **Fix**: Autodiscover v1 XML extended with:
  - `<AuthPackage>basic</AuthPackage>` (Outlook needs an explicit auth type)
  - `<ServerVersion>73C0834F</ServerVersion>` (Exchange-2019-compatible server version token)
  - `<MdbDN>` + `<ServerDN>` (Exchange topology identifiers)
  - `<ASUrl>`, `<OOFUrl>`, `<OABUrl>` (Availability Service, Out-of-Office, Offline Address Book)
  - `<EmwsUrl>` (Exchange Management Web Service)
  - `<OWAUrl AuthenticationMethod="Basic, Fba">`
  - **Completely new `<Protocol><Type>EXPR</Type>` block** for Outlook Anywhere
    /MAPI-over-HTTP (SSL=on, AuthPackage=basic, ServerExclusiveConnect=on)
  - `<MicrosoftOnline>False</MicrosoftOnline>` (signals an on-premises setup)

- **Audit log: legacy action strings (before the v3.18.34 path fix) not translated**
  (`packages/admin-panel/src/pages/AuditLogPage.tsx`): Old audit entries
  before the path-mutation fix were stored with short action strings (`anomalies.get`,
  `full.post`, `jobs.delete`, `tags.post`, `members.delete`).
  The v3.18.34 `ACTION_MAP` only had the NEW long forms (e.g.
  `audit-log.anomalies.get`). **Fix**: 25+ additional entries for
  legacy short forms + new v3.18.37 formats (`servers.settings.put`,
  `servers.settings.derive.post`, `retention.tags.*`, `dashboard.get`,
  `services.put`, etc.).

- **Audit log actor column: empty `actorEmail` showed nothing at all**
  (`packages/admin-panel/src/pages/AuditLogPage.tsx`): For system actions
  (e.g. cron-triggered) `actorEmail` is empty. Fix: fallback display
  `System (cmpla8p1…)` instead of an empty cell.

---

## [3.18.36] — 2026-05-26 — Hostname auto-derive + image privacy banner hardened

### Fixed

- **Server URLs are now derived dynamically from `publicHostname` —
  no longer fixed to `mail.local:8080`** (`packages/api-gateway/src/lib/server-urls.ts`,
  `packages/api-gateway/src/routes/setup.ts`, `packages/api-gateway/src/routes/admin/domains.ts`):
  Previous behavior: schema defaults write `ewsUrl`/`owaUrl`/`easUrl`/
  `autodiscoverBase` as `http://mail.local:8080/...` at first container
  start. Anyone configuring a real domain (e.g. `mail.firma.de`) had to
  change the URLs manually in BCP → Server settings, otherwise
  Autodiscover gave Outlook unusable URLs. That works for 1 test user
  manually, but NOT for the 1000+ users with individual domains.

  **Fix**: New central helper `lib/server-urls.ts` with:
  - `deriveServerUrls(publicHostname, useHttps, httpPort)` — computes all
    URLs from the hostname (Autodiscover host per Microsoft spec
    `autodiscover.<root-domain>`).
  - `syncFromPrimaryDomain(domainName)` — sets `publicHostname` to
    `mail.<domain>` if it is still the default, derives all URLs.
  - `syncServerUrlsFromHostname()` — idempotent re-sync, runs at
    api-gateway start AND can be called from outside.

  Hooked into:
  - `POST /api/v1/setup/complete` — the setup wizard saves, in one
    transaction, domain + admin user + `publicHostname=mail.<setup-domain>` +
    all derived URLs. Previously `publicHostname=mail.local` remained.
  - `POST /api/v1/admin/domains` — when the first domain is created
    (= automatically `primary=true`), hostname + URLs are derived
    from it.
  - `POST /api/v1/admin/domains/:id/make-primary` — when another
    domain becomes primary, URLs are only switched to the new hostname
    if `publicHostname` is still the default. An already
    explicitly set configuration is respected.
  - `PUT  /api/v1/admin/servers/settings` — on save with stale URLs
    (`mail.local` or `:8080`) they are updated automatically.
  - api-gateway startup — as a safety net for existing installations.

  A Redis publish on `coremail:settings:reload` informs the autodiscover
  service immediately, so Outlook never sees outdated URLs.

### Fixed (additionally)

- **The image privacy banner from v3.18.10 did not work in practice** —

- **The image privacy banner from v3.18.10 did not work in practice** —
  external images were loaded directly, the blue "X external images were
  blocked" banner never appeared (`packages/web-client/src/components/MessageReader.tsx`):
  Root cause: `DOMPurify.sanitize(html)` ran WITHOUT configuration and removed
  our privacy markers (`data-coremail-ext-src` attribute, transparent
  `data:image/png;base64,...` placeholder as src) by default. Thus the
  blocking mechanism was immediately undone again by the sanitize step.

  **Fix**: `sanitize()` rebuilt with explicit configuration:
  - `ADD_ATTR: ['data-coremail-ext-src', 'data-coremail-unresolved-cid',
    'data-coremail-ext-bg']` — our markers allowed
  - `ALLOWED_URI_REGEXP` allows `data:image/...;base64,...` (placeholder)
  - `FORBID_TAGS: ['script', 'style', 'link', 'iframe', 'object', 'embed',
    'meta', 'base']` — tracking vectors out
  - `FORBID_ATTR: ['onload', 'onerror', 'onclick', …, 'srcset']` —
    event handlers + responsive-image trackers out

### Added

- **CSS `background-image: url(...)` is also blocked**
  (`packages/web-client/src/components/MessageReader.tsx`): Common tracker
  vector in HTML mails (e.g. `<div style="background-image:url(http://tracker
  .com/pixel.png)">`). `processExternalImages()` extracts `background-image`
  from inline `style` attributes, neutralizes external URLs and stores the
  original in `data-coremail-ext-bg`. On the "Show images" click the
  CSS property is reinserted.

### Changed

- **"Show images" toggle additionally cleans up placeholder styles**
  (`packages/web-client/src/components/MessageReader.tsx`): The thin
  dashed border + `opacity:0.5` that marks blocked images
  is removed automatically after the click — images appear normally instead of
  still "dimmed" with a border.

---

## [3.18.35] — 2026-05-26 — Outlook LTSC connection fix (Autodiscover routing + URL auto-sync)

### Fixed

- **CRITICAL: Outlook LTSC "Something went wrong" — Autodiscover endpoint
  returned an Express 404**
  (`packages/api-gateway/src/server.ts`): The API gateway routed
  `/Autodiscover/Autodiscover.xml` and `/autodiscover/autodiscover.json/v1.0/...`
  to the **EWS server** (port 8080), although no Autodiscover routes are
  implemented there at all. The **autodiscover server** on port 8081 has the real
  handlers (`handleAutodiscoverV1` + `handleAutodiscoverV2`), but was never
  called. Outlook got `Cannot POST /Autodiscover/
  Autodiscover.xml` (Express default 404) from the EWS server and therefore could not configure.
  **Fix**: New env variable `AUTODISCOVER_SERVICE_URL` (default
  `http://localhost:8081`). Routes `/Autodiscover` and `/autodiscover` are
  now correctly proxied to the autodiscover server.

- **EWS/OWA/EAS URLs pointed to the internal port :8080** instead of the
  external HTTPS port (`packages/api-gateway/src/server.ts`,
  `packages/api-gateway/src/routes/admin/servers.ts`): During setup the
  `ewsUrl`/`owaUrl`/`easUrl`/`autodiscoverBase` fields in `ServerSettings`
  were initially filled with `http://mail.local:8080/...` (schema defaults). When
  the admin later changed `publicHostname` (e.g. via BCP → Server
  settings), the derived URLs were NOT migrated along →
  Autodiscover delivered internal URLs unreachable for Outlook.
  - **Startup migration** (`syncAutodiscoverUrls()`): At api-gateway start,
    URLs are auto-corrected if `publicHostname != mail.local` but the URLs
    still contain `mail.local` or `:8080`. Computes `ewsUrl`/`owaUrl`/
    `easUrl` from `publicHostname` + `useHttps` + `httpPort` and
    `autodiscoverBase` from the root domain (Microsoft spec:
    `autodiscover.<root-domain>`).
  - **PUT /admin/servers/settings** also repairs stale URLs on save
    automatically when the admin saves the hostname without adjusting URLs.

- **Autodiscover settings cache TTL 60s** delayed the visibility of
  URL changes (`packages/autodiscover/src/server.ts`): The autodiscover
  service had a 60-second in-memory cache for `ServerSettings`, without
  Redis subscription. **Fix**: Subscription to channel
  `coremail:settings:reload` — `invalidateSettingsCache()` is called immediately on
  settings update, so new URLs are active without the 60s wait.

---

## [3.18.34] — 2026-05-26 — Audit log path fix + backup watchdog + UX cleanup

### Fixed

- **CRITICAL: Audit log showed unreadable CUID actions** such as
  `cmplad51y000v13k3j0nbipt5.post` instead of `certificates.activate-https.post`
  (`packages/api-gateway/src/lib/audit.ts`). Root cause: `auditMiddleware` read
  `req.path` INSIDE the `res.on('finish')` callback. By that time
  Express had already mutated the path while descending into sub-routers — for
  `POST /api/v1/admin/certificates/<cuid>/activate-https`, `req.path`
  then only showed `/<cuid>/activate-https` (relative to the certificates sub-router
  mount) instead of `/certificates/<cuid>/activate-https`. From this the
  action builder wrongly built `<cuid>.post`. **Fix**: `req.path` is now
  stored in `capturedPath` at middleware entry and used in the finish
  callback. **Additionally**: new **CUID-aware action builder**
  (`buildAction()`) — CUIDs are filtered out of the action string and
  stored separately as `targetId`. `DELETE /backups/jobs/<cuid>` now becomes
  `action='backups.jobs.delete'` + `targetId=<cuid>`.

### Added

- **40+ new action translations in the audit log**
  (`packages/admin-panel/src/pages/AuditLogPage.tsx` `ACTION_MAP`): New
  mappings for `backups.jobs.delete` → "Backup job deleted",
  `audit-log.anomalies.get` → "Anomaly report retrieved",
  `certificates.activate-https.post` → "Certificate activated for HTTPS",
  `settings.security.put` → "Security settings changed",
  `groups.members.delete` → "Group member removed" and many more for
  certificates, aliases, Shared Mailboxes, transport rules, quarantine, queues,
  OAuth clients, backup schedules.

- **Backup service: startup orphan cleanup + watchdog**
  (`packages/backup-service/src/server.ts`):
  - **Orphan cleanup** at start: backup jobs with status `RUNNING`/`PENDING`/
    `RETRYING`/`PROCESSING`/`SCHEDULED` older than 60s are automatically marked as
    `FAILED` with `errorMsg='Container wurde während Backup
    neugestartet — Job abgebrochen.'` Prevents the "backup runs forever" UI
    display after a container restart.
  - **Watchdog timer** (every 5 min): jobs with status `RUNNING`/`PROCESSING`/
    `RETRYING` older than 30 min are marked as `FAILED` with
    `errorMsg='Watchdog: Job > 30 Min. ohne Fortschritt — abgebrochen.'`

### Changed

- **Backup schedule editor: minute-exact (0..59) instead of a 5-minute grid**
  (`packages/admin-panel/src/pages/BackupsPage.tsx`): Previously the admin
  could only choose the minute in steps of 5 (12 options). Now all 60 minutes
  (0..59) available — user request.

### Removed

- **Red "Anomalies detected" banner removed from the audit log**
  (`packages/admin-panel/src/pages/AuditLogPage.tsx`): The banner above the
  audit table (with "2 anomalies detected — evaluation: last 5 min bursts,
  24h critical actions, off-hours") was confusing in practice — among other things it
  showed one's own settings changes as a "critical action". The audit log
  itself shows all relevant actions with clear color coding (red =
  deletions, amber = critical, blue = updates). `anomalies` query +
  `AnomaliesResponse` interface completely removed. Backend endpoint
  `/admin/audit-log/anomalies` is kept (can still be retrieved via PDF/JSON
  export).

---

## [3.18.33] — 2026-05-26 — External contacts completely removed

### Removed

- **Feature "External contacts" (ExternalMailContact) completely removed from the code.**
  External recipients are from now on:
  - entered directly as an email address in the compose window (Outlook standard),
  - maintained as `EXTERNAL` members of distribution groups — the member type
    `EXTERNAL` in `DistributionGroupMember` remains unchanged.

  Rationale: Maintaining a separate external address book was rarely used in
  practice — external addresses are typically relevant individually per
  user (private contacts) or per group (e.g. "supplier distribution list").
  Reduces code complexity, simplifies the GAL view (users + distribution groups)
  and removes a maintenance point in the BCP. Analogous to v3.18.5 (eDiscovery) and
  v3.18.31 (Public Folders).

  **Schema** (`packages/storage/prisma/schema.prisma`):
  - Model `ExternalMailContact` removed
  - Table `external_mail_contacts` is dropped at container start via
    `prisma db push --accept-data-loss`
  - **Migration is destructive**: all existing external contacts are
    lost

  **Backend** (`packages/api-gateway/src/`):
  - `routes/admin/external-contacts.ts` — deleted (admin CRUD)
  - Route mount `/api/v1/admin/contacts` removed
  - `routes/contacts.ts`:
    - `/contacts?q=…` (compose autocomplete) now only returns users + distribution groups
    - `/contacts/gal` (browse GAL): the `type=external` filter returns an empty list,
      so that old frontend calls do not break

  **BCP** (`packages/admin-panel/src/`):
  - `pages/ExternalContactsPage.tsx` — deleted
  - `components/Sidebar.tsx` — entry "Ext. contacts" + `BookUser` icon import removed
  - `main.tsx` — route `/ext-contacts` + import removed
  - `i18n/translations.ts` — i18n keys `nav_ext_contacts` (DE+EN) removed
  - `pages/GroupsPage.tsx` — `ext-` prefix branches in `pickSuggestion()` and
    `typeBadge` map removed (dead code since the GAL no longer returns `ext-` IDs)

  **MWA** (`packages/web-client/src/`):
  - `pages/ContactsPage.tsx` — GAL filter toggle "External" removed; detail panel
    only renders `USER`/`GROUP` kinds; `EXTERNAL` conditional renders removed

---

## [3.18.32] — 2026-05-26 — TLS proxy: SNI multi-cert support (Outlook Autodiscover fix)

### Fixed

- **Outlook Autodiscover reported a "certificate error" despite a correctly issued
  `autodiscover.<domain>` certificate** (`packages/api-gateway/src/tls-proxy.ts`):
  The integrated HTTPS proxy (port 443) loaded only the one certificate with
  `isActiveHttps=true` and served ALL incoming TLS connections with it.
  When Outlook accessed `https://autodiscover.<domain>/Autodiscover/Autodiscover.xml`,
  the client saw the `mail.<domain>` certificate → hostname mismatch →
  `ERR_CERT_COMMON_NAME_INVALID` / Outlook showed a certificate warning.

  **Fix**: TLS proxy refactored to **SNI multi-cert support**.
  - On reload, ALL certs with `status='ACTIVE'` are loaded, not just the one
    with `isActiveHttps=true`.
  - Per cert a `tls.SecureContext` is created and assigned to all hostnames
    (CN + all SANs from the PEM + `domains[]` array from the DB).
  - Wildcard certs (`*.example.com`) are kept separately and resolved via suffix
    match (RFC 6125 — exactly one sub-label level).
  - `SNICallback` selects per connection based on the server name sent by
    the client: exact match → wildcard match → default cert.
  - The default cert (for unknown SNI or connections without SNI) is the cert
    with `isActiveHttps=true`; fallback: the newest ACTIVE cert.

- **Newly issued ACME + self-signed + uploaded certs now immediately trigger
  `coremail:tls:reload`** (`packages/api-gateway/src/routes/admin/certificates.ts`):
  Previously the reload was only triggered on the manual "Enable HTTPS" click (toggle
  `isActiveHttps`) — with multi-cert SNI, however, all ACTIVE certs should be
  available immediately without anyone toggling HTTPS. Trigger added in
  three code paths: ACME issuance (Let's Encrypt issuance), self-signed
  generation, cert upload.

### Migration

Existing setups: On the first reload after deploy the SNI map is built automatically
from all ACTIVE certs. Existing connections are not interrupted.
Anyone who has not yet issued the `autodiscover.<domain>` cert: BCP → SSL/TLS →
request an ACME certificate with domain `autodiscover.<domain>` — after that
Outlook Autodiscover works immediately, without having to click "Enable HTTPS".

---

## [3.18.31] — 2026-05-25 — Public folders completely removed

### Removed

- **Feature "Public Folders" completely removed from the code.**
  The Exchange-style concept (with ACL `READ`/`WRITE`/`FULL` + mail-enabled variant
  since v3.18.9) is hardly used by the market today. Modern teams prefer
  **Shared Mailboxes** (`/admin/shared-mailboxes/`) and **distribution groups**
  (`/admin/groups/`) for the typical use cases (team mailbox, distribution list,
  collaborative inbox). Reduces code complexity and maintenance effort —
  analogous to v3.18.5 (eDiscovery/LegalHold removal).

  **Backend** (`packages/api-gateway/src/`):
  - `routes/public-folders.ts` — deleted (user endpoints `GET/POST/PUT/DELETE`)
  - `routes/admin/public-folders.ts` — deleted (admin CRUD + ACL management)
  - `server.ts` — mount points `/api/v1/public-folders` + `/api/v1/admin/public-folders` removed

  **SMTP server** (`packages/smtp-server/src/`):
  - `inbound/handler.ts` `verifyRecipient()` — `publicFolder.findFirst()` lookup removed
  - `handlers/message.ts` `storeInboundMessage()` — public-folder branch removed;
    mails to former public-folder addresses are now discarded as unknown
    recipient (standard handling)

  **BCP** (`packages/admin-panel/src/`):
  - `pages/PublicFoldersPage.tsx` — deleted
  - `components/Sidebar.tsx` — entry "Public folders" + `FolderOpen` icon import removed
  - `main.tsx` — route `/public-folders` + import removed
  - `i18n/translations.ts` — i18n keys `nav_public_folders` (DE+EN) removed

  **MWA** (`packages/web-client/src/`):
  - `components/FolderTree.tsx` — section `PublicFoldersSection` + `PublicFolderViewerModal`
    components + unused icon imports (`FolderTree`, `X`, `Mail`) removed

  **Database** (`packages/storage/prisma/schema.prisma`):
  - Models `PublicFolder` + `PublicFolderMessage` removed
  - Tables `public_folders` + `public_folder_messages` are dropped at container start
    via `prisma db push --accept-data-loss`
  - **Migration is destructive**: all existing public folders + their
    mails are lost (comparable to the eDiscovery removal in v3.18.5)

---

## [3.18.30] — 2026-05-25 — BigInt crash fix + audit log toggle + audit translations

### Fixed

- **CRITICAL: backup-service crash loop due to `BigInt` serialization**
  (`packages/backup-service/src/server.ts`): Since v3.18.26 `BackupJob.sizeBytes`
  has the Prisma type `BigInt` (for correct representation of backup sizes > 4 GB).
  On the first call to `/jobs` or `/users` Node threw
  `TypeError: Do not know how to serialize a BigInt` → supervisord restarted the
  container endlessly → **ALL backup endpoints returned 500**, which in turn explains the
  symptoms reported by the user:
  - "Back up single mailbox shows no users" → `/users` crashed
  - "Jobs shows no status" → `/jobs` crashed
  Fix: Global monkey patch of `express.response.json` at module top with a
  recursive `BigInt → string` replacer in `JSON.stringify`. Thus applies to
  all existing and future endpoints without individual handlers having to be
  adjusted.

### Added

- **Audit log toggle in the security settings**
  (`packages/storage/prisma/schema.prisma`,
  `packages/api-gateway/src/lib/audit.ts`,
  `packages/api-gateway/src/routes/admin/global-settings.ts`,
  `packages/admin-panel/src/pages/SettingsPage.tsx`):
  New field `ServerSettings.auditLogEnabled` (default `true`) allows
  admins to switch global audit logging on/off. Toggle in
  BCP → Settings → Security. **Critical-action override**: regex
  `ALWAYS_AUDIT` (`/^(settings\.|audit\.|user\.role|oauth\.client|mailbox\.delete|domain\.delete)/i`)
  ALWAYS logs security- and compliance-relevant actions — even with the
  toggle switched off. Compliance background (GDPR Art. 32, SOX, HIPAA,
  TISAX, ISO 27001): otherwise an admin could switch off audit, exfiltrate
  data and switch it back on — undetected. The toggle change
  itself is logged as `audit.enabled` / `audit.disabled` with a diff in the
  `changes` field. **In-memory cache** (60s TTL) prevents a
  DB hit on every audit write; invalidation via `invalidateAuditCache()`
  after every save.

- **Human-readable action labels in the audit log**
  (`packages/admin-panel/src/pages/AuditLogPage.tsx`):
  Actions such as `settings.put` or `mailboxes.delete` are now translated with
  an `ACTION_MAP` into readable descriptions — e.g.
  "Settings changed", "Mailbox deleted", "Full backup started",
  "Calendar shared", "Audit log DISABLED" (with red critical tone).
  Over 40 mappings for settings, mailboxes, domains, auth, OAuth, backups,
  calendar sharing, rules, roles, gateway. Hover tooltip shows the
  original action string for SIEM cross-references. Heuristic fallback by
  verb (`post`/`create`/`delete`/...) for unknown actions.

---

## [3.18.29] — 2026-05-25 — Backup archive: download + delete for S3 objects

### Added

- **Download and delete buttons in the "Backup Archive" tab**
  (`packages/backup-service/src/server.ts`,
  `packages/api-gateway/src/routes/admin/backups.ts`,
  `packages/admin-panel/src/pages/BackupsPage.tsx`):
  Previously the archive table was read-only — users could not download or delete
  objects individually. Now two new backend endpoints:
  - `GET /backup/admin/archive/download?key=<s3-key>` — stream proxy for
    direct download (analogous to the `download/:jobId` endpoint, but for
    objects without a BackupJob reference, e.g. old/external imports)
  - `DELETE /backup/admin/archive?key=<s3-key>` — deletes the S3 object
    and additionally nulls matching `BackupJob.downloadUrl` fields
    (status → EXPIRED) so the UI no longer shows a broken link
  Frontend: new action column with download (HardDriveDownload) and
  trash button. Confirm dialog before delete ("delete permanently, cannot
  be undone"). Audit log entry `backup.archive.delete`.

---

## [3.18.28] — 2026-05-25 — Calendar+backup UX fixes (hook bug, tabs, delete, time input)

### Fixed

- **CRITICAL: Reopening a created appointment → white page**
  (`packages/web-client/src/components/EventEditDialog.tsx`):
  React Rules-of-Hooks violation — `useMemo(currentCal)` was called AFTER an
  `if (existingLoading) return`. On the first render: 0 memos,
  on the second: 1 memo → React crash with "Rendered more hooks than during
  the previous render". Result: completely white modal page, no reaction.
  **Fix**: all hooks placed BEFORE every early return.

- **Backup jobs could neither be deleted nor downloaded**:
  The download URL pointed to `http://minio:9000` (Docker-internal, not reachable
  from the browser). The delete endpoint was missing completely.
  **Fix download**: new stream proxy endpoint `GET /admin/backups/download/:jobId`
  in the backup-service streams the S3 object through the api-gateway to the browser.
  Frontend uses fetch + Blob + `URL.createObjectURL` for a clean file
  download.
  **Fix delete**: new endpoint `DELETE /admin/backups/jobs/:id` deletes the DB
  record + S3 object (best-effort, no throw on missing S3 object).
  Delete button in every job row with confirmation dialog.

### Changed

- **Save button in the event dialog now bottom right** (previously header
  toolbar top left). Standard Outlook/Office pattern. Footer with gray
  background: delete button left, cancel + save right.

- **Time input instead of dropdown-only**
  (`packages/web-client/src/components/EventEditDialog.tsx`):
  Previously a `<select>` with 96 options (15-min) — the user could not enter a custom time
  such as "13:42". Now `<input type="time" list="...">` with
  `<datalist>` — the browser shows 15-min suggestions as a dropdown on focus,
  but the user can freely type any time.

- **BackupsPage completely refactored as a tab layout**:
  5 tabs ("Jobs", "Quick actions", "Schedules", "Backup Archive",
  "Restore (Import)") with badge counters. Previously all sections were
  stacked one below the other — clearer and more mobile-friendly.

- **"S3 Snapshots" renamed to "Backup Archive"** — AWS term avoided,
  clearer language. The tab is called "Backup Archive".

- **Schedule editor with complete dropdowns**: frequency dropdown
  (Hourly/Daily/Weekly/Monthly/Custom), weekday dropdown
  (Mon–Sun), hour dropdown (0–23), minute dropdown (steps of 5), day-of-
  month dropdown (1–28), retention dropdown (preselected values
  7/14/30/60/90/180/365/730/1825/3650). The cron expression is generated in the background
  and shown as a read-only hint. Only with "Custom" does the user see
  the cron text field directly.

### Added

- `streamObject()` + `deleteObject()` helpers in
  `packages/backup-service/src/upload/s3.ts`
- Audit log entry `backup.job.delete` for deleted backup jobs

---

## [3.18.27] — 2026-05-25 — Outlook-style event dialog (edit/delete/reschedule/notes/time picker)

### Fixed

- **Clicking an existing appointment only opened a "Delete?" dialog**
  (`packages/web-client/src/pages/CalendarPage.tsx`):
  Before: `confirm('Termin XYZ löschen?')` — the user could not edit the
  appointment. **Fix**: Clicking now opens a full edit dialog with all
  details (title, date, time, guests with status, location, notes, classification).
  Permission check via the `canWrite` flag in the GET response: with a READ share the
  dialog is rendered read-only with a "Read-only access" badge.

- **Date/time input was fiddly (datetime-local)**:
  Typing the time manually, no dropdown — cumbersome especially on mobile.
  **Fix**: Separate date inputs + time dropdowns with 15-minute steps
  (00:00 to 23:45 = 96 options). The "All day" checkbox hides the time fields.

### Added

- **`EventEditDialog` component (Outlook-style)**
  (`packages/web-client/src/components/EventEditDialog.tsx`):
  Full modal dialog for create + edit with:
  - **Header toolbar**: Save, Delete (edit only), status refresh, Close
  - **Calendar picker**: color dot + dropdown (disabled in edit mode)
  - **Title input**: Outlook-style large heading
  - **Attendee list with live PARTSTAT badges**:
    - Green CheckCircle for ACCEPTED, red XCircle for DECLINED,
      amber HelpCircle for TENTATIVE, gray Clock for NEEDS-ACTION
    - Autocomplete input with keyboard nav (↑↓/Enter/Tab/Esc) reusing `/contacts?q=`
    - Counter at the bottom: "X accepted · Y declined · Z maybe · N pending"
    - Status refreshes automatically every 30 seconds (live!)
  - **Date+time pickers**: HTML date input + time dropdown (15-min steps),
    the end date follows automatically when the start is moved
  - **Location input** with MapPin icon
  - **Classification dropdown** (Public / Private / Confidential)
  - **Notes textarea** (6 rows, vertical resize)
  - **Info footer**: organizer name, SEQUENCE counter, auto-update hint

- **`GET /api/v1/calendar/events/:id`** — detail load for the edit dialog with
  `canWrite`/`readOnly` flags. Permission check via `canAccessCalendar`,
  privacy masking for PRIVATE events for grantees (summary → "Busy",
  attendees hidden), CONFIDENTIAL returns 404 for foreign viewers.

### Changed

- **CalendarPage** — old inline dialog removed (was ~80 lines of JSX).
  Replaced by the unified `EventEditDialog` for create and edit.
  State simplified: `eventDialog: { mode: 'create' | 'edit', ... } | null`.
- **Toolbar "New event"** now opens the Outlook-style dialog
  instead of the old mini dialog.
- **Double-click / single click on event**: opens the edit dialog (a double-
  click is fired by FullCalendar as two eventClicks — both open
  the same dialog, no conflict).
- **Attendee status refresh**: the edit dialog has its own `refetchInterval: 30s`
  + manual refresh button in the header.

---

## [3.18.26] — 2026-05-25 — Backup bug fixes + per-mailbox + scheduling + status log

### Fixed

- **Full-backup button and refresh button did not work**
  (`packages/backup-service/src/upload/s3.ts`,
  `packages/backup-service/src/server.ts`):
  Root cause: the backup-service crashed on the first call to
  `listBackups()` because the MinIO bucket `coremail-backups` did not
  exist (`NoSuchBucket` error). supervisord restarted the container
  every few minutes — from the user's point of view the buttons did not react.
  **Fix**: `ensureBackupBucket()` runs at service start and creates the
  bucket idempotently (HeadBucket → CreateBucket on 404). `listBackups()`
  additionally fail-safe: on NoSuchBucket create the bucket + return an empty list
  instead of crashing.

### Added

- **Per-mailbox backup**
  (`packages/backup-service/src/scheduler/index.ts`,
  `packages/backup-service/src/server.ts`,
  `packages/admin-panel/src/pages/BackupsPage.tsx`):
  New endpoint `POST /admin/backups/mailbox/:userId` with body
  `{ format: "zip" | "mbox" }`. Frontend: user picker (dropdown of all
  active users) + format selection + "Back up mailbox" button. The snapshot
  lands in MinIO under `mailbox/{userId}/{timestamp}.{format}`.

- **Backup schedules (cron) in the DB instead of an env variable**
  (`packages/storage/prisma/schema.prisma` — new model `BackupSchedule`,
  `packages/backup-service/src/scheduler/index.ts`):
  Admins can manage cron expressions in the BCP — no container restart
  needed. The scheduler reads from the DB every 60s and synchronizes active
  CronJobs. Fields: `name`, `cron`, `enabled`, `scope` (full/user),
  `format`, `targetUserId`, `retentionDays`, `lastRunAt`, `lastStatus`.
  Frontend with cron presets (daily/weekly/hourly/every 6h/
  monthly), run-now button per schedule, edit/delete buttons.

- **Extended status-log fields in the BackupJob model** (research: see
  `coremail/research/imip-itip.md` and RTO/RPO research):
  - `startedAt`, `durationMs` — for RTO measurement
  - `sizeBytes`, `messageCount` — backup volumetrics
  - `errorClass` (NETWORK/STORAGE/PERMISSION/CORRUPT/UNKNOWN) +
    `errorMessage` — structured error reporting
  - `retryCount`, `triggeredBy` (CRON/MANUAL/EVENT/RESTORE/API)
  - `progressMeta` (JSONB) for the live phase "Reading mailbox X (3/12)"
  - `scheduleId` — reference to the BackupSchedule when triggered from cron

- **Extended `JobStatus` enum values** for the complete backup
  lifecycle: `SCHEDULED`, `RUNNING`, `RETRYING`, `ABORTED`, `EXPIRED`
  in addition to the previous `PENDING|PROCESSING|COMPLETED|FAILED`.

### Changed

- **`POST /backup/admin/full`** now immediately returns the master job ID
  (`202 { jobId }`) instead of fire-and-forget. The frontend can immediately
  show the RUNNING job in the table.
- **`runFullBackup()`** now creates a master job with `progress`
  tracking instead of just per-user jobs without an overview. The UI shows a progress bar
  "X/Y users exported" during the run.
- **Refresh button** with toast feedback ("Refreshed") so the user
  gets visual confirmation.

### Removed / Explicitly Not Supported

- **PST format** is deliberately not supported. Rationale in the frontend
  banner: PST is a proprietary Microsoft binary format, all available
  open-source libs (libpff, node-pst-extractor) are read-only. Instead
  ZIP with .eml files — Outlook accepts that natively via drag & drop.

### Schema

- New model `BackupSchedule` (cron management in the DB).
- `BackupJob` extended with 10 new columns (`startedAt`, `durationMs`,
  `sizeBytes`, `messageCount`, `errorClass`, `retryCount`, `triggeredBy`,
  `progressMeta`, `scheduleId`).
- `JobStatus` enum extended with 5 values.

---

## [3.18.25] — 2026-05-25 — Calendar invitations (iMIP/iTIP, A5)

### Added

- **iMIP REQUEST mails to guests on appointment creation** (RFC 6047 / 5546)
  (`packages/api-gateway/src/lib/imip.ts`,
  `packages/api-gateway/src/routes/calendar.ts`):
  When an event with attendees is created, the system generates an
  iMIP-compliant invitation mail via `ical-generator` with:
  - `multipart/alternative` → text/plain + text/html + `text/calendar; method=REQUEST` (for Gmail)
  - `application/ics` attachment (for Outlook Win32 RSVP buttons)
  - Outlook quirks (`X-MICROSOFT-CDO-BUSYSTATUS`, `X-MS-OLK-FORCEINSPECTOROPEN`)
  - Mandatory properties: UID (with `@hostname` suffix), DTSTAMP, ORGANIZER,
    ATTENDEE with `RSVP=TRUE PARTSTAT=NEEDS-ACTION`, SEQUENCE, STATUS:CONFIRMED
  Sent via the existing BullMQ outbound queue (`smtp-outbound`) via the
  `rawMessage` base64 path — retry + DKIM signing apply automatically.

- **iMIP update on event change** — On `PUT /calendar/events/:id`,
  changed fields are detected (summary/dtStart/dtEnd/location/attendees). If
  relevant fields change, `sequence++` and a new REQUEST mail
  is sent to all attendees (mail clients recognize the update by the higher SEQUENCE
  and replace the existing entry).

- **iMIP CANCEL on event deletion** — On `DELETE /calendar/events/:id`, a
  CANCEL mail (`METHOD:CANCEL`, `STATUS:CANCELLED`,
  `sequence++`) is sent to all attendees before the delete. Gmail/Outlook show a banner
  "Appointment cancelled" and remove the entry.

- **iTIP REPLY inbound handler** (guest responds)
  (`packages/storage/src/itip-inbound.ts`,
  `packages/smtp-server/src/handlers/message.ts`):
  Incoming mails are scanned for `BEGIN:VCALENDAR ... METHOD:REPLY`
  (regex-based, no heavy ical parser in the hot path). On match:
  UID lookup on `CalendarEvent`, SEQUENCE check (old REPLYs are
  ignored, RFC 5546 §3.4.3), update the attendee entry in the JSON array
  (`partstat=ACCEPTED|DECLINED|TENTATIVE`). The mail is NEVERTHELESS delivered to the
  inbox (user awareness as in Outlook).

- **Frontend: guest input in the new-appointment dialog**
  (`packages/web-client/src/pages/CalendarPage.tsx`):
  New input field "Invite guests (comma-separated)" accepts email
  addresses such as `anna@example.com, bob@x.de`. Counter shows "X guests —
  invitation mails will be sent on save".

### Schema

- `CalendarEvent.attendees` (JSON array) is filled on create with
  `{ email, cn, partstat, role, rsvp }` objects.
- `CalendarEvent.sequence` (Int, default 0) is incremented on every relevant
  update (prepared in v3.18.24).
- `CalendarEvent.uid` now with hostname suffix `<id>@<publicHostname>`
  (RFC 5545 §3.8.4.7 — global uniqueness).

### Dependencies

- `ical-generator@10.2.0` in api-gateway (installed in v3.18.24)

---

## [3.18.24] — 2026-05-25 — Performance E: MinIO lifecycle policies

### Added

- **E4 — MinIO lifecycle policies for automatic cleanup**
  (`packages/storage/src/minio/index.ts`):
  Until now, temporary backup, quarantine and outbound-queue objects
  could grow unbounded in the MinIO bucket — especially `outbound-queue/` attachments
  of dead BullMQ jobs (e.g. after a crash between job enqueue and worker
  pickup) stayed forever. The new helper `ensureLifecyclePolicies()`
  is called in `ensureBuckets()` and sets three prefix-based
  expiration rules in the bucket:
  - `outbound-queue/` → 7 days (safety net for dead jobs)
  - `quarantine/`     → 90 days (rspamd quarantine)
  - `backups/`        → 365 days (backup retention)
  Email attachments (`attachments/`) and raw messages (`raw/`) are explicitly
  EXCLUDED — they are removed individually on message delete. Idempotent:
  setBucketLifecycle() overwrites the policy every time, so the current state is
  guaranteed at every container start. Fail-safe: if MinIO
  does not accept the policy (old version, permission issue), only a WARN
  log, no throw.

### Added (Dependency)

- `ical-generator@^10.2.0` as preparation for v3.18.25 iMIP calendar
  invitations.

### Schema

- **`CalendarEvent.sequence Int @default(0)`** — sequence counter for
  iMIP-compliant event updates (RFC 5546 §3.2). Mail clients (Outlook,
  Gmail) ignore REPLY mails with a lower sequence than the currently
  stored event state. Preparation for v3.18.25.

---

## [3.18.23] — 2026-05-25 — Backup/restore UI in the BCP (D3)

### Added

- **New BCP page "Backup & Restore"**
  (`packages/admin-panel/src/pages/BackupsPage.tsx`,
  `packages/admin-panel/src/components/Sidebar.tsx`,
  `packages/admin-panel/src/i18n/translations.ts`,
  `packages/api-gateway/src/routes/admin/backups.ts`,
  `packages/api-gateway/src/server.ts`):

  Until now backup management was only possible via CLI / direct backup-service calls.
  New admin UI with:
  - **Backup jobs table** — date, scope (user/domain/full), format
    (mbox/eml/full), status with icons (PENDING/RUNNING/COMPLETED/FAILED/
    CANCELLED), progress bar, download link for completed jobs.
    Auto-polling every 5s when a job is RUNNING or PENDING, otherwise 60s
    (performance + live updates).
  - **S3 snapshots table** — lists all backup objects in the MinIO/S3 bucket
    with key, size (formatted KB/MB/GB), last-modified.
  - **"Start full backup" button** — triggers `POST /admin/backups/full`,
    audit log entry `backup.full.trigger`.
  - **MBOX import (restore)** — file picker (limit 500 MB) + target user ID,
    `POST /admin/backups/import/:userId` with `Content-Type: application/mbox`,
    audit log entry `backup.mbox.import`.

  Backend: wrapper router `adminBackupsRouter` forwards `/api/v1/admin/backups/*`
  to `BACKUP_SERVICE_URL` (default `http://localhost:3004`). Auth via
  `requireAdmin` middleware + Authorization header forwarding. Audit log for
  trigger/import. Side-effect import for the Express augmentation `req.apiUser`.

  Sidebar: new nav entry "Backup & Restore" with `HardDriveDownload`
  icon. i18n key `nav_backups` in DE + EN.

---

## [3.18.22] — 2026-05-25 — OAuth2 consent UI (Security)

### Security

- **D1 — OAuth2 auto-grant removed, real consent UI**
  (`packages/auth-service/src/oauth2/router.ts`,
  `packages/web-client/src/pages/LoginPage.tsx`,
  `packages/web-client/src/pages/OAuthConsentPage.tsx`,
  `packages/web-client/src/App.tsx`):

  **Before (security issue)**: `/oauth2/authorize/complete` granted consent
  blindly on the first call of a non-trusted client — users had no
  opportunity to see or reject a third-party app before its first access.
  Despite the "non-trusted" marking, all requested
  scopes were approved automatically.

  **Now**: With missing or incomplete consent, the backend returns
  `200 { requiresConsent: true, client, requestedScopes, alreadyGrantedScopes,
  newScopes }` instead of issuing a code directly. The frontend shows the new
  ConsentPage with:
  - Client name + description
  - List of requested scopes with German labels (e.g. "mail.send" →
    "Send emails on your behalf", "calendar.write" → "Create, change
    or delete appointments")
  - With an existing grant plus additional scopes: only the NEW scopes
    are highlighted, already granted ones as a small note at the bottom
  - Amber warning "You can revoke this access at any time"
  - "Allow" and "Deny" buttons

  Flow:
  1. Third-party app → `GET /oauth2/authorize?client_id=...&...`
  2. Auth-service redirects to `/owa/login?oauth2=1&client_id=...`
  3. LoginPage detects `oauth2=1`, after login → `navigate('/oauth-consent?...')`
  4. ConsentPage asks the backend whether consent is needed → on `redirect` straight back
     to the client (already granted), on `requiresConsent` show the UI
  5. "Allow" → second call with `consentConfirmed: true` → backend
     persists the consent + creates the code + returns the `redirect` URL
  6. "Deny" → client is called with `error=access_denied` (RFC 6749 §4.1.2.1),
     no code is issued

  New route `/oauth-consent` in the MWA, with AuthGuard but without the layout wrapper
  (standalone full-screen dialog).

---

## [3.18.21] — 2026-05-25 — Calendar toolbar filter + printing now functional

### Fixed

- **Filter button had no effect**
  (`packages/web-client/src/components/CalendarToolbar.tsx`,
  `packages/web-client/src/pages/CalendarPage.tsx`):
  The dropdown did open with toggle checkboxes, but the state was
  purely local to the toolbar — it was never passed on to CalendarPage.
  In addition, the old Outlook terms ("Meetings",
  "Categories", "Show as") were meaningless for CoreMail.
  **Fix**: filter set reduced to 5 realistic options that actually map to
  data: Recurring events (rrule), Tasks, Private events
  (classification=PRIVATE), Confidential events (CONFIDENTIAL for owner),
  Shared calendars (shared=true). State lifted to CalendarPage
  (controlled component). `fcEvents` are now actually filtered.

- **"Print" printed the entire page including sidebar + toolbar**
  (`packages/web-client/src/pages/CalendarPage.tsx`,
  `packages/web-client/src/index.css`):
  Before: a plain `window.print()` without print CSS — sidebar, toolbar,
  app chrome all ended up on the printout. **Fix**: before `window.print()` the
  `coremail-printing` class is set on `<html>`; a new `@media print`
  block in `index.css` hides `aside`, `nav`, `header` and all
  `[data-coremail-toolbar]` elements. After the print dialog the
  class is removed again via timeout (500ms). Events get a print-
  friendly border (1px solid #888) so they remain visible on paper.

---

## [3.18.20] — 2026-05-25 — Dark-mode patches (LoginPage + SettingsPage)

### Changed

- **MWA LoginPage dark mode** (`packages/web-client/src/pages/LoginPage.tsx`):
  The login card had no `dark:` modifiers at all — as the first page a
  new user sees, an obvious bug. Now with
  `dark:bg-gray-900`, `dark:text-white`, `dark:text-gray-400` for logo +
  subtitle. Card border `dark:border-gray-700` as a subtle delimiter.

- **MWA SettingsPage dark mode (section headers + form labels)**
  (`packages/web-client/src/pages/SettingsPage.tsx`):
  Section headings (`text-lg font-semibold text-gray-900` → +
  `dark:text-gray-100`), sub-texts (`text-sm text-gray-500 mt-0.5` → +
  `dark:text-gray-400`), form labels (`block text-sm font-medium
  text-gray-700 mb-1` → + `dark:text-gray-300`) and the disabled e-mail input
  (`bg-gray-50` → + `dark:bg-gray-800`) are now correctly readable
  in dark mode.

### Known

- ComposeWindow (~22 places) and SignatureSection (~9 places) still
  have individual non-dark-aware classes. Will be cleaned up in a dedicated
  dark-mode sweep session in v3.19.

---

## [3.18.19] — 2026-05-25 — Forced 2FA for admin login (Security)

### Security

- **D5 — Mandatory 2FA for admins** (`packages/api-gateway/src/middleware/auth.ts`,
  `packages/admin-panel/src/api/client.ts`,
  `packages/admin-panel/src/pages/MfaRequiredPage.tsx`):
  When `ServerSettings.requireMfaForAdmins=true` (the toggle already existed in
  the security settings but was never enforced anywhere) and the admin
  has NO MFA enabled → all `/api/v1/admin/*` routes now return
  `403 { code: "MFA_REQUIRED" }`. The frontend API client detects the code and
  redirects to the new mandatory setup page `/bcp/mfa-required` with instructions
  ("Open MWA → Settings → Security → enable 2FA → come back").
  TOTP or WebAuthn credentials both count as "MFA enabled".
  No chicken-and-egg problem: the MFA setup routes (`/auth/mfa/*`) are
  outside the `/admin/*` lock. Fail-safe: on a DB error in the check the request
  is let through (logged as ERROR) so admins are not locked out
  during a Postgres outage.

---

## [3.18.18] — 2026-05-25 — Toolbar share button + CalDAV URL display

### Fixed

- **Toolbar "Share calendar" now works**
  (`packages/web-client/src/pages/CalendarPage.tsx`):
  The button at the top of the CalendarToolbar previously only showed a toast
  ("Select a calendar and click Share via the ⋯ menu"). Now
  it opens the `ShareCalendarDialog` directly — if the user has several
  own calendars, a selection dropdown appears in the dialog header
  for switching. With only one own calendar it is opened
  directly. If none exists → toast error.

### Added

- **CalDAV URL display for external calendar access**
  (`packages/api-gateway/src/routes/calendar.ts`,
  `packages/web-client/src/components/ShareCalendarDialog.tsx`,
  `packages/web-client/src/components/CalendarSidebar.tsx`):
  New endpoint `GET /api/v1/calendar/caldav-info` returns
  - `accountUrl` for auto-discovery (`https://host/dav/calendars/{userId}/`)
  - a per-calendar URL for direct mounting (`.../{calendarId}/`)
  - username + auth hint (app password instead of login password because of MFA)
  In the share dialog a new section "External access (CalDAV)" appears
  with both URLs and copy-to-clipboard buttons. The sidebar context menu
  on own calendars additionally offers "Copy CalDAV URL" for
  quick access. CalDAV is consistently recommended over HTTPS (auth-leak
  protection); only if the admin has explicitly set `useHttps=false` (e.g.
  behind a reverse proxy) is `http://` emitted.

### Changed

- **ShareCalendarDialog** now accepts an optional `ownedCalendars` prop
  for picker mode. When invoked from the sidebar context menu the
  calendar stays fixed; when invoked from the toolbar it can be switched.
  The header shows the picker dropdown only when `ownedCalendars.length > 1`.

---

## [3.18.17] — 2026-05-25 — Calendar SSE push + free/busy query

### Added

- **A2 — SSE push for the calendar share lifecycle**
  (`packages/core/src/redis/index.ts`, `packages/api-gateway/src/sse.ts`,
  `packages/api-gateway/src/routes/calendar.ts`,
  `packages/web-client/src/hooks/useMailEvents.ts`):
  New Redis channel `coremail:calendar:shares` (constant
  `CHANNEL_CALENDAR_SHARES`). The backend publishes a JSON event with
  `affectedUserIds[]` (owner + grantee) on every share lifecycle
  action (create/update/delete/self_remove). The SSE handler in the api-gateway
  subscribes to the channel and forwards the event as `event: calendar:shares`
  only to the SSE connections of the affected users. The frontend hook
  `useMailEvents()` invalidates the `['calendars']` and
  `['calendar-shares']` caches on that event → instant live sync without polling. Toast
  "🗓️ A calendar was shared with you" on `action=create`. Polling
  interval of the calendar query in CalendarPage reduced from 60s to 5min
  (only a safety fallback in case SSE is dead).

- **A4 — Free/busy query across shared calendars**
  (`packages/api-gateway/src/routes/calendar.ts`):
  New endpoint `POST /api/v1/calendar/freebusy`, body
  `{ userEmails[], start, end }`. Returns, per requested user, all
  busy slots from calendars the caller has access to (own + via
  share). CONFIDENTIAL events remain hidden for foreign callers,
  PRIVATE events are returned as a generic "Busy" slot WITHOUT subject.
  Self-query (caller asks about themselves) sees all details. Range hard-
  limited to 90 days (DoS protection), list to 50 users. Response shape:
  `{ start, end, users: [{ email, displayName, found, busy: [{ start, end, type, subject? }] }] }`.

---

## [3.18.16] — 2026-05-25 — Calendar sharing quick wins (notification, per-grantee color, reorder, cleanup)

### Added

- **A1 — Notification mail to grantee on sharing**
  (`packages/api-gateway/src/lib/internal-notify.ts`, `routes/calendar.ts`):
  When an owner shares a calendar, the recipient automatically receives a
  system mail in their INBOX ("X shared the calendar 'Y' with you" with
  permission level). New helper `notifyUserInbox()` with direct inbox
  insertion via `prisma.message.create` — no SMTP round trip, no DKIM/
  spam check needed, immediately visible. Only on a *new* share, not on a
  permission update via upsert (prevents spam). HTML escaping against XSS.

- **A3 — Per-grantee color for shared calendars**
  (`schema.prisma`, `routes/calendar.ts`, `components/CalendarSidebar.tsx`):
  Grantees can recolor shared calendars locally without changing the owner's
  color. New field `CalendarShare.localColor String?` and
  endpoint `PATCH /calendar/mine-shares/:shareId` with body `{ localColor }`.
  Color picker in the context menu on shared calendars; "Original color (from
  owner)" resets `localColor=null`. `listAccessibleCalendars` returns
  `localColor ?? calendar.color` for grantees.

- **A8 — Reorder for shared calendars**
  (`schema.prisma`, `routes/calendar.ts`, `components/CalendarSidebar.tsx`):
  Grantees can locally adjust the order of the "Shared with me" section.
  New field `CalendarShare.sortOrder Int @default(0)` and endpoint
  `POST /calendar/mine-shares/reorder` (body `{ ids[] }`, filtered on
  `granteeId === userId`). Context menu "Move up" / "Move down" on
  shared calendars.

- **`shareId` field** in the `GET /calendar` response (only when `shared: true`)
  — the frontend uses it for self-removal, color change, reorder. Previously
  self-removal needed a round trip via `/mine-shares?calendarId=`,
  now it is directly available.

### Changed

- **CalendarSidebar — shared calendars sorted by `sortOrder`** instead of
  alphabetically by name. Tie-break remains `localeCompare`.
- **Self-removal mutation** simplified — now uses `cal.shareId` directly
  instead of a lookup via `mine-shares?calendarId=`.

### Removed

- **C1 — `Calendar.acl Json` field removed completely**
  (`packages/storage/prisma/schema.prisma`):
  Marked `@deprecated` in v3.18.14 (replaced by `CalendarShare`).
  The column is dropped automatically at container start via `prisma db push --accept-data-loss`.
  No code in `packages/` referenced the field —
  `PublicFolder.acl` remains unchanged (different model).

---

## [3.18.15] — 2026-05-25 — CalDAV WRITE sharing + private events + audit log + i18n

### Added

- **CalDAV WRITE for grantees with full RFC 3744 DAV ACL**
  (`packages/caldav-server/src/caldav/index.ts`):
  In v3.18.14 Apple Calendar / Thunderbird Lightning could only read.
  Now WRITE grantees may also PUT (create/update) and DELETE.
  The write lock for READ grantees remains. Full RFC 3744 DAV ACL:
  - `<DAV:owner>` with `<d:href>/dav/principals/{ownerId}/</d:href>`
  - `<DAV:current-user-privilege-set>` with fine-grained privileges
    (`<d:read/>`, `<d:write/>`, `<d:write-content/>`, `<d:bind/>`, `<d:unbind/>`)
  - `<DAV:acl>` block (visible to OWNER only) with one ACE per grantee
  - `Allow` header in OPTIONS now includes `ACL`, `DAV` header includes `access-control`
  Cross-calendar manipulation protection: a grantee cannot move an event, from
  their point of view, into a different calendar.

- **Private and confidential events (RFC 5545 `CLASS:`)**
  (`packages/storage/prisma/schema.prisma`, `packages/api-gateway/src/lib/calendar-access.ts`):
  New field `CalendarEvent.classification` with three values:
  - `PUBLIC` (default): grantees see all details
  - `PRIVATE`: grantees only see "Busy" — subject/description/location/
    attendees are masked. The owner sees everything unchanged.
  - `CONFIDENTIAL`: the event is completely hidden from grantees
  Mapping to the iCal `CLASS:` property (RFC 5545 §3.8.1.3) in both directions
  (backend → iCal on build, CalDAV PUT → DB on parse). Masking applies
  in REST `GET /calendar/events`, CalDAV `GET`, `PROPFIND` and `REPORT`.
  WRITE grantees cannot modify CONFIDENTIAL events (otherwise they would be
  manipulable despite masking).

- **Audit log for sharing actions** (compliance, GDPR Art. 32)
  (`packages/api-gateway/src/routes/calendar.ts`):
  New audit actions — all with actor, target calendar, IP, user agent and
  diff in the `changes` field:
  - `calendar.share.create` — when a share is created
  - `calendar.share.update` — on permission change (with oldPermission/newPermission)
  - `calendar.share.delete` — when the owner removes a share
  - `calendar.share.self_remove` — when a grantee removes themselves from the list
  Until now sharing actions were NOT audited — gap closed.

- **i18n: EN, ES, IT translations for the sharing UI**
  (`packages/web-client/src/i18n/translations.ts`):
  25 new keys (`cal_share_*` and `cal_event_class_*`) in all four
  languages German/English/Spanish/Italian.

### Changed
- **Event creation dialog** in the MWA now has a visibility dropdown
  ("Public" / "Private" / "Confidential"). Default remains PUBLIC for
  backward compatibility.

- **CalDAV OPTIONS response** now contains `ACL` in the Allow header and
  `access-control` in the DAV header — Apple Calendar thereby detects full
  RFC 3744 support.

### Schema

- New field `CalendarEvent.classification String @default("PUBLIC")`.
  Migration runs automatically via `prisma db push --accept-data-loss`.
  Existing events get `PUBLIC` as default — no behavior change
  for non-shared calendars.

---

## [3.18.14] — 2026-05-25 — Share calendars and grant permissions (read/write)

### Added

- **Calendar sharing — internal sharing between users**
  (`packages/storage/prisma/schema.prisma`, `packages/api-gateway/src/routes/calendar.ts`,
  `packages/web-client/src/components/ShareCalendarDialog.tsx`):
  Users can share their own calendars with other users in the same system
  with READ or READ+WRITE permission. Shared calendars appear for the
  recipient in a new sidebar section "Shared with me" with a share icon
  and permission badge (R / R/W) as well as the owner name as subtitle.

- **Sharing dialog with user autocomplete**
  (`packages/web-client/src/components/ShareCalendarDialog.tsx`):
  Clicking "Sharing and permissions" in the calendar context menu opens a
  full-featured dialog instead of the previous "Coming soon" notification.
  - User autocomplete via `/contacts?q=` (220ms debouncing, keyboard nav
    ↑↓/Enter/Tab/Escape, automatic filtering to internal user hits only,
    already-assigned users are hidden)
  - Permission select (Read only / Read and write)
  - List of current shares with permission toggle + trash button
  - Self-share prevented (backend 400 response)
  - Info banner explaining READ vs WRITE plus a CalDAV hint

- **CalDAV discovery for shared calendars (read-only)**
  (`packages/caldav-server/src/caldav/index.ts`):
  External clients (Apple Calendar, Thunderbird Lightning) now also see shared
  calendars in the calendar-home-set (with `[Geteilt]` prefix in the display name).
  PROPFIND/REPORT/GET are allowed. PUT/DELETE remain OWNER-only in v3.18.14
  (full WRITE CalDAV follows in v3.18.15 with an RFC 3744-compliant DAV ACL).
  `<DAV:current-user-privilege-set>` set correctly: OWNER → `<d:all/>`,
  grantee → `<d:read/>`.

### Changed

- **GET /api/v1/calendar** now returns own + shared calendars with fields
  `shared`, `ownerId`, `ownerDisplayName`, `ownerEmail`, `permission`
  (`OWNER`/`READ`/`WRITE`). Lazy provisioning only when there are no calendars at all.

- **Event permission checks** in `POST/PUT/DELETE /calendar/events*` via the new
  central helper `canAccessCalendar(userId, calendarId, required)` in
  `packages/api-gateway/src/lib/calendar-access.ts`. WRITE permission required
  for write operations, READ suffices for `GET /events`. Owners always have
  all rights.

- **FullCalendar in the MWA** renders shared READ-only calendars as non-editable
  (`editable: false`, `startEditable: false`, `durationEditable: false`).
  Clicking a READ-only event shows the toast "Read-only permission for this
  calendar" instead of the delete confirm. The new-event dialog lists only calendars with
  write permission in the dropdown.

- **TanStack Query calendar cache** with `staleTime: 30s` + `refetchInterval: 60s`
  + `refetchOnWindowFocus: true` — changed shares (e.g. owner revokes a
  permission) disappear from the UI within 60s.

### Schema

- **New table `calendar_shares`** with fields `id`, `calendarId`, `ownerId`,
  `granteeId`, `permission` (enum `READ`/`WRITE`), `comment`, `createdAt`.
  Unique constraint `(calendarId, granteeId)` prevents duplicates, POST is
  idempotent (upsert). Cascade delete on calendar/owner/grantee deletion.
- **New enum `CalendarPermType`** with values `READ`, `WRITE`.
- **`Calendar.acl Json`** marked `@deprecated` — removal in v3.19.

### API

- `GET /api/v1/calendar/:id/shares` — list of all shares for an own calendar
- `POST /api/v1/calendar/:id/shares` — body `{ granteeId, permission, comment? }`,
  upsert behavior, accepts `gal-` prefix
- `PUT /api/v1/calendar/:id/shares/:shareId` — update permission
- `DELETE /api/v1/calendar/:id/shares/:shareId` — owner OR grantee (self-removal)
- `GET /api/v1/calendar/mine-shares?calendarId=...` — shares granted to me
  (grantee view, needed for the self-removal flow)

---

## [3.18.13] — 2026-05-25 — External contacts UI simplified + GAL cache live sync

### Changed

- **BCP ExternalContactsPage — first name/last name fields removed**
  (`packages/admin-panel/src/pages/ExternalContactsPage.tsx`):
  The separate inputs for first name and last name were redundant — the
  display name is the only relevant value that is visible everywhere in MWA/GAL/Outlook.
  The UI now has only one required field "Display name". Backend
  `firstName`/`lastName` remain in the DB with a default `""` fallback
  (no schema break).

### Fixed

- **GAL in the MWA showed newly created external contacts only after a reload**
  (`packages/web-client/src/pages/ContactsPage.tsx`):
  When an admin created a new external contact or a distribution group in the BCP,
  it was not visible in the MWA global address book — the
  TanStack Query cache held the old result stale-free for 30 seconds.
  **Fix**: `staleTime: 0` + `refetchOnMount: true` + `refetchOnWindowFocus: true`
  + `refetchInterval: 60_000` for the `/contacts/gal` query. Additionally a new
  refresh button (RefreshCw icon) in the filter bar next to the counter — the user
  can synchronize manually at any time. Spinning animation during the
  fetch as visual feedback.

---

## [3.18.12] — 2026-05-24 — Public folders: browse modal, folder icons, auto-hide without ACL

### Fixed

- **Public folders were not accessible despite full access**
  (`packages/web-client/src/components/FolderTree.tsx`):
  Clicking a public folder only showed the toast "Browse view coming
  in the next patch" — no actual access to the messages was possible.
  **Fix**: new `PublicFolderViewerModal` component — a click opens a 2-column
  modal (list left, detail right) with all messages of the folder.
  Auto-refresh 30s, sanitized HTML rendering, clickable recipient avatars,
  "X messages" counter in the footer.

- **Wrong icons** — public folders had a Users icon (distribution-group
  style) and looked like contacts rather than folders.
  **Fix**: `Folder` icon (amber, filled) both in the sidebar and in the
  modal header. `FolderTree` icon for the section heading. Clear visual
  separation between mail folders (stack icon) and public folders (folder icon).

- **Section appeared with an empty cache / during loading**
  Before: `if (folders.length === 0) return null` — before the first fetch the
  section showed nothing, which is correct, BUT when the cache was stale (an earlier user
  still had ACLs), the section was initially shown even though the newly logged-in
  user no longer had permission.
  **Fix**: the hide logic now checks `!isSuccess || !folders || folders.length === 0`
  — the section is guaranteed invisible until the backend has actually delivered
  data. Additionally `refetchOnWindowFocus: true` + polling interval reduced from 60s to
  30s: when an admin revokes access, the section disappears automatically on the
  next tab focus or after 30s at the latest.

---

## [3.18.11] — 2026-05-24 — MWA global address book (GAL browser)

### Added

- **ContactsPage — tabs "My address book" / "Global address book"**
  (`packages/web-client/src/pages/ContactsPage.tsx`):
  - Tab navigation in the sidebar between private contacts (existing) and GAL
  - GAL returns a merged result from 3 sources (all active internal users, external
    contacts from the admin directory, distribution groups)
  - The search bar works for both tabs; for GAL without a search all
    entries are listed alphabetically (browse mode)
  - Type filter (All / People / External / Groups) as a compact toggle bar
  - Counter badge shows the total number of GAL hits
  - Clicking a GAL entry → read-only detail panel with avatar, type badge
    (Distribution group / External contact / Internal user), e-mail (clickable
    mailto:), phone/mobile (clickable tel:), company, department, domain,
    member count
  - **"New message" button** opens the compose window with the GAL address
    pre-filled
  - Note in the detail panel: centrally managed — the user cannot edit GAL entries
    directly

- **Backend `/api/v1/contacts/gal` extended** with browse mode + type filter:
  - Without `q` → all GAL entries sorted alphabetically (browse for the GAL view)
  - With `q` (>=2 characters) → full-text search across all 3 sources
  - `type=all|users|external|groups` filters the sources
  - Paginated: `limit` (max 500, default 300) + `offset`
  - Response: `{ entries: GalEntry[], total, limit, offset }`
  - Structured `GalEntry` format with `kind`, `displayName`, `email`,
    optional fields `company`/`department`/`phone`/`mobile`/`domain`/
    `memberCount` and ID prefix (`user-`/`ext-`/`grp-`)

---

## [3.18.10] — 2026-05-24 — Image privacy banner + queue hardening (DSN, 5xx, dynamic settings)

### Added — Image privacy banner (Outlook/Gmail style)

- **External images are BLOCKED by default** to protect against tracking pixels
  (`packages/web-client/src/components/MessageReader.tsx`):
  - HTML is passed through `processExternalImages()` before `dangerouslySetInnerHTML`
  - `<img src="cid:foo">` → replaced by the MinIO attachment URL (inline images
    are OK since they are part of the mail itself — no tracking risk)
  - `<img src="data:...">` → passed through (self-embedded)
  - `<img src="http(s)://...">` → `src` is replaced by a 1×1 transparent PNG,
    the original moves to `data-coremail-ext-src` (for later re-activation)
- **Banner** at the top of the body when external images are blocked:
  *"X external images were blocked. External images can be used
  to track your reading behavior."* + button "Show images"
- Per-message toggle (`useState` with `useEffect` reset on message change),
  so that different mails can be treated differently
- Backend API: `/folders/:folderId/messages` and `/messages/:id` now return
  `contentId` and `inline` fields per attachment (they were missing before)

### Added — Queue hardening phase 1

- **DSN (Delivery Status Notification, RFC 3464)** —
  `packages/smtp-server/src/outbound/dsn.ts`:
  - On a permanent delivery failure a bounce mail is automatically delivered to `MAIL FROM`
    (multipart/report with human-readable text + RFC 3464 report part).
  - **Double-bounce protection**: no DSN for an empty MAIL FROM (`<>` sender = already
    a bounce mail) per RFC 5321 §6.1.
  - DSNs are generated only for **local senders** — external senders get a
    bounce from the MX server more reliably (prevents backscatter spam).
  - `MAILER-DAEMON@<hostname>` as sender, `Auto-Submitted: auto-replied`,
    `In-Reply-To` of the original Message-ID for thread linking.

- **4xx vs 5xx semantics** —
  `packages/smtp-server/src/outbound/queue.ts`:
  - New `extractSmtpCode()` helper extracts SMTP reply codes from
    nodemailer error messages
  - **5xx errors** (permanent, e.g. 550 User unknown) are marked as final
    **immediately** via `job.discard()` — no more 10× retry (protects IP reputation,
    the recipient MX is not "spammed")
  - **4xx errors** (transient, e.g. 421 Try again) go through the normal retry with
    exponential backoff
  - The SMTP code is persisted in the `MAIL_FLOW` systemLog (was missing before)
  - The log message shows `[550]` etc. for quick recognition in the admin UI

- **Dynamic queue settings**:
  - `enqueueOutbound()` now reads `QueueSettings.maxRetryAttempts` and
    `retryBackoffDelaySec` from the DB — the admin can adjust backoff without
    a container restart
  - Fallback to defaults (10 attempts, 60s) when the DB is unreachable

---

## [3.18.9] — 2026-05-24 — TransportRule engine + public folders + Shared Mailbox SEND_AS/ON_BEHALF

### Fixed — TransportRule did not work at all

- **Bug**: `TransportRule` was stored in the DB but **never evaluated in the mail flow**.
  There was no engine — only CRUD endpoints.

- **Fix**: new engine `packages/storage/src/transport-rules.ts` with
  `applyTransportRules(parsed, ctx)` + `applyOutcomeToBuffer(buffer, outcome)`:
  - 8 conditions × 9 operators combined with AND (Exchange standard)
  - 10 actions: `addHeader`, `removeHeader`, `redirect`, `reject`, `addRecipient`,
    `removeRecipient`, `setSubjectPrefix`, `setSubjectSuffix`, `quarantine`,
    `addDisclaimer`
  - Hook in `storeInboundMessage()` directly after parsing — before user mail rules,
    before the spam/junk decision. `reject` and `quarantine` abort delivery.
  - Header/subject/disclaimer modifications are applied directly to the RFC 822 buffer
    (re-parsing after modification for consistent DB fields).

### Fixed — Distribution group members received no mails (inbound path)

- Already fixed for outbound in v3.18.8; v3.18.9 follows up for inbound:
  external members of local groups are forwarded via `enqueueOutbound()`.

### Fixed — Public folders, several bugs

- **Schema**: `PublicFolder.email String? @unique` — a folder can now be mail-enabled.
- **SMTP inbound**: `verifyRecipient()` and `storeInboundMessage()` now recognize
  mail-enabled public folders. Mails land as `PublicFolderMessage` directly in the
  folder — no mailbox routing.
- **BCP ACL editor**: plain-text input replaced by an autocomplete dropdown
  (debouncing, keyboard navigation, external + groups filtered out since only internal
  users get public-folder access). Cache invalidation after save extended
  (`admin-public-folders` + ACL list).
- **MWA FolderTree**: new `PublicFoldersSection` shows public folders below the
  personal folders. Purple Users icon + tooltip with e-mail. Auto-refresh 60s.
  A click shows a toast for now (browse mode follows in v3.18.10).

### Added — Shared Mailbox SEND_AS / SEND_ON_BEHALF in REST `/mail/send`

- **Until now**: SEND_AS only worked via SMTP submission (ports 465/587).
  REST `/mail/send` ignored Shared Mailbox permissions; `from` was always
  hard-coded to `user.email`.

- **New**: `POST /api/v1/mail/send` optionally accepts:
  - `sendAs: string` (e-mail) — the user must have `SEND_AS` or `FULL_ACCESS`
  - `sendOnBehalfOf: string` (e-mail) — the user must have `SEND_ON_BEHALF`

- **Permission check**: explicit `prisma.sharedMailboxPerm.findFirst()` with
  permission + mailbox linkage. Missing permission → `403`.

- **From header override**: with `sendAs`, `From: <shared>` is set;
  with `sendOnBehalfOf`, `From: <shared>` AND additionally `Sender: <user>` —
  Outlook/Apple Mail then show "User on behalf of Shared".

- **StructuredMessage.sender** added as an optional field for the queue.

### Added — Schema extension

- `PublicFolder.email String? @unique`

---
## [3.18.8] — 2026-05-24 — Fix: external contacts, distribution group routing, autocomplete

### Fixed

- **ExternalContactsPage cursor got lost while typing**
  (`packages/admin-panel/src/pages/ExternalContactsPage.tsx`):
  Inline `Field` component helper defined inside `ContactModal` →
  new component reference on every render → React unmount+remount of the input →
  cursor lost. Fix: all 8 fields rebuilt as inline `<div><label><input>`.
  Same pattern as the v3.17.44 eDiscovery fix and v3.17.43 RetentionPage.

- **GroupsPage React fragment key warning**:
  `filtered.map(g => (<>...</>))` without key → React warning. Fix:
  `<Fragment key={g.id}>...</Fragment>`.

- **CRITICAL FIX: external distribution group members received no mails**
  (`packages/smtp-server/src/outbound/queue.ts` + `inbound/handler.ts`):
  `expandRecipients()` resolves distribution groups into individual member addresses,
  but the expanded addresses were all handed to `storeInboundMessage()` as
  "local". If a group had external members
  (e.g. `partner@kunde.com`), these were silently lost — no mail arrived,
  no bounce, no log.

  **Fix**:
  - Outbound (`queue.ts`): after `expandRecipients` the addresses are checked AGAIN
    for local/external. External members are added to `finalExternalRcpts`
    and delivered via `relayMessage()` to MX/smarthost.
  - Inbound (`handler.ts`): when an external sender sends directly to a local
    distribution group that has external members, the external
    addresses are forwarded via `enqueueOutbound()`.

### Added

- **Compose autocomplete now shows all address sources**
  (`packages/api-gateway/src/routes/contacts.ts`):
  `GET /api/v1/contacts?q=` returns, from `q.length >= 2`, a unified search across:
  1. Private contacts (`Contact` table, own user)
  2. Global address list — all active users
  3. External contacts from the admin directory (`ExternalMailContact`,
     filtered `hiddenFromGal: false`)
  4. Distribution groups (`DistributionGroup`, `active: true && hiddenFromGal: false`)

  Dedup by e-mail. An ID prefix marks the source (`gal-`, `ext-`, `grp-` or
  private). Frontend `RecipientInput` and `MembersPanel` distinguish them visually.

- **GroupsPage member editor with autocomplete dropdown**
  (`packages/admin-panel/src/pages/GroupsPage.tsx` `MembersPanel`):
  Plain-text input replaced by a suggest field with debouncing (220ms),
  arrow up/down + Enter/Tab + Escape, type badge per hit (User/External/
  Group/Private). `memberType` is derived automatically from the ID prefix.
  Already-assigned members are hidden from the suggestions.

---

## [3.18.7] — 2026-05-24 — Spam UX + audit log v2 + audit bug fix + schedule send

### Fixed

- **Audit log: actor and target were empty** (`packages/api-gateway/src/lib/audit.ts`):
  `auditMiddleware` ran synchronously BEFORE `requireAuth` (auth is mounted per router,
  not globally) → `req.apiUser` was `undefined` at logging time → `actorId` / `actorEmail`
  stayed null. In addition `targetType` was not set at all (only `targetId`).
  Fix: logging moves into `res.on('finish')` so that auth has already run;
  `targetType` from `pathParts[0]` (resource), the HTTP status is evaluated as `success`/
  `errorMsg`.

### Added — Schedule send (Outlook style)

- **Backend** (`packages/storage/prisma/schema.prisma` + `routes/mail.ts`):
  - New fields: `Message.scheduledAt: DateTime?`, `scheduledStatus: String?`
    (`PENDING|SENT|CANCELLED`), `scheduledJobId: String?`
  - `POST /mail/send` optionally accepts `scheduledAt` (ISO date) — validation:
    at least 30s in the future, at most 1 year
  - BullMQ job enqueued with `delay: scheduledAt - now` — the worker only starts
    at the scheduled time
  - Sent copy immediately in the "Sent Items" folder with `scheduledStatus: PENDING`
    + `scheduledJobId` (for a later cancel)
  - The mail's Date header is set to `scheduledAt` (the recipient sees the scheduled
    time, not the creation time)
  - New endpoint `POST /mail/messages/:id/cancel-scheduled` — removes the
    BullMQ job via `queue.getJob(id).remove()`, sets status to CANCELLED
- **Worker** (`packages/smtp-server/src/outbound/queue.ts`):
  - Cancellation check at job start: if the message is meanwhile `CANCELLED` → return
    without sending (race protection)
  - After successful sending: set `scheduledStatus: 'SENT'` (banner disappears)
- **Frontend ComposeWindow**:
  - Send button group: "Send" button + arrow dropdown
  - Schedule picker with 3 presets (Tomorrow morning, Tomorrow afternoon, Next Monday
    — all at 8:00 or 13:00 respectively) + custom datetime-local picker
  - Validation: min. 30s in the future
  - Toast "Sending scheduled for [date/time]" after submit
- **Frontend MessageReader**:
  - Schedule banner Outlook style: blue (PENDING "Will be sent on…"), green
    (SENT "Scheduled sending completed"), gray (CANCELLED "Scheduled sending
    cancelled")
  - "Cancel scheduling" button when PENDING (deletes the BullMQ job, banner switches)
- **Frontend MessageList**: `CalendarClock` icon (blue) in the row for
  scheduled mails — tooltip with the concrete time

### Added — Spam UX (Outlook style)

### Added — Spam UX (Outlook style)

- **Spam score persistence**: new `Message.spamScore: Float?` field in the Prisma schema.
  `storeInboundMessage()` stores the rspamd score at the time of delivery
  (previously transient — only used for folder routing, then discarded).
- **Spam banner in the MessageReader** (Outlook style):
  - Visible when `spamScore ≥ 3.0` OR the mail is in the Junk folder
  - **Red** (high risk) at `spamScore ≥ 6.0` (rspamd reject threshold)
  - **Amber** at medium risk or in the Junk folder
  - Shows the concrete rspamd score in a mono font
  - "Mark as junk" / "Not spam" button directly in the banner for a 1-click action
- **Spam badge in the MessageList**: `ShieldAlert` icon in the row (yellow/red depending on
  score), tooltip with the concrete score
- **`notSpam` bulk action** improved: sets `spamScore: 0` on the message
  so that the banner is no longer shown after clicking "Not spam"

### Added — Audit log v2 (compliance-grade export & anomaly detection)

- **Cryptographic SHA-256 signature for all exports**
  (`packages/api-gateway/src/routes/admin/audit-log.ts`):
  - CSV export: SHA-256 hash of the payload (incl. UTF-8 BOM) in the
    `X-CoreMail-Signature: sha256=…` response header
  - PDF export: in-memory buffer capture instead of direct `doc.pipe(res)`, then
    hash over the complete PDF buffer
  - **NEW: JSON export** for SIEM integration (Splunk, Azure Sentinel, ELK) —
    `/admin/audit-log/export.json` with a structured `metadata`+`entries` object,
    `schemaVersion: '1.0'`, also SHA-256-signed
  - Additional headers: `X-CoreMail-Export-Entries`, `X-CoreMail-Export-Generated-At`
  - `Access-Control-Expose-Headers` so the frontend can read the signature
  - External verification: `shasum -a 256 audit-log-YYYY-MM-DD.csv` → must match
    the header exactly → proves to auditors that the file was not
    tampered with

- **Anomaly detection** — new endpoint `/admin/audit-log/anomalies`:
  - **Burst detection**: ≥50 actions by the same actor in 5 min (medium),
    ≥200 actions → high severity
  - **Failure burst**: ≥10 failed actions in 5 min → high (possible attack)
  - **Critical actions**: regex pattern for `user.delete`, `mailbox.delete`,
    `domain.delete`, `transport-rules.*`, `oauth.*`, `settings.*`, `certificate.*`,
    `gateway.*`, `connector.*`, `smime.*`, `setup.*` → always high
  - **Off-hours activity**: admin activity between 00:00 and 06:00 server time
    → low severity
  - Dedup logic merges identical anomalies (actor+message)
  - The frontend shows the top 50 as a red banner with icons, actor, time and
    severity badge — auto-refresh every 60s

- **Meta-logging against insider threats**
  (`packages/api-gateway/src/lib/audit.ts`):
  - **AUDIT_SENSITIVE_GET**: GET routes for audit log exports (CSV/PDF/JSON) and
    anomalies are now audited as well. Whoever exports audit data or
    retrieves compliance reports is logged themselves — no silent
    data exfiltration by admins
  - Extended code comment documents the immutability guarantee:
    the audit log has no DELETE endpoint, no UI toggle to switch it off;
    tampering attempts require a code deploy → traceable via Git/CI/CD
    (ISO 27001 / SOC 2 / TISAX / GDPR compliant)

- **Frontend AuditLogPage** (`packages/admin-panel/src/pages/AuditLogPage.tsx`):
  - **JSON export button** added (for SIEM)
  - **Anomalies banner** at the top of the page — automatic 60s refresh, scrollable,
    severity colors (red/amber/blue), icons per anomaly type
  - **Signature hint** in the immutability banner: documents the
    `X-CoreMail-Signature: sha256=…` header and local verification
  - The existing stats dashboard (KPI cards, top actors, top actions) remains

### Schema migration

- `Message.spamScore Float?` — added automatically at the next container start via
  `prisma db push` (no data loss, existing
  messages have `null`)

---

## [3.18.5] — 2026-05-24 — Removed: eDiscovery & Legal Hold removed completely

### Removed

- **Phase 8 features eDiscovery & Legal Hold fully removed from the code**
  (backend, frontend, schema, routes, i18n):
  - **Schema** (`packages/storage/prisma/schema.prisma`): models `EDiscoverySearch`,
    `LegalHold` and enum `EDiscoveryStatus` deleted.
    `RetentionPolicy.respectLegalHold` field removed (default was `true` but it
    no longer had any effect since `LegalHold` records had no UI for creation).
  - **Backend**: file `packages/api-gateway/src/routes/admin/ediscovery.ts` deleted.
    Import + mount in `server.ts` removed (the `/api/v1/admin/ediscovery` route now
    returns 404).
  - **Retention route** (`routes/admin/retention.ts`): `respectLegalHold` removed from
    POST/PUT body, validation and Prisma update.
  - **Backup worker** (`packages/backup-service/src/retention/worker.ts`):
    `prisma.legalHold.findMany()` call removed; `heldUserIds` is now an
    empty set (signature compatibility for downstream functions).
  - **Frontend**: file `packages/admin-panel/src/pages/EDiscoveryPage.tsx` deleted.
    Sidebar entry "eDiscovery" removed, route removed from `main.tsx`,
    `nav_ediscovery` i18n key deleted in DE+EN, unused `SearchCheck` icon import
    removed, RbacPage `COMPLIANCE_MANAGEMENT` description changed from "eDiscovery, retention"
    → "Retention policies".
  - **RetentionPage**: `respectLegalHold` field removed from the `RetentionPolicy` type, form state,
    template creator and UI checkbox.

  **Existing data**: existing `ediscovery_searches` + `legal_holds` tables
  are dropped automatically at the next `prisma db push --accept-data-loss` (in the container entrypoint).
  The `retention_policies.respect_legal_hold` column likewise.

  **Migration**: anyone upgrading an existing installation who actually uses
  the feature: please back up eDiscovery exports before upgrading.
  Recommended for this is the `mbox` streaming export of the existing searches
  under v3.18.4 or older — then upgrade.

---

## [3.18.4] — 2026-05-24 — Feature: signature editor with images, links, fonts

### Added

- **MWA signatures fully built out** — Gmail/Outlook level
  (`packages/web-client/src/components/SignatureSection.tsx` — new separate component):

  **Formatting:**
  - Font dropdown: 10 options (Arial, Calibri, Georgia, Times New Roman,
    Courier New, Verdana, Tahoma, Trebuchet MS, Comic Sans MS, Default)
  - Font size dropdown: 5 levels (Small 12px / Normal 14px / Medium 16px /
    Large 20px / Very large 28px) — via custom `FontSizeExt` TipTap extension
    on the `textStyle` mark
  - Bold / Italic / Underline / Strikethrough (with the correct U icon —
    was previously wrongly "U" = strikethrough!)
  - Text color (24 colors) + highlight color (12 highlight colors)
  - Alignment (left, centered, right, justified)
  - Bullet lists + numbered lists + quote block
  - Horizontal rule (`<hr>`)
  - Undo / Redo / Clear formatting

  **Insert images** (for logos, profile pictures, banners):
  - Upload button → file picker (max 500 KB, base64 embed)
  - URL input button
  - Drag & drop directly into the editor (with overlay "Drop image here")
  - `@tiptap/extension-image` with `allowBase64: true`

  **Links** with an interactive prompt:
  - With a selection → the selected text becomes the link
  - Without a selection → the URL is inserted as link text
  - Edit/remove link via the same button (toggle on an active link)

  **Preview mode**:
  - "Preview" button top right → shows the signature exactly as it would appear in
    the recipient's mail reader (HTML rendering without editor chrome)
  - "Editor" button switches back

  **Auto-insert options** (as before):
  - For new e-mails
  - For replies and forwards

  **Technical:**
  - Custom `FontSizeExt` with `addGlobalAttributes()` on the TextStyle mark
    (TipTap has no FontSize extension of its own)
  - `applyFontSize()` helper works around ChainedCommands type conflicts
  - Inline images embedded as data: URL — no MinIO upload needed,
    works in all mail clients (Gmail, Outlook, Apple Mail)
  - 500 KB limit per image prevents overweight outbound mails
  - Dark-mode-capable toolbar

---

## [3.18.3] — 2026-05-24 — Fix: BCP DNS check counter + status colors

### Fixed

- **BCP → SMTP & Routing → DNS records: counter and yellow indicators were inconsistent**
  (`packages/admin-panel/src/pages/SmtpConfigPage.tsx`):

  **Root cause**: the backend endpoint returns **7 records** (`a, mx, spf, dkim, dmarc,
  autodiscover, ptr`), but the UI renders only **6** of them (the A record is not
  shown). The counter `okCount` however counted all 7 records against a
  hard-coded `total = 6`. Result: with e.g. 6 ok + 1 warning (A invisible, 1
  warning visible) → "6 of 6" although a yellow entry was visible. With
  5 ok + 2 warning → "5 of 6 — 1 missing" although 2 were visibly yellow.

  Also: warnings (e.g. SPF multi-record, PTR mismatch) were not mentioned in the status text
  at all — they were neither "ok" nor "missing" and fell through the cracks.

  **Fix**:
  - `VISIBLE_DNS_KEYS` = `['mx','spf','dkim','dmarc','autodiscover','ptr']` as
    the single source of truth. `okCount`, `warnCount`, `missingCount` and `total`
    are calculated consistently from this list.
  - The status text now differentiates clearly: "5 of 6 records set — 1 with
    warning, 0 missing" / "4 of 6 — 1 with warning, 1 missing" / etc.
  - `StatusDot` now shows **3 colors** (green = ok / yellow = warning / red = missing)
    instead of only green/yellow. Badge analogously with ⚠ Warning / ○ Not found.
  - Legend updated: correctly green/yellow/red instead of the outdated orange for
    "resolver inconsistency" (gone since v3.17.34 — multi-resolver removed).

---

## [3.18.2] — 2026-05-24 — UI cleanup, button fix + compose rollback

### Reverted

- **Compose window rolled back to the pre-v3.18.1 variant** —
  the Gmail-style redesign from v3.18.1 (3 sizes, header drag, schedule-send dropdown,
  emoji picker, footer format toolbar) is withdrawn. The old compose variant
  (Outlook-inspired, formatting toolbar at the top, Send bottom right, attachment+draft
  bottom left) fits the rest of the CoreMail UI better. `ComposeWindow.tsx` is exactly
  identical to the version from v3.18.0.

### Changed

- **MWA: "Outlook" mentions removed from user-facing UI texts**:
  - `RulesSection.tsx`: stop-processing hint without the Outlook comparison
  - `SettingsPage.tsx → View`: "Customize layout and display options for CoreMail"
    (instead of "— like in Outlook or Thunderbird")
  - `SettingsPage.tsx → App passwords`: "Connect external e-mail clients without your main password"
    (instead of "For e-mail clients (Outlook, Thunderbird) …")

  Technically necessary Outlook references remain (Autodiscover setup guide
  in the BCP, "Outlook Modern Auth" as an OAuth2 client example in the admin panel, historical
  changelog/compliance entries), because these point to the real Microsoft Outlook client
  as an external IMAP/EAS consumer.

### Fixed

- **MWA: "+ New rule" button shrank at narrow viewport widths** and wrapped
  its text. Fix: `shrink-0 whitespace-nowrap px-4` — the button keeps a fixed width,
  the text stays on one line.

---

## [3.18.1] — 2026-05-24 — Feature: Gmail-style compose window redesign

### Changed

- **MWA compose window completely redesigned after the Gmail model**
  (`packages/web-client/src/components/ComposeWindow.tsx`):

  **Window modes:**
  - **Small** (default, floating 600×640 bottom right) — header draggable with the mouse
  - **Large** (full screen, centered, max 1100px, 90vh) — toggle via maximize button in the header
  - **Minimized** (288px strip bottom right with subject)
  - Smooth transition `transition-[width,height,inset] duration-300 ease-out` between sizes

  **Footer toolbar (Gmail layout):**
  - **Send button with schedule dropdown** (▲): "Tomorrow morning", "Tomorrow afternoon",
    "Next Monday" presets + custom datetime-local picker — scheduled mails via
    the `scheduledAt` FormData field to `/mail/send`
  - **Aa** format toolbar toggle (on/off)
  - **Paperclip** attachment with badge (number of attachments)
  - **Link** (insert/edit link)
  - **Smile** emoji picker (80 handpicked emojis, 10×8 grid)
  - **Image** insert image via URL
  - **Lock** confidential-mode placeholder (toast "coming soon")
  - **MoreVertical** submenu: full-screen toggle, clear formatting, Cc/Bcc toggle
  - **Trash** discard with confirmation
  - **Draft status display** on the right: "Saving…" / "Draft saved"

  **UX features:**
  - **Drag & drop files**: drop overlay over the entire compose window (paperclip icon
    + "Drop files here to attach")
  - **Keyboard shortcuts**: ⌘+Enter send, ⌘+⇧+C show Cc, ⌘+⇧+B Bcc, Esc close
  - **Cc/Bcc** with X button to hide + reset, fade-in animation when shown
  - **Active-scale animations** (active:scale-90) on all buttons for tactile feedback
  - **Dark mode** supported in all components (dark:bg/dark:border)
  - **Header drag** in small mode moves the window on the viewport (`transform: translate`)
  - **Discard confirmation** only with non-empty content (To/Cc/Bcc/Subject/Body/Attachments)

  Existing helper components (RecipientInput, ColorPicker, BlockTypeDropdown,
  FontFamilyDropdown, ToolBtn, Sep) remain unchanged — they are good, only the
  main layout was rebuilt.

---

## [3.18.0] — 2026-05-24 — Feature: Outlook-style inbox rules

### Added

- **Server-side user inbox rules (analogous to Microsoft Exchange)**
  Complete Outlook rules functionality in Mail Web Access — conditions, actions,
  exceptions and stop-processing manageable directly in the MWA. Rules are
  applied server-side in the SMTP inbound pipeline as soon as a mail arrives —
  regardless of whether the client is open. Also works for IMAP/EWS/EAS access.

  **Backend** (`packages/storage/src/mail-rules.ts`):
  - New schema: `MailRule.exceptions`, `MailRule.stopProcessing`, `MailRule.matchAll`
    (`AND`/`OR` combination) — `@@index([userId, priority])` for sorted lookup.
  - Rule engine: 11 conditions (`from`, `to`, `cc`, `bcc`, `subject`, `body`,
    `recipient`, `hasAttachment`, `size`, `importance`, `sentOnlyToMe`) × 10
    operators (`contains`, `notContains`, `equals`, `notEquals`, `startsWith`,
    `endsWith`, `regex`, `greaterThan`, `lessThan`, `is`).
  - 12 actions: `moveTo`, `copyTo`, `delete` (→ Trash), `hardDelete` (discard),
    `markRead`, `markFlagged`, `pin`, `categorize`, `forward`, `redirect`,
    `markJunk`, `setImportance`.
  - Forward/redirect via the existing `smtp-outbound` BullMQ queue with loop protection
    (the `X-CoreMail-RuleForwarded` header prevents endless forwards).
  - Hook in `storeInboundMessage()`: after the junk decision, before folder assignment —
    can override the target folder, set flags/categories, discard the mail or
    copy it into several folders.

  **API** (`packages/api-gateway/src/routes/user.ts`):
  - `GET /user/rules`, `POST`, `PUT/:id`, `DELETE/:id` — CRUD with Zod validation
  - `PATCH /user/rules/:id/toggle` — quick enable/disable
  - `POST /user/rules/reorder` — drag-reorder persistence via transaction
  - `POST /user/rules/:id/run-now` — apply a rule retroactively to existing mails
    (max. 5000, forward/redirect skipped for safety)

  **Frontend** (MWA):
  - **Settings → "Rules"** (`packages/web-client/src/components/RulesSection.tsx`):
    list of all rules with toggle, drag-reorder (dnd-kit), edit, delete
    and "Run now". Empty state with CTA.
  - **RuleEditorModal** (`packages/web-client/src/components/RuleEditorModal.tsx`):
    Outlook-style 3-step wizard — "When the message arrives and …" /
    "Do the following:" / "Except if …" with folder picker, category picker,
    e-mail input for forward/redirect. `AND`/`OR` choice, stop-processing checkbox.
  - **Context menu "Rules" in MessageList**: right-click on a mail →
    "Create rule …" opens the editor with a pre-filled "From" condition
    or "Manage rules …" jumps to the settings page.

---

## [3.17.50] — 2026-05-24 — Fix: MWA source context menu opens modal instead of tab

### Fixed

- **MWA: "View source" in the right-click menu opens the RFC 822 modal instead of a browser tab**
  (`web-client/src/components/MessageList.tsx`):
  The context menu entry "View source" in the message list opened the
  raw text via `window.open()` in a new browser tab (the browser tried to download
  the file). Fix: fetch request with `?token=` auth, then display in the
  same RFC 822 source modal as in `MessageReader` (overlay, scrollable,
  monospace font, EML download button, close via ESC/click on backdrop).

---

## [3.17.49] — 2026-05-24 — Fix: MWA source/EML auth, junk logic, reply indicator

### Fixed

- **MWA: View source → 401 Unauthorized fixed**
  (`web-client/src/components/MessageReader.tsx`):
  The `fetch()` call for the RFC 822 source was issued without authentication
  (no `Authorization` header in a browser-initiated fetch). Fix: bearer token as
  `?token=…` query parameter (already supported by the auth middleware for SSE),
  read from `useAuthStore().accessToken`. Loading errors are now shown in the modal
  instead of failing silently.

- **MWA: EML download → 401 Unauthorized fixed**
  (`web-client/src/components/MessageReader.tsx`, `MessageList.tsx`):
  Browser navigation (`<a href>` and `window.open()`) does not support custom headers.
  Fix: the same `?token=…` pattern for all EML download and source links in
  MessageReader and the MessageList context menu.

- **MWA: "Not junk" button was missing in the Junk folder**
  (`web-client/src/components/MessageReader.tsx`):
  The context menu always showed "Mark as junk" regardless of the current folder.
  Fix: `isJunkFolder` detection via `selectedFolderId` + folders query; conditional
  menu entries — the Junk folder shows "Not junk (false positive)" with a ShieldOff icon,
  all other folders show "Mark as junk".

- **Future mails from senders manually marked as junk land in Junk automatically**
  (`api-gateway/src/routes/mail.ts`, `smtp-server/src/handlers/message.ts`):
  The `spam` action in the bulk endpoint now additionally writes a `Blacklist` entry
  with `scope: 'USER-JUNK'` for each unique sender. `storeInboundMessage()`
  checks these entries on incoming mails and routes to the Junk folder on a match.
  The `notSpam` action removes the corresponding entries. Both actions trigger rspamd
  Bayes training (`learnspam`/`learnham`) for improved spam detection.

- **MWA: reply indicator on answered mails**
  (`web-client/src/components/MessageReader.tsx`, `MessageList.tsx`):
  Mails that had been replied to received no visual marker (like Outlook's
  reply arrow). Fix:
  - `MessageReader`: the Reply/Reply-all buttons now set the IMAP flag
    `\Answered` via `patchMutation` (`markAnswered()` function).
  - `MessageList`: blue `Reply` icon in the icons column when `flags` contains the
    `\Answered` flag.

---

## [3.17.48] — 2026-05-24 — Fix: SMTP PIPELINING race condition (503 on server-to-server)

### Fixed

- **SMTP: 503 5.5.1 Bad sequence of commands on incoming mails fixed**
  (`smtp-server/src/core/session.ts`):

  **Root cause**: the SMTP server advertised `PIPELINING` (RFC 2920) and external MTAs
  (Gmail, Postfix, Exchange) used it correctly — they sent `MAIL FROM`, `RCPT TO`
  and `DATA` in one go. Since `handleMailFrom()` and `handleRcptTo()` are asynchronous
  handlers (`await onMailFrom()` → DB query, security filter), the
  state (`READY → MAIL → RCPT`) only changed after the `await`. By then the synchronous
  dispatch loop had already processed `RCPT TO` and `DATA` — both saw state `'READY'`
  instead of `'MAIL'`/`'RCPT'` → both were rejected with `503 5.5.1 Bad sequence of commands`.
  The `250 OK` for `MAIL FROM` arrived afterwards, too late and misplaced.
  External senders (Gmail, Postfix, Exchange) got their mails back as permanently
  failed.

  **Fix**: command queue (`cmdQueue: Promise<void>`) — all SMTP commands are
  enqueued via `enqueueCommand()` into a chained promise chain and run
  strictly sequentially:
  ```
  EHLO → [250] → MAIL FROM → await onMailFrom() → [250] → RCPT TO → await onRcptTo() → [250] → DATA → [354]
  ```
  Responses now arrive in the correct order guaranteed, no matter how fast
  the sending MTA pipelines. AUTH multi-step and `finishData()` are enqueued
  as well.

---

## [3.17.47] — 2026-05-23 — Feature: BCP DNS setup panel

### Added

- **DNS setup panel in BCP → Domains → Edit domain** (`DomainsPage.tsx`):
  New button "Check DNS setup" opens a complete setup panel
  with all 7 DNS records needed for a fully configured mail server.
  Values are derived automatically from the current SSL/TLS configuration
  (publicHostname) and the DKIM key:
  - **A record** — mail server IP (from the live-resolved server IP)
  - **MX record** — inbound mail to the mail server hostname
  - **SPF record** — with the real server IP (`v=spf1 ip4:<IP> ~all`)
  - **DKIM record** — complete p= value incl. 255-character chunk option
    (expandable, for DNS providers with a 255-character limit)
  - **DMARC record** — ready-made template with rua= for the domain
  - **Autodiscover** — CNAME to the mail server hostname
  - **PTR/reverse DNS** — with a note about the server hoster
  Each record shows: type badge (colored), status (✅/❌), copyable host/name value
  and copyable content value. The modal switches to max-w-2xl when the panel is open.

### Changed

- **DNS check backend improved** (`api-gateway/routes/admin/domains.ts`):
  - The server IP is resolved live from the hostname and returned in the response as `serverIp`
  - The SPF `expected` value now contains the real server IP instead of a placeholder
  - The DKIM `ok` flag now compares the complete key (whitespace-normalized),
    not just whether any DKIM record exists
  - The PTR check uses the already-resolved server IP (no second DNS lookup)
  - New `a` record section in the API response

---

## [3.17.46] — 2026-05-23 — Fix: DKIM public key format (SPKI → PKCS#1)

### Fixed

- **DKIM DNS record syntactically correct** (`api-gateway/routes/admin/domains.ts`):
  The public key was previously exported in SPKI format (SubjectPublicKeyInfo, with algorithm OID wrapper)
  — DKIM however expects PKCS#1 (plain RSAPublicKey without OID). Fix:
  `pubKey.export({ type: 'spki', format: 'der' })` → `type: 'pkcs1'` in all three
  places (dkim-record, regenerate-dkim, dns-check). The generated `p=` value in the BCP
  is now RFC 6376-compliant and passes DNS verification.

---

## [3.17.45] — 2026-05-22 — Feature: compact queue overview + discard function

### Changed

- **BCP queue overview completely reworked** (`QueuesPage.tsx`):
  - Stats cards (5 large cards) → compact horizontal strip with numbers + icon
  - Verbose state explanation cards at the bottom removed
  - Distribution bar chart removed (redundant with inline stats)
  - **Direct queue table in the overview**: shows all pending messages
    (waiting / active / delayed / failed) with status badge, sender, recipient,
    age and attempts — no navigating into sub-sections needed

### Added

- **"Discard" button directly in the overview**: every pending message
  can be discarded permanently with one click (confirmation dialog). For
  retry and dead-letter entries additionally a "Retry now" button.
- **"Discard" in all job tables** now as a labeled button instead of an icon,
  much more recognizable.
- Shows up to 25 entries in the overview; with more → links to the sub-sections.

### Fixed

- **Two refresh buttons reduced to one**: the refresh button in every
  sub-section (`JobsSection`) was removed. Only a single global refresh in the
  page header remains — it refreshes stats, jobs and overview at the same time.

---

## [3.17.44] — 2026-05-22 — Fix: eDiscovery search form loses focus after every letter

### Fixed

- **BCP eDiscovery — input field focus bug** (`EDiscoveryPage.tsx`): the internal
  `Field` helper component was defined inside the `CreateSearchModal` function.
  React creates a new component reference in every render phase → the input is
  unmounted/remounted → focus is lost → after every typed character the field
  had to be clicked again.

  Fix: `Field` moved to module level as `SearchField` (explicit `value` +
  `onChange` props instead of `k: keyof typeof form`). All 8 usages in the modal
  updated. React now keeps the DOM reference across re-renders.

---

## [3.17.43] — 2026-05-22 — Fix: audit log writes no entries

### Fixed

- **`auditMiddleware` path bug** (`lib/audit.ts`): the middleware is mounted via
  `app.use('/api/v1/admin', auditMiddleware)`. Inside the middleware Express
  provides `req.path` **without** the mount prefix — i.e.
  `/mailboxes/123` instead of `/api/v1/admin/mailboxes/123`. The condition
  `req.path.startsWith('/api/v1/admin/')` was therefore **never true** →
  not a single audit entry was ever written to the DB.

  Fix: prefix check removed (redundant when already mounted on `/api/v1/admin`).
  `pathParts` extraction switched to the relative path
  (`req.path.replace(/^\//, '').split('/')`).

---

## [3.17.42] — 2026-05-22 — Feature: edit certificates (name, services, auto-renew)

### Added

- **BCP SSL/TLS — edit certificate** (`CertificatesPage.tsx`): a pencil icon (✏️)
  in the actions column opens an edit modal for each certificate.
  Editable: name, service assignment (SMTP/IMAP/POP3 with exclusivity display),
  auto-renew (only for Let's Encrypt certificates).
  Shown read-only: type, status, domains, HTTPS proxy status, protocol TLS status.
  Calls `PUT /api/v1/admin/certificates/:id`.

### Fixed

- **`PUT /:id` route** (`routes/admin/certificates.ts`): `isActiveProtocol` was missing
  from the Prisma `select` — was not returned in the response. Fixed.

---

## [3.17.41] — 2026-05-22 — Fix: ACME process aborts after 5 minutes

### Fixed

- **ACME timeout** (`routes/admin/certificates.ts`): `runAcmeIssuance()` no longer
  runs forever. `Promise.race()` aborts the ACME process after 5 minutes
  and sets the certificate to `ERROR` — even if `client.auto()` hangs (port 80
  unreachable, Let's Encrypt not responding, etc.).

- **Startup cleanup** (`server.ts`): at container start, certificates
  stuck in status `PENDING` or `RENEWING` for longer than 10 minutes are automatically
  set to `ERROR`. Prevents permanently hanging certs after a restart.

- **Double-start protection** (renew route): `POST /:id/renew` now returns `409 Conflict`
  if the cert is already `PENDING` or `RENEWING` — no parallel
  second ACME process possible anymore.

- **BCP SSL/TLS UI**: the renew button (↻) is disabled for `PENDING` certs and
  shows a spinner + tooltip "ACME process still running — please wait".

---

## [3.17.40] — 2026-05-22 — Fix: exclusive service assignment for certificates

### Fixed

- **Exclusive service assignment** (`routes/admin/certificates.ts` + `CertificatesPage.tsx`):
  SMTP, IMAP and POP3 can each be assigned to only one certificate at a time.
  When creating or updating a certificate with services, these services are
  automatically removed from all other certificates (`claimServices()` function).

- **BCP SSL/TLS UI — service selector**: services already claimed by another cert
  are marked orange (⚠ warning symbol + tooltip "Currently on 'Cert X' — will be taken over").
  On selection a hint banner appears listing which services will be transferred on save.

---

## [3.17.39] — 2026-05-22 — Fix: update publicHostname automatically on certificate activation

### Fixed

- **`applyProtocolCert()` now updates `publicHostname`** (`routes/admin/certificates.ts`):
  When activating a certificate for SMTP/IMAP/POP3 (server icon),
  `server_settings.publicHostname` is set to the certificate's primary domain.
  Previously the SMTP banner continued to show the old hostname (`mail.localhost`) even
  when a CA-signed certificate for `mail.example.de` was activated.

- **`activate-protocol` route** now also selects `domains` and passes them to
  `applyProtocolCert()` — previously this field was missing from the `select`.

- **ACME auto-activation** (`runAcmeIssuance`): when a Let's Encrypt certificate
  has been issued successfully and `services` contains SMTP/IMAP/POP3,
  `applyProtocolCert()` is called automatically after issuance. Until now
  the admin had to click the server icon manually after every ACME issuance.

---

## [3.17.38] — 2026-05-22 — Auto self-signed cert at setup + spam filter can be enabled/disabled

### Added

- **Auto self-signed cert at setup** (`api-gateway` → `routes/setup.ts`):
  After a successful initial setup (`POST /api/v1/setup/complete`) a
  self-signed certificate (RSA-2048, 10 years) for the `publicHostname` is generated automatically
  and written to the `certificates` table. The cert is immediately visible in BCP → SSL/TLS,
  activated as the default protocol TLS (`isActiveProtocol: true`) for SMTP/IMAP/POP3
  and written to `server_settings.tlsCert/tlsKey` — SMTP/IMAP/POP3
  pick it up immediately via Redis `settings:reload`.

- **Spam filter toggle with hot reload** (`security-filter` → `server.ts`, `pipeline/index.ts`):
  `rspamdEnabled` and `clamavEnabled` from `SecuritySettings` are loaded from the DB
  at startup. On a change in BCP → Protection filters → Rspamd/Antivirus followed by
  save, `settings:reload` via Redis triggers an immediate reload in the security filter
  — no container restart needed. Pipeline stages 4c (ClamAV) and 4d (rspamd)
  are skipped completely when `enabled: false`.

### Changed

- **`PipelineConfig` interface** (`security-filter/pipeline/index.ts`): new optional
  fields `rspamdEnabled?: boolean` and `clamavEnabled?: boolean` — default `true`
  (compatible with existing calls).

- **`security-filter/server.ts`**: loads SecuritySettings from the DB at startup and
  subscribes to the Redis channel `settings:reload` for hot reload. New function
  `loadSecuritySettings()`.

### Fixed

- **`routes/admin/security.ts`** — `PUT /admin/security/settings` now publishes
  `settings:reload` via Redis after saving so the security filter immediately
  picks up `rspamdEnabled`/`clamavEnabled` (without a container restart).

---

## [3.17.37] — 2026-05-22 — BCP SSL/TLS: banner removed, services reduced to SMTP/IMAP/POP3

### Changed

- **BCP → SSL/TLS → Certificates**: gray info banner for a missing HTTPS certificate removed —
  the page shows no banner when no cert is active (the green banner remains with active HTTPS).

- **Service selection in certificate forms** (Let's Encrypt, upload, self-signed): reduced
  to `SMTP`, `IMAP`, `POP3` — web services (MWA, BCP, EWS, CalDAV, Autodiscover) removed,
  since HTTPS is activated exclusively via the lock icon and not via the services list.

---

## [3.17.36] — 2026-05-22 — HTTPS_PROXY_ENABLED removed — integrated proxy always active

### Removed

- **`HTTPS_PROXY_ENABLED` environment variable** removed completely from `tls-proxy.ts`,
  `routes/admin/certificates.ts`, `docker-compose.yml` and `docker-compose.synology.yml`.
  The integrated HTTPS proxy is always active — it starts port 443 only when a
  certificate with `isActiveHttps: true` exists, otherwise port 443 stays closed.
  No configuration toggle needed anymore.

- **`isTlsProxyEnabled()` export** removed from `tls-proxy.ts`.

- **`enabled` field** removed from the `/tls-proxy-info` API response.

- **"Integrated HTTPS proxy disabled" banner** removed from BCP → SSL/TLS.
  The banner now shows only two states: HTTPS active (green) or no
  HTTPS certificate active (gray with hint).

---

## [3.17.35] — 2026-05-22 — Certificate logic: full decoupling of HTTPS/protocol + self-signed default

### Changed

- **Certificate activation decoupled** (`api-gateway` → `routes/admin/certificates.ts`):
  HTTPS proxy (lock icon) and protocol TLS (server icon) for SMTP/IMAP/POP3 are
  fully **independent** — a certificate can be active for HTTPS only, for protocols only, or
  for both. `activate-https` no longer touches `isActiveProtocol`.

- **Self-signed default**: `server_settings.tlsCert/tlsKey = NULL` is the normal state.
  SMTP/IMAP/POP3 automatically generate a self-signed cert from `publicHostname` when
  no explicit activation has taken place. No implicit auto-activation when creating
  or uploading a certificate.

- **Startup sync** (`syncProtocolCertState()`): replaces the old `migrateCertProtocolBinding()`
  — checks at container start whether `server_settings.tlsCert` exists but no
  `isActiveProtocol: true` cert exists in the DB (orphaned cert) and cleans this up.

- **Delete certificate — full cleanup**: if a certificate is deleted that is
  `isActiveProtocol: true`, `server_settings.tlsCert/tlsKey` are set to NULL
  and SMTP/IMAP/POP3 immediately load the self-signed fallback. If the cert was active for HTTPS,
  the HTTPS proxy is deactivated as well.

- **BCP — certificates page** (`admin-panel` → `CertificatesPage.tsx`):
  the server icon (SMTP/IMAP/POP3) is now **always** visible for all ACTIVE/EXPIRING certs
  — regardless of HTTPS status. Toast messages and tooltips correctly separated.
  The delete confirmation warns when the cert is active for HTTPS or protocol TLS.
  An info banner explains the independence of both activation types.

---

## [3.17.34] — 2026-05-22 — DNS check: local resolver, no resolver banner/badges/details

### Changed

- **DNS record check** (`api-gateway` → `routes/admin/domains.ts`): now uses the
  server's **local DNS resolver** (`dns.promises`) instead of three external resolvers
  (Google/Cloudflare/Quad9). API response simplified: only `ok`, `found`, `warning?`
  per record — no more `resolvers[]`, `consistent`, `checkedAt`, `resolversUsed`.

### Removed

- **External resolver banner** (BCP → SMTP & Routing → DNS records): the blue
  info banner "External resolvers: Google (8.8.8.8) Cloudflare (1.1.1.1) Quad9 (9.9.9.9)"
  was removed.

- **Per-resolver badges**: the colored Google/Cloudflare/Quad9 badges with latency display
  under each DNS record were removed.

- **Expandable resolver detail view**: the "▼ Show resolver details" link with
  IP, latency and found value per resolver was removed.

- **Inconsistency warning**: the orange "Resolver inconsistency" hint was removed
  (no longer relevant without multi-resolver querying).

- **"Checked at HH:MM:SS" timestamp** in the DNS header removed (no more `checkedAt`
  information in the API response).

---

## [3.17.33] — 2026-05-22 — Fix: Redis channel in startup migration (CHANNEL_SETTINGS_RELOAD)

### Fixed

- **🔧 Startup migration `migrateCertProtocolBinding()`**: the wrong Redis channel
  name `'coremail:settings:reload'` was replaced by the correct constant
  `CHANNEL_SETTINGS_RELOAD` (`'settings:reload'`) from `@coremail/core`.
  Without this fix the SMTP/IMAP/POP3 servers were not informed about the new TLS certificate
  at the first container start after the upgrade — the protocol servers
  kept running with the old self-signed cert despite correct DB entries.

---

## [3.17.32] — 2026-05-22 — Fix: TLS cert logic — one cert for all protocols (SMTP 503 fixed)

### Fixed

- **🔒 503 5.5.1 Bad sequence of commands — root cause fixed**: the certificate
  for `mail.stefanwuestner.de` was activated ONLY for the HTTPS proxy (MWA/BCP);
  SMTP/IMAP/POP3 continued to use the old self-signed certificate from
  `ServerSettings.tlsCert/tlsKey`. External MTAs (Google, Outlook) rejected the
  STARTTLS handshake → 503.

- **🏗️ `activate-https` now ALWAYS also activates SMTP/IMAP/POP3**: when the
  lock icon is clicked, the server writes the certificate ATOMICALLY to
  `ServerSettings.tlsCert/tlsKey` AND sends `CHANNEL_SETTINGS_RELOAD` — all
  mail protocol servers load the new cert immediately without a restart.

- **🛑 Removed: MWA+BCP services requirement for the lock button**: the lock button
  was previously only visible when the cert explicitly had the services `MWA` and `BCP`
  — an arbitrary hurdle without technical reason. Now every
  valid certificate (ACTIVE/EXPIRING) shows the lock button.

### Added

- **`isActiveProtocol` field** (`Certificate` Prisma model): shows in the BCP which
  certificate is currently active for SMTP/IMAP/POP3 (ports 465/993/995) —
  independent of the HTTPS proxy status.

- **`POST /admin/certificates/:id/activate-protocol`**: new endpoint for setups
  with an external reverse proxy (Traefik, Caddy, Synology DSM) where the integrated
  HTTPS proxy is disabled but the mail server needs a CA-signed cert for
  SMTP/IMAP/POP3.

- **Server icon in the BCP** (`CertificatesPage`): new <Server> icon next to the
  lock — clicking it activates the cert for protocol TLS only
  (without the HTTPS proxy). Shows blue when `isActiveProtocol: true`.

- **Detail view** (expanded row): now shows BOTH statuses separately —
  _HTTPS proxy (port 443)_ and _protocol TLS (SMTP/IMAP/POP3)_ each with its own
  icon, so the admin sees immediately what is active where.

### Changed

- **`deactivate-https`**: stops only the HTTPS proxy, does NOT touch `isActiveProtocol`
  — SMTP/IMAP/POP3 keep running with the same cert when the admin
  switches from the integrated proxy to external Traefik/Caddy.

---

## [3.17.31] — 2026-05-22 — DNS check: real multi-resolver verification

### Added

- **🔍 Real DNS verification via external resolvers** (`api-gateway` → `routes/admin/domains.ts`):
  Instead of querying the Docker-internal resolver (127.0.0.11, often cached/stale),
  MX, SPF, DKIM, DMARC, Autodiscover and PTR/FCrDNS are now checked directly at
  **Google (8.8.8.8)**, **Cloudflare (1.1.1.1)** and **Quad9 (9.9.9.9)**.
  `dns.promises.Resolver.setServers()` — no detour through the system DNS.

- **🌐 PTR / FCrDNS check**: reverse DNS `A → PTR → back-to-A` is automatically verified on
  real public resolvers. Status green only when the PTR resolves to the own
  hostname (forward-confirmed, mandatory for Gmail).

- **⚠️ SPF multi-record detection**: RFC 7208 §3.2 allows exactly one SPF TXT
  record. If two exist → `permerror` at all recipients. The BCP
  now shows an explicit red warning + correction hint.

- **📊 Per-resolver badges in the BCP** (`admin-panel` → `SmtpConfigPage.tsx`):
  each DNS row shows colored badges for Google/Cloudflare/Quad9 with latency
  (green = found, red = not found/error). Expandable detail view
  per resolver with the exact finding and error message.
- **🔄 Consistency warning**: when two resolvers return different values
  (e.g. freshly propagating records) → orange "Inconsistency" warning.

- **🕐 Timestamp + resolver info banner**: the DNS result shows the check time and
  which public resolvers were queried.

### Fixed

- **Docker DNS phantom**: internal DNS results did not match what
  external MTAs (Gmail, Outlook) actually see. The new multi-resolver
  check reflects the reality of the public DNS infrastructure.

---

## [3.17.30] — 2026-05-22 — Outbound e-mail pipeline completely rebuilt (Google-compliant)

### Changed

- **🏗️ Structured BullMQ job instead of base64 blob**: `POST /api/v1/mail/send` now
  hands a structured message (`StructuredMessage`) to the worker — no more
  `rawMessage: base64` field. This relieves Redis considerably (no more large blobs).

- **📎 Attachments via MinIO**: uploaded attachments are stored in MinIO immediately
  (`outbound-queue/{jobId}/{filename}`). The worker downloads them when building the MIME
  and cleans them up automatically after successful delivery.

- **✍️ DKIM now via nodemailer transport option** (no more manual mailauth prepend):
  ```typescript
  nodemailer.createTransport({ host, ..., dkim: { domainName, keySelector, privateKey } })
  ```
  This is the more robust method recommended by nodemailer. The signature is correctly
  computed over the entire message stream — no more errors from inserting
  headers afterwards.

- **🗂️ Sent copy cleanly separated**: the RFC 5322 buffer for the "Sent Items"
  folder continues to be built in-memory (with the attachments already in RAM)
  — independent of the queue worker.

- **🧹 relay.ts cleaned up**: `ensureRfc5322Headers()` and `signMessage()` (mailauth) removed.
  RFC 5322 mandatory headers (From, Message-ID, Date) are guaranteed by the api-gateway and the SMTP
  submission handler; the safety-net function is no longer needed.

- **📦 SMTP submission path compatible**: `OutboundJob.rawMessage` (base64) remains for
  the SMTP submission path (ports 465/587) — e-mail clients deliver complete
  RFC 5322 messages, no structuring needed.

### Fixed

- **Order bug**: DKIM signing and the header safety check were in the wrong
  order — headers were inserted after signing, which would have invalidated the DKIM
  signature. With transport DKIM this problem disappears completely.

---

## [3.17.29] — 2026-05-22 — Fix: RFC 5322 compliance — From & Message-ID headers

### Fixed

- **🎯 Gmail 550 5.7.1 — From header & Message-ID header missing**: outgoing
  e-mails were rejected by Gmail with the following errors:
  - `550 5.7.1 ... 'From' header is missing`
  - `550 5.7.1 Messages missing a valid Message-ID header are not accepted`

  **Root cause (api-gateway `routes/mail.ts`)**: the `From` header was built as a
  template literal: `"${user.displayName}" <${user.email}>`.
  - If `displayName = null` → `"null" <email>` (invalid display-name string)
  - If `displayName = ""` → `"" <email>` — an empty quoted string violates RFC 5322
    §3.4 (quoted-string MUST contain at least one character). Strict parsers
    like Gmail treat that as "From header missing".

  **Fix 1 — `api-gateway/routes/mail.ts`**: switch to the Nodemailer object format:
  ```
  from: displayName ? { name: displayName, address: user.email } : { address: user.email }
  ```
  Nodemailer encodes the display name correctly per RFC 2047 (if non-ASCII)
  and omits it when empty → `From: <email>` (clean and valid).
  Additionally `date: new Date()` set explicitly (RFC 5322 §3.6.1 mandatory header).

  **Fix 2 — `smtp-server/outbound/relay.ts`**: new `ensureRfc5322Headers()`
  function as a safety net: checks before every MX/smarthost delivery whether
  `From`, `Message-ID` and `Date` are present in the header block. If missing,
  they are automatically prepended and the event is logged as WARN.
  Protects all outbound paths (REST API + SMTP submission).

---

## [3.17.28] — 2026-05-21 — Fix: self-signed cert with wrong CN (Outlook 503 root cause)

### Fixed

- **🎯 Outlook 365 503 bounce — root cause found**: the stored self-signed
  certificate had `CN=mail.localhost` instead of `CN=mail.stefanwuestner.de`. At the
  first container start `publicHostname` in the DB was still empty, so the
  cert was generated and stored with the default `mail.localhost`. Later restarts
  reused this cert → eternal CN mismatch.

  The TLS handshake worked (OpenSSL confirms that), but Outlook 365 validates the
  **CN against the connected hostname** and rejects on mismatch → ECONNRESET
  → NDR with "503 5.5.1 Bad sequence of commands".

  **Fix in `smtp-server/src/server.ts`** `refreshTlsConfig()`:
  - On cert load, `certMatchesHostname()` is checked (new helper function)
  - A self-signed cert with a mismatch → automatically regenerated with the current
    `_hostname` and stored in the DB
  - CA-signed certs (LE/custom) are NOT regenerated (they could have valid
    SAN lists for multiple domains)

  At the next container restart (or hostname change via BCP) the
  cert is corrected automatically.

- **STARTTLS on port 25 re-enabled**: since the cert now has the correct CN,
  Outlook 365 / strict MTAs also accept the TLS handshake. MX-Tools
  shows "Supports TLS" ✅.

### Removed

- **Auto Let's Encrypt bootstrap from v3.17.27 removed**: the admin requests LE
  manually via BCP → SSL/TLS → "Request Let's Encrypt". File
  `packages/api-gateway/src/lib/auto-letsencrypt.ts` deleted.

### Note: self-signed vs. Let's Encrypt

The self-signed cert is now **compatible** (correct CN/SAN). But:
- MTAs that do **strict cert chain validation** (some banks) still
  reject — they need a trusted issuer
- For 100% MTA compatibility: request a Let's Encrypt cert manually in the BCP

---

## [3.17.27] — 2026-05-21 — Auto Let's Encrypt at container start + STARTTLS revert

### Fixed

- **Outlook 365 returned 503 again with v3.17.26**: advertising STARTTLS with a
  self-signed cert had triggered Outlook 365 bounces again. Self-signed +
  STARTTLS is NOT compatible with strict MTAs — no graceful plain fallback.
  Fix: self-signed → STARTTLS on port 25 OFF again (behavior of v3.17.19).

### Added

- **Automatic Let's Encrypt request at container start**:
  New helper `packages/api-gateway/src/lib/auto-letsencrypt.ts`.
  30 seconds after server start the following is checked:
  1. `ServerSettings.publicHostname` is set AND non-local (no `*.local`/`*.lan`/`localhost`)
  2. No active `LETSENCRYPT` or `CUSTOM` cert covers the hostname
  3. E-mail from `ServerSettings.adminEmail` OR fallback `admin@{root-domain}`

  If all conditions are met → ACME HTTP-01 challenge started (production,
  not staging). On success: the cert becomes ACTIVE, `ServerSettings.tlsCert`/`tlsKey`
  are set, `CHANNEL_SETTINGS_RELOAD` is published — all protocols
  (SMTP/IMAP/POP3) load the new cert. **STARTTLS is activated automatically**
  because `isCertSelfSigned()` now returns `false`.

  On error: log warning, no crash. Manual request via
  BCP → SSL/TLS → "Request Let's Encrypt" still possible.

  **Prerequisites for success:**
  - Port 80 reachable from outside (HTTP-01 challenge)
  - DNS A record for `publicHostname` points to the server IP
  - No Let's Encrypt rate-limit lockout (50 certs/domain/week)

### Refactored

- `runAcmeIssuance()` in `routes/admin/certificates.ts` marked as `export`
  so it can also be used by the auto-LE bootstrap

---

## [3.17.26] — 2026-05-21 — Fix: MX-Tools "Does not support TLS" — STARTTLS active again

### Fixed

- **MX-Tools warning "SMTP TLS Warning - Does not support TLS"**:
  In v3.17.19 STARTTLS on port 25 was hard-disabled for self-signed certs
  to avoid Outlook 365 handshake errors. Result: MX-Tools saw no TLS
  → warning. Even though most MTAs (Gmail, Apple, ProtonMail, AOL …)
  accept opportunistic TLS with self-signed certs.

  **Correct trade-off**: opportunistic TLS is **always better** than no TLS:
  - ~95% of MTAs accept self-signed in opportunistic mode
  - Strict MTAs (Microsoft 365) fall back to plain on a TLS handshake error
    (no bounce, just no TLS for that connection)
  - MX-Tools scoring rewards TLS availability

  Fix: `advertiseStarttls: true` always (instead of `!_tlsCertSelfSigned`).
  STARTTLS is now advertised in EHLO even with a self-signed cert.

### Permanent solution for Outlook 365 compatibility

For full TLS validation in strict MTAs (Microsoft 365, some
banks), issue a **Let's Encrypt certificate** via BCP → SSL/TLS → Certificates →
"Request Let's Encrypt" for `mail.{domain}`. Once active:
- MX-Tools: ✅ full TLS score
- Outlook 365: ✅ accepts the cert without problems
- The self-signed fallback is no longer used

**Prerequisites for Let's Encrypt**:
- Port 80 reachable from outside (HTTP-01 challenge)
- DNS A record `mail.{domain}` points to the server IP

---

## [3.17.25] — 2026-05-21 — MWA: retention policies via right-click

### Added

- **MWA → Settings → Retention policies** (new section under "Account"):
  shows all PERSONAL retention tags enabled by the administrator with name,
  description, retention days and action. Read-only — tags are created by the admin
  in the BCP; users select them via right-click on folders.

- **MWA → folder tree right-click → "Assign retention policy"**:
  submenu with all available PERSONAL tags. The currently assigned tag
  gets a ✓ checkmark. At the bottom a "Remove" entry to delete the assignment.
  Works for system AND custom folders (Exchange behavior).

- **🕒 badge** in the folder tree: folders with an active retention policy show
  a small clock icon after the folder name — tooltip with tag name + days.

### Backend

- **`GET /api/v1/retention-tags`** (new, `requireAuth`): lists enabled
  PERSONAL tags sorted by retention days.
- **`PATCH /api/v1/mail/folders/:id/retention-tag`** (new): body `{ tagId: string | null }`.
  Owner verification; the tag must be PERSONAL and enabled.
- **`PATCH /api/v1/mail/messages/:id/retention-tag`** (new): as above for messages.
- **`GET /api/v1/mail/folders`** extended: now also returns `retentionTagId` +
  the `retentionTag { id, name, retentionDays, action }` relation.

### Frontend

- 11 new i18n keys (`retention_*`) in DE/EN/ES/IT
- `Folder` type extended with `retentionTagId` + `retentionTag`
- ContextMenu already supported submenus — only the usage was extended

---

## [3.17.24] — 2026-05-21 — BCP compliance info page updated

### Changed

- **BCP → Compliance → Info**: highlights list extended with v3.17.12 through v3.17.23
  (12 new entries with detailed descriptions of each version).
  Version display in the header updated (3.17.23 → 3.17.24).

---

## [3.17.23] — 2026-05-21 — Audit log: complete overhaul with PDF export + statistics

### Fixed

- **CSV export failed with 401**: `window.open(…/export…)` opened a new tab
  without an `Authorization` header. Fix: new helper `exportUrl()` in api/client.ts
  appends `?token=…` to the URL — `requireAuth` has accepted the token via query
  since v3.17.18 (SSE fix).

- **Date filter showed no data**: `new Date('2026-05-20T23:59:59')` was
  interpreted as **local time** → in Berlin CEST (UTC+2) the UTC value lay
  before the start of day of the From date. Fix: explicitly UTC with
  `…T00:00:00.000Z` / `…T23:59:59.999Z`.

- **Purge route inconsistent**: the frontend sent `?olderThanDays=`, the backend read
  `req.body.before` — `400 Bad Request` on every cleanup. **Removed completely**
  — audit logs are write-protected for compliance (see "Removed").

- **React Fragment key warning**: `<>...</>` without key in list rendering replaced by
  `<React.Fragment key={e.id}>`.

### Added

- **PDF export** (`GET /api/v1/admin/audit-log/export.pdf`): A4 landscape with header,
  filter summary, table (time/actor/action/target/status),
  page numbers. Cap of 1000 entries (larger volumes → CSV). Uses `pdfkit`.

- **Statistics dashboard** (at the top of the audit log page, auto-refresh 30s):
  - 4 KPI cards: total entries, last 24h, last 7 days, error rate
  - Top 10 actors (bar chart)
  - Top 10 actions (bar chart)
  - New endpoint: `GET /api/v1/admin/audit-log/stats`

- **Extended filters**:
  - `actorEmail` (substring search)
  - `ipAddress` (exact)
  - `searchText` (searches `action`, `targetName`, `errorMsg`)
  - 2-row layout in the frontend with reset button

- **CSV export with all columns + UTF-8 BOM** (Excel-compatible):
  timestamp, actorId, actorEmail, action, targetType, targetId, targetName,
  ipAddress, userAgent, success, errorMsg, changes (JSON)

- **Write-protected banner** in the BCP (dismissible, persisted in localStorage):
  "The audit log is write-protected — entries cannot be deleted
  or modified, even by admins (compliance requirement)"

- **userAgent in the detail view** of the expanded row

### Removed

- **`DELETE /api/v1/admin/audit-log/purge`**: audit logs are **immutable**
  (GDPR, SOX, HIPAA, ISO 27001 requirement — non-repudiation).
  Frontend "Purge" button removed. Should retention needs arise later,
  that runs through the system `RetentionPolicy` (outside the admin API).

### Audit log — core functions (see BCP → Compliance → Audit log):

| Pillar | Implementation |
|---|---|
| **Accountability** | `actorId` + `actorEmail` + `ipAddress` + `userAgent` per entry |
| **Forensics** | full-text search, time range filter, JSON `changes` diff |
| **Compliance** | write-protected, no delete endpoint, CSV/PDF export |
| **System monitoring** | live statistics (24h/7d), top actors + top actions |

---

## [3.17.22] — 2026-05-21 — Fix: local delivery — aliases, distribution groups + SharedMailbox

### Fixed

An audit of local delivery (outbound queue + submission port) uncovered two
structural bugs. Mails to local addresses were in several cases
**silently discarded** without a bounce message or any logging beyond "Mailbox not found".

- **Outbound queue (`smtp-server/outbound/queue.ts`) did not resolve aliases**:
  when sending from the MWA (POST /api/v1/mail/send) the mail went into the BullMQ
  queue. The worker did check the domain (local vs. external) but called
  `storeInboundMessage()` directly with the original address. For an
  e-mail alias (e.g. `vertrieb@stefanwuestner.de` → `info@stefanwuestner.de`)
  or a distribution group, storeInboundMessage could not find the user
  → "Mailbox not found — dropping message".

- **Submission handler (ports 587/465) had the same bug**:
  mail clients (Thunderbird/Apple Mail) sending directly to the submission ports
  also bypassed alias resolution.

- **`storeInboundMessage()` only knew user mailboxes, no SharedMailbox**:
  even after alias resolution: if the alias pointed to a SharedMailbox,
  the mail was discarded because the function only queried `prisma.user.findFirst(...)`.
  Now `prisma.sharedMailbox.findFirst(...)` is queried in parallel as well.

### Changed

- **`expandRecipients()` extracted from `inbound/handler.ts` into `handlers/expand.ts`**
  so that all three entry paths (port 25 inbound, port 587/465 submission,
  BullMQ outbound queue) use the same logic
- **SharedMailbox quota** is now also incremented on local delivery
- **SSE `mail:new` event** is published for a SharedMailbox to all users with
  `FULL_ACCESS` or `READ_ONLY` permission → live update in the
  inbox of everyone with access

---

## [3.17.21] — 2026-05-21 — ESMTP audit: stub-only extensions removed

### Removed

Audit of all ESMTP extensions — everything advertised in EHLO but
**not implemented** was removed (the server would have violated the respective RFC):

- **AUTH CRAM-MD5 (RFC 4954/2195)** — `handleAuth` only recognizes `PLAIN` and `LOGIN`;
  CRAM-MD5 requests were rejected with `504 Unrecognized authentication type`.
  Toggle removed from the BCP, default hard-coded `false`.

- **SMTPUTF8 (RFC 6531)** — UTF-8 in envelope addresses was not handled specially
  (no punycode mapping, no Unicode normalization). If advertised, international
  addresses (e.g. `用户@例子.公司`) would have led to inconsistent behavior.

- **CHUNKING / BDAT (RFC 3030)** — the `BDAT` command was not recognized by the command parser
  and rejected with `500 Command not recognized: BDAT`.

### Verified implementations (remain active)

| Extension | RFC | Status |
|---|---|---|
| STARTTLS | 3207 | ✅ Fully functional, TLS upgrade implemented |
| AUTH PLAIN | 4954 | ✅ `handleAuthPlain` |
| AUTH LOGIN | 4954 | ✅ `handleAuthLoginStart` |
| PIPELINING | 2920 | ✅ Buffer-based parsing (`lineBuffer` loop in `onData`) |
| SIZE | 1870 | ✅ `SIZE=` parameter parsed + `maxSize` check |
| 8BITMIME | 6152 | ✅ Buffer-based (binary encoding) — no 7-bit downgrade |
| ENHANCEDSTATUSCODES | 2034 | ✅ All codes follow the `x.y.z` format |

The DB fields `extAuthCramMd5`, `extSmtputf8`, `extDsn`, `extChunking` remain in the
database for backwards compatibility but are ignored by the server (hard-coded).

---

## [3.17.20] — 2026-05-21 — Remove: DSN advertisement removed (was unused)

### Removed

- **DSN (Delivery Status Notifications, RFC 3461)**: the SMTP server advertised DSN
  in the EHLO response but did NOT implement it:
  - No processing of `NOTIFY=`, `ORCPT=`, `ENVID=`, `RET=` parameters
    in MAIL FROM / RCPT TO (they were silently discarded by the regex)
  - No `multipart/report` + `message/delivery-status` generation on bounce
  - No SUCCESS/FAILURE/DELAY reports

  RFC 3461 forbids advertising a capability without implementing it.
  Removed:
  - `DSN` from the EHLO response (`packages/smtp-server/src/core/session.ts`)
  - `DEFAULT_ESMTP_EXTENSIONS.dsn` now `false` (default hard-coded)
  - Toggle removed from BCP → SMTP & Routing → ESMTP extensions
  - Zod schema for `extDsn` in `routes/admin/smtp-config.ts` removed
  - DB field `extDsn` remains (backwards compatibility, but ignored)

  If DSN is implemented in a later version, the toggle can
  come back — but as long as it is stub-only: gone.

---

## [3.17.19] — 2026-05-21 — Fix: STARTTLS on port 25 with self-signed cert (Outlook 503)

### Fixed

- **Mails from Microsoft Outlook / Exchange are rejected with `503 5.5.1 Bad sequence
  of commands`**: the SMTP server advertised STARTTLS on port 25 with
  a self-signed certificate. Strict MTAs like Microsoft Exchange then initiate
  the TLS handshake, reject the self-signed cert (ECONNRESET) and
  return a 503 error.

  Fix: self-signed detection via `X509Certificate.issuer === subject`. On
  **port 25 (inbound)** STARTTLS is NO longer advertised when the cert is self-signed
  — MTAs then deliver in plain (still RFC-compliant, opportunistic
  TLS is skipped). Submission ports (465/587) continue to advertise STARTTLS
  (own clients accept self-signed with `tls.rejectUnauthorized: false`).

  After installing a CA-signed certificate (e.g. Let's Encrypt via BCP →
  SSL/TLS) STARTTLS on port 25 is activated automatically.

---

## [3.17.18] — 2026-05-21 — Inbox auto-refresh + manual refresh button

### Fixed

- **SSE events never arrived** (the inbox did not refresh itself):
  EventSource cannot send `Authorization` headers, but the api-gateway
  only read bearer tokens from the header → the SSE connection failed with 401.
  Fix: the `requireAuth` middleware now additionally accepts `?token=…` as a
  query parameter (fallback only when no header). The frontend passes the token
  as a query in the EventSource URL.

### Added

- **Live update in the inbox**: as soon as a new mail arrives
  (SSE event `mail:new` from the Redis channel `mail:new`), the folder and
  message lists are reloaded automatically. A subtle toast shows
  sender + subject of the new message.
- **Manual refresh button**: next to "New e-mail" in the folder tree a
  🔄 icon button appears (with tooltip "Refresh folders") that reloads folders +
  messages immediately (`refetchQueries`, no background refetch)
- i18n keys `refresh_folders` / `refresh_done` in DE/EN/ES/IT

---

## [3.17.17] — 2026-05-21 — Fix: Autodiscover URL now uses its own CNAME

### Fixed

- **The Autodiscover URL used the same hostname as all other paths**:
  with `mail.stefanwuestner.de` as hostname, "Derive URLs" also generated
  `http://mail.stefanwuestner.de:8080` for Autodiscover. Outlook however, per the
  **Microsoft Exchange spec**, ALWAYS expects `autodiscover.{primary-domain}` first —
  i.e. `http://autodiscover.stefanwuestner.de:8080`.

  Fix in `routes/admin/servers.ts` `/settings/derive` endpoint:
  - Hostname with ≥ 3 labels (e.g. `mail.stefanwuestner.de`) → strip the first subdomain
    → `autodiscover.stefanwuestner.de`
  - Hostname with 2 labels (e.g. `stefanwuestner.de`) → `autodiscover.stefanwuestner.de`
  - Hostname already starts with `autodiscover.` → unchanged (no double prefix)

  The DNS hint in the BCP (Outlook guide) now uses the same logic:
  correctly shows `autodiscover.{root-domain} CNAME {publicHostname}`

---

## [3.17.16] — 2026-05-21 — Fix: login fails (api-gateway had duplicate auth with the old pepper bug)

### Fixed

- **Login still does not work** despite the fix in v3.17.13: the `api-gateway`
  has its OWN `/auth/login` route (`packages/api-gateway/src/routes/auth.ts`)
  that is NOT proxied to the auth-service. This route had exactly the same
  pepper bug: `bcrypt.compare(password + pepper, hash)` instead of sha256+pepper.
  Thus the login route on port 3000 never verified correctly — on port 3003
  directly (auth-service) it has worked since v3.17.13.

  Fix: `verifyPassword()` and `hashPassword()` from `@coremail/core` used in:
  - `routes/auth.ts` — login + password reset
  - `routes/setup.ts` — initial setup admin user
  - `routes/user.ts` — password change (current + new password)

  All direct bcrypt imports in these files removed.

---

## [3.17.15] — 2026-05-21 — Distribution group fix, token refresh, BCP cleanup

### Fixed

- **Distribution groups "Invalid request"**: the form sent the complete e-mail address
  as free text (e.g. only "verteilung" without @domain) → Zod validation failed.
  The form now works like user management: local part + `@` + domain dropdown side by side.
  The e-mail is assembled from `localPart@domain.name` before it goes to the backend

- **Auto-logout despite active use**: the JWT access token has a 15-minute TTL.
  BCP and MWA stored only the access token, never the refresh token.
  On 401 the user was redirected to the login page immediately.
  Fix in `admin-panel/src/api/client.ts` and `web-client/src/api/client.ts`:
  - The refresh token is stored in localStorage at login
  - Proactive renewal when the token is < 120s from expiry (JWT exp decoded without a library)
  - On 401 a refresh is attempted first + the request is repeated; only on a repeated failure → login

### Added

- **Distribution groups in the MWA recipient autocomplete**: when typing an address in the
  compose window, distribution groups are now suggested as well (via `GET /admin/groups/gal`),
  alongside contacts. Groups are shown with a purple avatar and a `[Gruppe]` badge

### Removed

- **BCP → Resource mailboxes** (`/resources`): page and navigation removed
- **BCP → Organisation** (`/organisation`): page and navigation removed
- Both associated page files deleted (`ResourcesPage.tsx`, `OrganisationPage.tsx`)

---

## [3.17.14] — 2026-05-21 — Mailbox delegation + user active/inactive

### Added

- **Mailbox delegation (delegate access)**: user B can access the mailbox of user A —
  analogous to the Shared Mailbox logic (Exchange delegate access):
  - New Prisma model `MailboxDelegate` with the `SharedMailboxPermType` enum:
    `FULL_ACCESS` / `READ_ONLY` / `SEND_AS` / `SEND_ON_BEHALF`
  - Admin API `GET/POST/DELETE /api/v1/admin/mailboxes/:id/delegates`
  - User API `GET /api/v1/mail/delegated-mailboxes` — returns all mailboxes
    the logged-in user has delegated access to
  - **BCP → Mailboxes** — the expanded row now shows a "Delegate Access" section:
    existing delegations with permission + revoke button,
    form to grant (user dropdown + permission dropdown)

- **User active/inactive** (BCP → Mailboxes): already implemented (the toggle button
  already existed), explicitly verified: `active: false` completely blocks login
  in `authenticateLocal()` and `authenticateAppPassword()`

---

## [3.17.13] — 2026-05-21 — Fix: login fails (password pepper mismatch)

### Fixed

- **Login fails with "Invalid credentials"** although the password is set correctly:
  `auth-service/src/local/index.ts` used its own pepper logic
  (`password + PEPPER` → direct bcrypt.compare) while `@coremail/core`'s `hashPassword()`
  used `sha256(password + PEPPER)` → bcrypt when creating the user.
  The two functions differed → hash and verify never matched.

  Fix: `authenticateLocal()` and `authenticateAppPassword()` now use
  `verifyPassword()` from `@coremail/core` — the same sha256+pepper logic as `hashPassword()`.
  Direct `bcrypt` import in `local/index.ts` removed.

- **App passwords (IMAP/SMTP/POP3)** were affected by the same bug:
  `bcrypt.compare(rawPassword, hash)` instead of `verifyPassword()` → IMAP/SMTP auth with
  an app password also failed. Likewise switched to `verifyPassword()`.

---

## [3.17.12] — 2026-05-21 — BCP complete translation (EN/DE) + version alignment

### Changed

- **All package versions synchronized**: all 17 `packages/*/package.json` still had
  version `3.7.9` — now uniformly `3.17.12`. The `/healthz` endpoint and
  BCP → System information now show the correct version

- **BCP fully translated (English/German)**: all remaining pages now use
  `useT()` and `t()` keys instead of hard-coded German strings:
  - **MailboxesPage** — table, modals (New, Edit, Delete), quota bars, roles
  - **DomainsPage** — DNS records, DKIM key modal, domains table, all actions
  - **QueuesPage** — overview, jobs table, settings, all status labels
  - **DashboardPage** — KPI cards, widget settings, server info, attack events widget
  - **QuarantinePage** — statistics cards, filters, table, detail panel, cleanup modal

- **translations.ts** extended to ~1288 keys (previously ~350):
  new sections for mailboxes, domains, logs, queues, dashboard, quarantine, protection filters

---

## [3.17.11] — 2026-05-21 — Multi-fix: mail body, local delivery, MessageTrace, queue refresh, translations

### Fixed

- **Mail body contains raw MIME headers**: `buildRawMime()` used `newline: 'unix'` (LF only).
  nodemailer's `smtp-connection` does NOT normalize buffer contents in the DATA channel (only strings).
  The receiving MTA could not find the header/body separator `\r\n\r\n` → the entire
  MIME content was displayed as a plain-text body. Fix: `newline: 'crlf'` (RFC 5321-compliant)

- **Mails to local addresses (admin@stefanwuestner.de) do not arrive**: the MWA send endpoint
  (`POST /api/v1/mail/send`) sent ALL recipients into the outbound queue without a local-domain check.
  The queue worker attempted outbound MX delivery — and failed. Fix: the queue worker now checks
  before `relayMessage()` whether the recipient domain is in the local domain table; local
  recipients are written directly into the mailbox via `storeInboundMessage()`

- **MessageTrace never shows results**: the API client automatically adds `/api/v1` as a prefix.
  `MessageTracePage` used `/api/v1/admin/message-trace` as the path → double prefix `/api/v1/api/v1/...`
  → 404. Fix: path corrected to `/admin/message-trace` (without prefix)

- **Queue refresh button does not work**: the page-level button called `invalidateQueries` (background
  refetch, no visual feedback) instead of `refetchQueries` (immediate active refetch).
  Fix: `qc.refetchQueries({ queryKey: ['admin-queue-jobs'] })` and `['admin-queue-stats']`

- **Spam lands in the inbox instead of the Junk folder**: `storeInboundMessage()` looked for the
  folder `'Junk E-Mail'` (Outlook wording) — the folder is called `'Junk'`. Fallback was INBOX.
  Fix: `'Junk'` and `'INBOX'` as the correct folder names

- **MessageTrace: JUNK status was missing** in the status filter and badge display. Added.

### Added

- **Sent Items (Sent folder)**: when sending via the MWA a copy is now automatically stored
  in the sender's Sent folder (was never implemented before). Large mails (>256 KB)
  are stored in MinIO, small ones directly in the DB. Flags: `\\Seen` (marked as already read)

- **MessageTrace auto-load**: now opens with the latest entries — no more manual clicking
  on "Search" required. The reset button clears all filters and shows all entries

- **MAIL_FLOW log in the API gateway**: `POST /api/v1/mail/send` now immediately writes an
  `ACCEPTED` SystemLog entry so that mails sent via the MWA are visible in the
  MessageTrace right away (even before the queue processes them)

---

## [3.17.10] — 2026-05-21 — Fix: copy buttons on DNS records

### Fixed

- **BCP → Domains → DKIM DNS record / BCP → SMTP & Routing → DNS records**: copy buttons
  did not work — `navigator.clipboard` is `undefined` in an HTTP context (non-secure, e.g. DSM
  Application Portal) and throws an error.
  - New shared helper `packages/admin-panel/src/utils/clipboard.ts`:
    `copyToClipboard()` first tries `navigator.clipboard.writeText()` (secure context)
    and automatically falls back to `document.execCommand('copy')` (HTTP compatibility)
  - `DomainsPage.tsx`: both copy buttons (DNS name + TXT value) now use `copyToClipboard()`
    with a correct `await` and `toast.error('Kopieren fehlgeschlagen')` on error
  - `SmtpConfigPage.tsx`: the `CopyBtn` component uses `copyToClipboard()` instead of a direct
    `navigator.clipboard.writeText()`; the error case shows a toast instead of failing silently

---

## [3.17.9] — 2026-05-20 — Fix: loading the DKIM record fails when no key exists

### Fixed

- **BCP → Domains → Show DKIM DNS record**: error "DKIM record could not be loaded"
  when `dkimPrivateKey` in the database was empty (domains created before the automatic
  key generation had an empty entry).
  - Backend `GET /:id/dkim-record` now automatically generates an RSA-2048 key pair
    and stores it when none exists — the error no longer occurs
  - Backend `GET /:id/dns-check` is secured as well (try/catch + `ensureDkimKey`)
  - New endpoint `POST /:id/regenerate-dkim` — explicit regeneration of the key pair

### Added

- **BCP → Domains → DKIM**: button "Regenerate" (appears after the first load)
  — generates a new RSA-2048 key pair with a confirmation dialog (warning: the DNS record
  must be updated afterwards); loading spinner during fetch/generation
- Loading indicator in the DKIM button ("Loading…") during the API call

---

## [3.17.8] — 2026-05-20 — Message trace fix + RFC 822 source

### Fixed

- **Message trace**: the search returned no results because the
  SMTP server never wrote `SystemLog` entries with `category='MAIL_FLOW'`.
  - SMTP inbound (`handlers/message.ts`): now writes `DELIVERED` / `JUNK` after every delivery
  - SMTP inbound (`inbound/handler.ts`): writes `REJECTED` (spam filter rejection) and
    `QUARANTINE` (virus quarantine) with sender, recipient, subject, size, spam score, reason
  - SMTP submission (`submission/handler.ts`): writes `ACCEPTED` after accepting an outgoing mail
  - SMTP outbound (`outbound/queue.ts`): writes `DELIVERED` after successful delivery,
    `DEFERRED` on a temporary error (retry pending), `REJECTED` on final failure
  - All events are searchable and filterable in BCP → Management → Message trace

### Added

- **RFC 822 source view** in the MWA message reader:
  - "View source" now opens a modal dialog instead of a new browser tab
  - Shows the complete RFC 822-compliant MIME format (headers + body) in a monospace font
  - Download button `Download .eml` directly in the source modal
  - Backend `GET /api/v1/mail/messages/:id/raw`: now serves the original RFC 822 document
    from MinIO when available (large messages); the fallback reconstructs `multipart/alternative`
    (text + HTML) correctly per RFC 2045 with a MIME boundary

---

## [3.17.7] — 2026-05-20 — DNS tab: table UI, green/yellow status lights

### Changed

- **BCP → SMTP → DNS records**: complete UI redesign — from cards to a clean table view
  - **● green dot** = record set in DNS (existence check)
  - **● yellow dot** = record not found
  - **● blue dot** = PTR — to be set manually at the hosting provider
  - Legend at the bottom: green / yellow / blue explained
  - Status banner: "X of 5 records set"
  - Each row: name field + value field, each with a copy button
  - The found DNS value is shown in green (set) or yellow (deviating)
- **Backend `dns-check`**: the MX check now uses a pure existence check (`records.length > 0`);
  the Autodiscover check tests whether a CNAME exists at all (no more hostname comparison)

---

## [3.17.6] — 2026-05-20 — DNS tab in SMTP configuration

### Added

- **BCP → SMTP configuration → DNS records**: a new tab shows all DNS records required
  for mail operation — MX, SPF, DKIM, DMARC, Autodiscover, PTR.
  - Domain selection via pill tabs (with multiple domains)
  - Each record shows DNS type, expected value, copy button
  - **Live DNS check** via `GET /api/v1/admin/domains/:id/dns-check` — green checkmark when
    the record is set, yellow warning symbol when missing; shows the currently set value from DNS
  - Status summary: "X of 5 records correct"
  - Button "Re-check DNS" for manual refresh
  - PTR card with a note about setting it at the hosting provider
- **Backend** `GET /api/v1/admin/domains/:id/dns-check`: checks MX, SPF (TXT), DKIM (TXT),
  DMARC (TXT), Autodiscover (CNAME) in parallel via Node.js `dns/promises`; generates for each an
  expected value and the actually found value

---

## [3.17.5] — 2026-05-20 — Fix: BullMQ queue name contains no colon

### Fixed

- **Sending fails ("Message could not be enqueued")**:
  BullMQ v5 forbids colons (`:`) in queue names. The outbound queue in
  `api-gateway/routes/mail.ts` was called `'smtp:outbound'` — BullMQ immediately threw
  `Error: Queue name cannot contain :` when creating the queue object.
  Fix: queue name changed to `'smtp-outbound'` (as already correct in the `smtp-server`).

---

## [3.17.4] — 2026-05-20 — Fix: BullMQ connection in api-gateway (NetworkError on send)

### Fixed

- **Sending fails (NetworkError)**: the outbound queue in `api-gateway/routes/mail.ts` used
  `getRedisClient()` (shared, `maxRetriesPerRequest: 3`) instead of `createBullMqConnection()` (`null`).
  BullMQ v5 requires `maxRetriesPerRequest: null` for internal blocking commands — with the wrong
  connection `queue.add()` crashed the api-gateway process (Node.js 22: `--unhandled-rejections=throw`),
  which appeared in the browser as `NetworkError when attempting to fetch resource`.
  Fix: `createBullMqConnection()` used correctly as in `smtp-server/outbound/queue.ts`.
- **Additionally**: `queue.add()` in try/catch — on real queue errors the server now returns
  `500 { error: '...' }` instead of dropping the connection.

---

## [3.17.3] — 2026-05-20 — Service TLS binding: SMTP/IMAP/POP3 real certificates, HTTPS proxy only MWA+BCP

### Added

- **Protocol TLS binding**: when a certificate is assigned to the services `SMTP`, `IMAP` or `POP3`,
  `certPem`/`keyPem` are automatically written to `ServerSettings.tlsCert/tlsKey` and all three
  protocol servers reload the certificate immediately via `CHANNEL_SETTINGS_RELOAD` — no container restart needed.
  Applies to: Let's Encrypt (after issuance), upload, self-signed, PUT services change.
- **`applyProtocolCert()` helper** in `certificates.ts` — central binding point for SMTP/IMAP/POP3 TLS
- **BCP: service colors** in the certificate table — blue: MWA/BCP (HTTPS proxy), green: SMTP/IMAP/POP3 (protocol TLS), gray: EWS/CALDAV/AUTODISCOVER
- **BCP: "Protocol TLS" row** in the detail view — shows which protocol services are actively bound
- **BCP: ServiceSelector hint** — explains MWA+BCP = HTTPS proxy vs. SMTP/IMAP/POP3 = protocol TLS

### Changed

- **`activate-https` guard**: the HTTPS proxy can only be activated when the certificate has both `MWA` and
  `BCP` in the `services` array — returns a clear 400 error message when services are missing
- **BCP: LockOpen button** now appears only for certificates with MWA+BCP (previously for all ACTIVE/EXPIRING)
- **BCP: gray status banner** now explicitly explains "assign MWA + BCP" instead of just "click the lock"
- **BCP: HTTPS (port 443) detail row** shows three states: Active / Ready (MWA+BCP) / MWA+BCP required

---

## [3.17.2] — 2026-05-20 — HTTPS proxy: explicitly disableable for an external reverse proxy

### Added

- **`HTTPS_PROXY_ENABLED=false`** — new env switch disables the integrated TLS proxy completely.
  Set it when an external reverse proxy (Traefik, Caddy, nginx, DSM Application Portal …) terminates TLS.
  Then port `443:443` can be removed / commented out in `docker-compose.yml`.
- **`GET /api/v1/admin/certificates/tls-proxy-info`** — new admin endpoint returns `{ enabled, port, activeCert }`
- **`docker-compose.synology.yml`**: `HTTPS_PROXY_ENABLED: "false"` preset (DSM handles TLS)
- **`.env.example`**: section for `HTTPS_PROXY_ENABLED` + `HTTPS_PORT` added

### Changed

- **BCP certificates — three-state status banner**:
  - 🟡 Yellow: proxy disabled (`HTTPS_PROXY_ENABLED=false`) — external reverse proxy active
  - 🟢 Green: proxy active + certificate selected — shows port + domain
  - ⬜ Gray: proxy ready, but no certificate activated yet — with a hint about `HTTPS_PROXY_ENABLED=false`
- **`docker-compose.yml`**: `HTTPS_PROXY_ENABLED` variable and comment "OPTION A / OPTION B" for a clear choice
- **`tls-proxy.ts`**: `isTlsProxyEnabled()` exported; startup log when the proxy is disabled

---

## [3.17.0] — 2026-05-20 — Integrated HTTPS reverse proxy (TLS termination)

### Added

- **Integrated HTTPS reverse proxy (port 443)**  
  – CoreMail can now terminate HTTPS directly without an external reverse proxy (Traefik, Caddy, nginx)  
  – After issuing a Let's Encrypt or own certificate in BCP → SSL/TLS: the button
    **"Activate as HTTPS"** (lock icon) starts the TLS proxy immediately via hot reload  
  – Exactly one certificate can be active at a time; hot swap without container restart via
    the Redis channel `coremail:tls:reload`  
  – Deactivation by clicking the green lock icon again  
  – `docker-compose.yml`: port `443:443` added  
- **BCP certificates — HTTPS status banner**  
  – A green banner shows the active certificate + domain; a gray banner when no HTTPS is active  
  – The detail row (expanded) shows "HTTPS (port 443): Active / Inactive" with a lock icon  
- **`packages/api-gateway/src/tls-proxy.ts`** — new module for the HTTPS server lifecycle
  (start, graceful stop 5 s, hot reload via Redis subscription)  
- **Prisma schema**: `Certificate.isActiveHttps Boolean @default(false)`

### Changed

- **BCP certificates**: the actions column shows a `LockOpen` icon (gray) for activatable certs
  and a `Lock` icon (green) for the active HTTPS certificate

---

## [3.16.9] — 2026-05-20 — Bugfix: Let's Encrypt port 80 + better UI feedback

### Fixed

- **docker-compose.yml**: port `80:3000` added — the ACME HTTP-01 challenge is now
  reachable by Let's Encrypt (previously the process hung until timeout)
- **BCP certificates**: visible status banner for PENDING (blue) and ERROR (red)
  directly above the table — no more silent "nothing happens"
- **BCP certificates**: the error message in the expand panel now has a title + readable
  `pre` block instead of raw mono text
- **certificates.ts**: log hint on ACME challenge: "Port 80 must be reachable"

---

## [3.16.8] — 2026-05-20 — Bugfix: MessageList panel cannot be resized

### Fixed

- **MWA Mail — resizable panel (MessageList)**: `w-80 shrink-0` in the main return overrode
  the `style={{ width }}` of the parent div → the panel was not resizable and only showed the
  empty message counter. Corrected to `w-full h-full overflow-hidden`.

---

## [3.16.7] — 2026-05-20 — BCP: info window updated to v3.16.6

### Changed

- **BCP info window** — VERSION updated to 3.16.6, BUILD_DATE 2026-05-20  
  – 6 new HIGHLIGHTS entries (3.16.6 → 3.14.0) with complete release notes  
  – Thus correctly shows all releases since 3.13.12

---

## [3.16.6] — 2026-05-20 — MWA: recipient autocomplete, resizable panels, view settings

### Added

- **MWA Compose — recipient autocomplete (To / CC / BCC)**  
  – While typing in the To, CC and BCC fields, matching contacts from the address book are suggested (from 1 character, 220 ms debounce)  
  – Dropdown with name, e-mail address and company; keyboard navigation (↑/↓/Enter/Tab/Escape)  
  – Multiple recipients separated by comma; a selection replaces the current fragment and places the cursor after the new comma  
  – Search via `GET /api/v1/contacts?q=...` (server-side, max. 8 hits shown)
- **MWA Mail — resizable panels**  
  – The dividers between folder tree ↔ message list ↔ reading pane can be resized with the mouse  
  – Widths are stored in `localStorage` under `coremail:panel-widths` and restored on the next load  
  – Default widths: folder tree 208 px (w-52), message list 320 px (w-80); minima/maxima prevent overlaps
- **Settings → View** (new section)  
  – **Reading pane**: Right (default), Bottom (message list + reader split vertically) or Off (list only, no reader)  
  – **Message density**: Compact / Normal / Comfortable — row height of the message list  
  – **Group conversations**: toggle for conversation-based bundling (preparation)  
  – All settings persistent via a Zustand store (`coremail-ui-prefs` in localStorage)

---

## [3.16.1] — 2026-05-20 — Task reminders: calendar sync + real-time popup

### Added

- **MWA Tasks — reminder with calendar integration**  
  – When creating or editing a task with a reminder set (date + time), a calendar event is created automatically (`🔔 Erinnerung: <subject>`, 30 min. duration) via `POST /calendar/events` — best effort, no task error on a calendar error  
  – Applies to both `createMutation` (new task) and `updateMutation` (edit modal via double-click)
- **MWA Tasks — reminder popup at the set time**  
  – The 60-second interval check `checkDueDates()` now additionally checks `task.reminder`: as soon as the timestamp is ≤ `now`, a `toast` "🔔 Reminder: <subject>" appears (12 sec. display duration)  
  – A dedicated `notifiedReminderIds` ref prevents duplicate popups per session (independent of the due-date notification)
- **MWA Tasks — reminder field visually highlighted**  
  – The bell icon in the form is now amber (`text-amber-400`) instead of gray; the tooltip explains the dual function (calendar + popup)

---
## [3.16.0] — 2026-05-20 — MWA/BCP feature update (tasks, contacts, search, fonts, dashboard)

### Added

- **MWA Tasks — editing via double-click**  
  – Double-clicking a task opens a modal with pre-filled fields (subject, notes, priority, due date, reminder)  
  – A separate `updateMutation` writes complete changes via `PUT /tasks/:id`
- **MWA Tasks → calendar synchronization**  
  – Newly created tasks with a due date are automatically entered as a calendar event (`POST /calendar/events`)  
  – Invalidates the `calendar-events` query; errors are swallowed best-effort (no task-create failure)
- **MWA Tasks — due-date popup**  
  – A `useEffect` checks every 60 seconds whether tasks are due today  
  – Shows a `toast` with the task title; each task is notified only once per session (via `useRef<Set>`)
- **MWA Calendar — tasks as events**  
  – Tasks with a `dueDate` appear in FullCalendar as all-day events (amber `#f59e0b` / gray for completed)  
  – Clicking a task event shows a toast instead of the delete dialog; prefix `📋` / `✓` in the title
- **MWA Contacts — Outlook-compatible fields**  
  – New fields: `email2`, `mobile`, `department`, `jobTitle`, `notes`  
  – Edit form in sections: "General" (2-column grid), "E-mail & phone" (2-column grid), "Notes" (textarea)  
  – The detail view shows all filled fields with icon + label; e-mails/phone clickable  
  – The contact list shows `jobTitle` as the second line (instead of only the e-mail)  
  – `Contact` interface in `api/types.ts` extended with all new fields
- **MWA e-mail search — scope selection + typeahead**  
  – New search bar above the filter list in `MessageList`  
  – Scope switch: "Folder" (client-side filtering) / "All" (API query `/mail/folders/search?q=...`)  
  – Typeahead: from 2 characters of input, up to 5 hits from the loaded folder are shown as suggestions  
  – Clear button (`×`) empties the search; the `All` scope disables the local filter
- **MWA e-mail compose — font selection**  
  – New Tiptap extension `@tiptap/extension-font-family` (v2.27.2, matches the existing Tiptap v2 stack)  
  – Dropdown with 8 fonts: Default, Arial, Calibri, Georgia, Times New Roman, Courier New, Verdana, Trebuchet MS  
  – Dropdown label and entries are each rendered in the corresponding font  
  – Positioned between block type and bold/italic in the formatting bar
- **BCP Dashboard — all widgets draggable**  
  – All 8 previously missing widgets (`queue-status`, `mails-chart`, `storage-ranking`, `domains-chart`, `recent-errors`, `recent-audit`, `recent-logins`, `system-strip`) are now wrapped in `<DraggableCard>`  
  – IIFE slot pattern for queue+mails, storage+domains and errors+audit+attack (consistent with the KPI and server sections)  
  – `recent-logins` and `system-strip` as individual draggable units

### Fixed

- **DNS hardening startup check**: integrity check targets switched from `example.com` (IANA IP no longer valid, now Cloudflare CDN) to stable infra records: `one.one.one.one → 1.1.1.1` and `dns.google → 8.8.8.8`

---

## [3.15.0] — 2026-05-20 — Security+ (password reset, attack detection, DNS hardening)

### Added

- **Password self-reset (OWASP A07-compliant)**  
  – `POST /auth/forgot-password`: rate-limited (3 req/h per IP + e-mail), SHA-256 hashing, no user enumeration (always `{ok:true}`)  
  – `POST /auth/reset-password`: atomic transaction (token marked + password set + all sessions deleted)  
  – `GET /auth/reset-password/verify?token=...`: quick check for the frontend  
  – Token TTL: 15 min; SHA-256 hash stored in the DB (plaintext never persisted)  
  – Admin toggle in the BCP: Settings → Security → "Password self-reset" (enables/disables the flow globally)  
  – MWA login page: "Forgot password?" link (only visible when the feature is active)  
  – MWA: `ForgotPasswordPage` + `ResetPasswordPage` with password strength indicator
- **Attack detection live dashboard (BCP)**  
  – New Prisma model `AttackEvent` (ip, type, detail, service, timestamp) — persistent in PostgreSQL  
  – Redis channel `admin:attack` → SSE broadcast to all admin connections in real time  
  – BCP dashboard widget "Attack detection (live)": counters for the last 1h/24h, top IPs, top attack types, last 10 events, "UNDER ATTACK" banner at ≥10 events/h  
  – Admin API `GET /api/v1/admin/security/attacks` (paginated/filterable), `/summary`, `DELETE` (purge before date)  
  – The `ip-limiter` in SMTP publishes an attack event on every auth failure and ban
- **DNS poisoning protection (MITRE T1584.002)**  
  – New module `security-filter/src/dns-hardened.ts`: enforces trusted resolvers (8.8.8.8, 1.1.1.1, 9.9.9.9) instead of system/container DNS  
  – Cross-resolver validation: two independent resolvers are compared; divergence → warning in the log  
  – Startup integrity check: known stable A records (example.com) are validated against hard-coded expectations  
  – The DNSBL module now uses `resolveHardened()` instead of `dns.promises.resolve4()`  
  – Admin API `GET /api/v1/admin/security/dns-check` → real-time integrity report via the security-filter proxy  
  – Configurable via `TRUSTED_DNS_SERVERS` (comma-separated IP list)
- **Per-user inactivity timeout (MWA)**  
  – Users can set a personal timeout (minutes) under MWA → Settings → General → "Automatic logout"  
  – The own setting overrides the global admin default; 0 = disabled; null = inherit global  
  – Backend: `GET/PUT /api/v1/user/preferences` returns/stores `inactivityTimeoutMinutes`  
  – Prisma model `UserSettings.inactivityTimeoutMinutes (Int?)` added  
  – The MWA `useInactivityLogout` hook loads both settings in parallel and respects the user override

### Security

- **Attack events** are stored persistently in the `AttackEvent` table (forensics/audit trail)  
- **Redis pub/sub** for attack events decouples the SMTP lockout from the dashboard without performance impact  
- **Password reset tokens**: a simple rate limiter prevents token flooding; SHA-256 protects the DB from a plaintext leak  
- **The SSE endpoint** checks the admin role before attack events are broadcast (`ORGANIZATION_MANAGEMENT` / `SERVER_MANAGEMENT` / …)

---

## [3.14.0] — 2026-05-20 — Security hardening (pentest evaluation)

### Security

- **SMTP — brute-force lockout (OWASP A07 / MITRE T1110)**: new `ip-limiter` module  
  – Redis-backed: after 5 failed auth attempts in 5 min the IP is blocked for 10 min (421)  
  – Configurable via env: `SMTP_AUTH_FAIL_THRESHOLD`, `SMTP_AUTH_WINDOW_S`, `SMTP_AUTH_BAN_S`  
  – A successful login clears the failure counter
- **SMTP — per-IP connection limit (MITRE T1499)**: max. 10 concurrent connections + max. 30 new connections/min per IP (sliding window)  
  – Configurable via `SMTP_MAX_CONNS_PER_IP`, `SMTP_NEW_CONN_PER_MIN`  
  – Private/loopback IPs exempt
- **SMTP — VRFY command disabled**: now responds with `502 5.5.1 VRFY not supported` instead of the ambiguous `252` (prevents user enumeration)
- **MinIO console (port 9001) now bound to localhost only**: changed to `127.0.0.1:9001:9001` in both `docker-compose` files — no more WAN access possible
- **Container resource limits** added in `docker-compose.yml`: `cpus: 2`, `memory: 2g` (via `deploy.resources.limits`) — DoS protection at host level
- **SMTP auth IP pass-through**: the client IP is now passed to `verifyCredentials` so brute-force counters count correctly per IP

### Fixed

- **SMTP banner** no longer reveals an internal hostname misconfiguration (`mail.localhost`) — the hostname is always read from the DB `publicHostname`, env fallback as seed

---

## [3.13.12] — 2026-05-20 — Tasks error, duplicate folders, SharedMailbox language

### Fixed

- **Tasks — "Invalid" error on creation**: the frontend sent `title`, the backend expects `subject` (Prisma schema field name). `Task` interface in `types.ts` corrected to `subject`/`body`; `TasksPage` now sends the correct fields
- **Inbox — duplicate folders "Aufgaben"/"Task"**: `Notes` and `Tasks` were wrongly provisioned as regular mail folders. Both removed from `DEFAULT_FOLDERS` in `provision-mailbox.ts` (they are separate data models). `FolderTree` filters them out for existing users
- **SharedMailbox — wrong language**: folder labels were hard-coded mixed English/German; now via `useT()` in the language set by the user (DE/EN/ES/IT)
- **SharedMailbox — date format**: `fmtDate()` now uses the user's language instead of a hard `'de-DE'`
- **SharedMailbox — folder order**: the folder sidebar now follows the same order as the normal mailbox (`INBOX → Drafts → Sent → Trash → Junk → Archive`, then custom folders) instead of only `sortOrder + displayName`

### Changed

- **Tasks page built out**: extended form with priority, due date, reminder, note text field; expandable body display per task; overdue marking in red; delete only with confirmation
- **SharedMailbox sidebar style** adjusted: active accent bar on the left, hover effects and icon sizes identical to the normal FolderTree sidebar

---

## [3.13.11] — 2026-05-20 — Automatic logout on inactivity

### Added

- **New security field "Automatic logout on inactivity"** in the global settings (security policies section)
  - Value in minutes: `0` = disabled, `1`–`1440` minutes configurable
  - Default: 30 minutes
  - Quick buttons: Disabled / 5 / 10 / 15 / 30 / 60 / 120 min
  - Warning below 5 minutes (could annoy users)
- **`GET /api/v1/admin/settings/public`** — new public endpoint (no auth), returns `orgName`, `logoUrl`, `language`, `inactivityTimeoutMinutes`, `maintenanceMode`, `maintenanceMessage` — retrievable by MWA/BCP before login
- **`useInactivityLogout` hook** — implements browser-side inactivity detection in BCP and MWA:
  - Listens to `mousemove`, `mousedown`, `keydown`, `touchstart`, `scroll`, `visibilitychange`
  - The timer is reset on every activity
  - 60-second advance warning via toast before the logout is triggered
  - Automatic redirect to the login page after expiry

### Changed

- The session timeout field in the settings renamed to "Session timeout (token)" and the hint text clarified — makes the difference from the inactivity timeout clear

---

## [3.13.10] — 2026-05-20 — Bugfix: applying a template failed (retentionDays validation)

### Fixed

- **Critical bugfix** — the "From template" button on the retention policies page failed with `retentionDays must be at least 1`
- Cause: in the tag-based Exchange 2019 system (DPT/RPT/personal tags) the **policy** itself holds no period — the tags do. The frontend therefore correctly sends `retentionDays: 0` when creating the policy
- The backend validation in `POST /admin/compliance/retention` and `PUT /admin/compliance/retention/:id` was too strict (`< 1` instead of `< 0`) and blocked this
- Fix: `0` is now allowed (meaning: the period is controlled by the attached tags); negative values are still rejected
- All 8 template scenarios (Trash, Junk, Inbox, Sent, Drafts, Compliance 7 years, Default 3 years, 5 years recoverable) can now be created with a click

---

## [3.13.9] — 2026-05-20 — Retention policies from templates + MFA buttons removed

### Removed — main view decluttered

- **"MFA now" button** removed from the header of the `RetentionPage` — the worker runs automatically in a 24h work cycle, no admin needs to trigger it manually
- **"MFA history" button** removed + `RunsModal` component deleted completely — internal worker telemetry does not belong in the compliance configuration
- `runNow` mutation and `ManagedFolderRun` interface removed from the component state

### Added — 1-click templates

- **"From template" button** next to "New policy" (only in the Policies tab)
- **`TemplatePickerModal`** with 8 ready-made scenarios:

| Scenario | Tag type · Folder · Action · Period |
|---|---|
| Empty Trash after 30 days | RPT · DELETED_ITEMS · DELETE_AND_ALLOW_RECOVERY · 30 d |
| Permanently delete Junk after 14 days | RPT · JUNK_EMAIL · PERMANENTLY_DELETE · 14 d |
| Archive Inbox after 1 year | RPT · INBOX · MOVE_TO_ARCHIVE · 365 d |
| Archive Sent after 2 years | RPT · SENT_ITEMS · MOVE_TO_ARCHIVE · 730 d |
| Delete Drafts after 90 days | RPT · DRAFTS · DELETE_AND_ALLOW_RECOVERY · 90 d |
| Compliance 7 years (marking) | DPT · ALL_OTHER · MARK_AS_PAST_RETENTION_LIMIT · 2555 d |
| Default 3 years → archive | DPT · ALL_OTHER · MOVE_TO_ARCHIVE · 1095 d |
| 5 years recoverable delete | DPT · ALL_OTHER · DELETE_AND_ALLOW_RECOVERY · 1825 d |

- Clicking a template triggers **atomically** (frontend orchestration):
  1. `POST /admin/compliance/retention/tags` — create tag
  2. `POST /admin/compliance/retention` — create policy (legacy fields empty)
  3. `POST /admin/compliance/retention/:policyId/tags/:tagId` — attach tag to policy
  4. `POST /admin/compliance/retention/:policyId/assignments` — GLOBAL assignment
- A productive rule is thereby ready for use in **one click**
- Own rules "from scratch" remain available via the "New policy" button

### Changed — page header

- Subtitle rephrased: "Define when e-mails are automatically archived or deleted — via template or your own rule" (previously: a technical description with "Managed Folder Assistant · Recoverable Items")

---

## [3.13.8] — 2026-05-19 — Shared Mailboxes with full folder structure + user folder CRUD

### Added — Provisioning

- **`ensureSharedMailboxProvisioned(sharedMailboxId)`** in `packages/api-gateway/src/lib/provision-mailbox.ts`
  - Idempotent — analogous to the user variant
  - Creates the `Mailbox` record (via `sharedBoxId`) and the 8 default folders: `INBOX`, `Drafts`, `Sent`, `Trash`, `Junk`, `Archive`, `Notes`, `Tasks`
  - Backfill: missing standard folders are added for existing mailboxes
- **Auto-call** in `POST /admin/shared-mailboxes` — new mailboxes immediately have the full folder structure
- **Repair endpoint** `POST /admin/shared-mailboxes/:id/provision` — backfill for existing ones

### Added — Folder CRUD for Shared Mailboxes (FULL_ACCESS only)

In `packages/api-gateway/src/routes/user.ts`:

- `POST   /user/shared-mailboxes/:id/folders` — create folder (with optional `parentId` for subfolders)
- `PATCH  /user/shared-mailboxes/:id/folders/:folderId` — rename, move (`parentId`), color, favorite, sort order
- `DELETE /user/shared-mailboxes/:id/folders/:folderId` — delete (with children check)
- `POST   /user/shared-mailboxes/:id/folders/:folderId/empty` — delete all messages in the folder
- Cycle check on reparenting — a folder cannot be moved into its own subtree
- **Standard folders protected**: `INBOX`, `Drafts`, `Sent`, `Trash`, `Junk`, `Outbox` cannot be renamed, moved or deleted (403)

### Added — Web client UI (`SharedMailboxPage.tsx`)

- **"+ New folder" inline input** at the top of the folder sidebar (FULL_ACCESS only), dashed accent border
- **Hover actions** per user folder on the right: pencil (rename) + trash can (delete)
- **Inline rename** with Enter/Esc, OK button, validation state
- Standard folders show no action icons (frontend + backend agree)
- Delete confirm dialog with data-loss warning
- `READ_ONLY` users see neither "New folder" nor action icons

---

## [3.13.7] — 2026-05-19 — Transport rules from templates (Exchange 2019 templates)

### Added

- **"From template" button** on `TransportRulesPage` (next to "New rule")
- **`TemplatePickerModal`** with 9 ready-made rule templates, filterable in 4 categories
- Per template: icon + description + conditions/actions pre-filled
- Clicking a template → `RuleModal` opens pre-filled; the admin adjusts placeholders (`@DEINE-DOMAIN.com`) and saves

### Included templates

| Category | Template | Conditions → Actions |
|---|---|---|
| **Labeling** | [EXTERN] marker in the subject | `from notContains @firma.com` → subject prefix |
| **Compliance** | Disclaimer for outgoing mails | `to notContains @firma.com` → addDisclaimer |
| **Compliance** | BCC to compliance mailbox | `to contains @firma.com` → addRecipient compliance@ |
| **Compliance** | Credit card detection (PCI-DSS) | `body regex \b\d{13,16}\b` → quarantine |
| **Security** | Quarantine spam score > 5 | `spamScore > 5` → quarantine |
| **Security** | Malware extensions | `subject regex \.(exe|bat|scr|cmd|vbs|js|jar|hta)\b` → quarantine |
| **Security** | CEO phishing protection | `from regex (ceo|geschäftsführer|chef).*@(?!firma)` → subject prefix "⚠ MÖGLICHES PHISHING" |
| **Governance** | Size limit 25 MB | `size > 26214400` → reject |
| **Governance** | DLP marker for external attachments | `hasAttachment is true` + `to notContains @firma.com` → addHeader X-Coremail-External-Attachment |

### Changed — `RuleModal`

- New optional `initial` prop: takes a template rule structure and pre-fills `name`, `description`, `priority`, `conditions`, `actions`
- With the `rule` prop (edit mode) `initial` is ignored
- Own rules "from scratch" remain available via the "New rule" button (without template)

---


> Older releases (v3.13.6 and earlier back to v0.1) are available via `git log CHANGELOG.md`
> or the [GitHub releases](https://github.com/MAGPEEK/CoreMail/releases).
