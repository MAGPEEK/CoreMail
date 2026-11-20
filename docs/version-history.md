# Version history

> 🇩🇪 [Deutsche Fassung](version-history.de.md)

Highlights of each CoreMail release, newest first. Every change is listed in the [changelog](../CHANGELOG.md); the release notes are in [releases/](releases/).

## Recent releases

- **v10.2.0** — A new webmail shell (one simplified toolbar, floating panes, background pictures, favourites, date groups, mail templates), search suggestions from the whole mailbox, growing tables in mail, calendar events drawn by "show as", retention policy fixes and message trace details in the BCP ([release notes](releases/v10.2.0.md))
- **v10.1.0** — A calmer compose area (raised card, Send as the only accent split button top left, formatting bar at the bottom)
- **v10.0.0** — **room and equipment resources are removed**; use a shared mailbox or a shared calendar instead. Room data is deleted at start after a mandatory backup — **breaking, read the [upgrade notes](releases/v10.0.0.md) before upgrading**.
- **v9.5.1** — Fix for a false MAPI HTTPS warning ([release notes](releases/v9.5.1.md)).
- **v9.5.0** — ActiveSync phones sync calendar, tasks, notes and contacts both ways, a CalDAV task list for Apple Reminders / Thunderbird / DAVx⁵, contacts with several addresses and phone numbers plus contact groups, folder permissions with roles (also as IMAP ACL), admin roles limited to domains, cached mode for desktop clients over MAPI, profile photos, an accessible and responsive webmail and DMARC alignment by the Public Suffix List ([release notes](releases/v9.5.0.md)).
- **v9.4.0** — Desktop mail clients connect again via **MAPI over HTTP** (opt-in, online mode), protocol access switches per server, domain and mailbox, ActiveSync 12.1/14.0/14.1, realtime push with an installable webmail (PWA, Web Push), a redesigned webmail (inline compose with draft tabs, calendar with series exceptions and scheduling assistant, tasks and follow-up flags), mailbox management (auto-mapping, sent copies, mail flow), roaming personal settings, webmail policies, sender lists and spoofing settings, and TLS 1.0/1.1 for old clients as an opt-in ([release notes](releases/v9.4.0.md)).
- **v9.3.0** — Branding (name, colours, logo, login page), Let's Encrypt that works behind NAT with mail certificates applied instantly, shared and delegated mailboxes in the webmail folder pane, backup restore from stored archives plus a recommended backup schedule ([release notes](releases/v9.3.0.md)).
- **v9.2.0** — Accessible dark mode (WCAG 2.2 AA) in webmail and admin panel, every BCP function reviewed and fixed, ClamAV settings with EICAR self-test ([release notes](releases/v9.2.0.md)).
- **v9.1.0** — Shared and delegated mailboxes in IMAP clients (`Shared/`, `Other Users/`), full RFC 5256 REFERENCES threading, recover deleted items in shared mailboxes, Helm chart tested on a real cluster ([release notes](releases/v9.1.0.md)).
- **v9.0.0** — OWASP security hardening (shared lockout, HttpOnly refresh cookies, DMARC enforcement, ReDoS/DoS limits, encrypted backups, fail-closed schema sync); extended mail logic (DSN, CHUNKING, SMTPUTF8, QRESYNC, SORT/THREAD, quota levels, recover deleted items, server drafts with undo send); Thunderbird/Apple auto setup; Docker Compose variants minimal/standard/full; Helm chart 2.0.0; verified end to end in both storage modes ([docs/e2e.md](e2e.md)). **Breaking — read the [upgrade notes](releases/v9.0.0.md) before upgrading**

## Notes

**Note on desktop clients** (since v9.4.0): desktop mail clients can connect via **MAPI over HTTP** — opt-in (protocol switch `mapi`, **off by default**), online and **cached mode** (cached mode since v9.5.0), Basic authentication over HTTPS (no NTLM; an app password when MFA is enabled), setup guide in [docs/mapi.md](mapi.md). EWS stays removed. Without it, set the client up as an **IMAP** account, with calendar + contacts via CalDAV/CardDAV (a CalDAV synchronizer plugin; or Apple Calendar, Thunderbird Lightning).

**Note (since v5.6.0)**: The OAuth2 authorization server under `/oauth2/*` has been removed entirely — in practice, XOAUTH2 has no mainstream client UI support for third-party servers. JWT is back on HS256 (`JWT_SECRET`). REST API + MWA/BCP use session JWTs via `/auth/login`; mail clients use app passwords.

**Note (since v5.6.1)**: Distribution groups have been removed — modern teams use Shared Mailboxes (with aliases) for team mailboxes, or external listserv tools (Mailman, listmonk) for pure outbound distribution lists.

## Highlights by release line

### v10.x

| Version | Highlights |
|---------|-----------|
| **v10.2.0** | **New webmail shell.** One simplified toolbar for mail, calendar and contacts, floating panes over optional background pictures, favourites and date groups, mail templates, search suggestions from the whole mailbox (trigram index), table size picker and "+" handles to grow tables, calendar events drawn by "show as" (out of office purple), scheduling assistant removed, retention policy fixes, message trace detail panel (processing steps, MX route, hops) — [release notes](releases/v10.2.0.md) |
| **v10.1.0** | **New compose area.** Raised card, "Senden" as the only accent split button top left (send later, importance, options), quiet icons, address rows with avatar chips, text limited to 72 characters per line, formatting bar at the bottom (can be hidden, remembered). |
| **v10.0.0** | **Room and equipment resources removed** (Breaking). Room and equipment mailboxes, their bookings and their own mailboxes are deleted at start after a mandatory pg_dump to `/data/backups` (retired tables only; any other data loss is still refused); mail to former room addresses gets `550 5.1.1`; room attendees are invited like people; `/admin/resources`, EMS `resource-mailboxes` and `/calendar/rooms` answer 404. Use a shared mailbox or a shared calendar instead. Helm chart 3.0.0 (`app.schemaSync.backupClaim` or `skipBackup` for the rollout when rooms exist). |

### v9.x — Security Hardening & Mail Logic

| Version | Highlights |
|---------|-----------|
| **v9.5.1** | **Bug fix.** "Protocols & services" no longer shows a false MAPI HTTPS warning when port 443 serves a valid certificate by SNI; clearer label for the optional TLS 1.0/1.1 switch. |
| **v9.5.0** | **ActiveSync calendar / tasks / notes / contacts, folder permissions, domain-scoped admins, MAPI cached mode.** ActiveSync Calendar, Tasks, Notes and Contacts classes both ways (EAS 12.1–14.1); CalDAV task list (VTODO); contacts with several values and contact groups (CardDAV), note categories; per-folder permissions (webmail, BCP, REST, IMAP ACL); admin roles limited to domains with redaction of other domains; MAPI cached mode (ICS download / upload, client IDs kept, conflict detection); profile photos; rooms answer mailed invitations, recurring room invitations checked per occurrence; accessible and responsive webmail; BCP edit side panel, IDN display; backups with contact groups, restore keeps the received date; DMARC alignment by the Public Suffix List. Helm chart 2.3.0. |
| **v9.4.0** | **Redesigned webmail, MAPI over HTTP, protocol access switches.** MAPI over HTTP for desktop mail clients (opt-in, online mode, Basic over TLS); protocol access switches per server / domain / mailbox; ActiveSync 12.1 / 14.0 / 14.1; realtime events (IMAP IDLE, JMAP push, webmail live refresh, Web Push, installable webmail); webmail with app rail, command bar, inline compose with draft tabs, slim compose (formatting bar, name check, accessibility check, sensitivity); calendar (series exceptions, scheduling assistant, rooms, show-as, reminders), tasks and follow-up flags; mailbox management (auto-mapping, sent copies, mail flow, access audit); roaming personal settings; webmail policies; sender lists, spoofing and API rate-limit settings; TLS 1.0/1.1 for old clients (opt-in) and device relay; certificate private keys encrypted at rest. The webmail / REST recipient limit now follows the SMTP maximum recipients (default 100). |
| **v9.3.0** | Branding (product name, colours, logos, favicon, login page; SVG sanitiser); Let's Encrypt fixed (no hairpin NAT needed, real error reasons, pre-flight, staging) and mail-protocol certificates applied on assignment with startup repair and per-port served-certificate view; shared/delegated mailboxes in the webmail folder pane; backup restore from stored archives, system backup (pg_dump), recommended schedules; scanner detection hides rspamd/ClamAV settings when not deployed. 2,462 tests; e2e MinIO 166/166, filesystem 153/153. |
| **v9.2.0** | WCAG 2.2 AA colour tokens for light/dark mode in webmail and BCP (theme-guard test); every BCP function reviewed live and fixed (SMTP connection limits applied, last-admin guard, backup retention, partial settings saves); ClamAV policy settings, status and EICAR self-test; release notes from CHANGELOG.md. 2,176 tests; e2e MinIO 135/135, filesystem 130/130. |
| **v9.1.0** | Shared Mailboxes and delegated mailboxes over IMAP (`Shared/`, `Other Users/` namespaces, real ACL rights, live revocation); References header stored + full RFC 5256 THREAD=REFERENCES; recover deleted items in shared/delegated mailboxes; shared mailbox quota; Apple profile ticket for iOS; Helm chart 2.0.1 tested on kind (`scripts/k8s-e2e.sh`); backup RBAC hardening. 2,021 tests; e2e MinIO 135/135, filesystem 130/130. |
| **v9.0.0** | **OWASP hardening + extended mail logic** (breaking). Four-area OWASP/ASVS audit and two review rounds, all findings fixed with tests. Shared web/mail lockout, HttpOnly refresh cookies, SSE tickets, DMARC/SPF on the real session with local-domain anti-spoofing, ReDoS-safe rules, pre-auth DoS limits, SSRF guards, HMAC audit exports, encrypted backups, fail-closed schema sync, hardened containers, signed CI images. SMTP DSN/CHUNKING/SMTPUTF8, 48 h retries with delay DSN; IMAP QRESYNC/SORT/THREAD/ACL/COMPRESS; quota levels, recover deleted items (30 d), OOF once per period, server drafts + undo send; webmail shortcuts, undo, search operators; BCP permission map + list pattern; Thunderbird autoconfig + Apple profile; compose variants minimal/full; Helm 2.0.0. 1,894 tests; e2e MinIO 135/135, filesystem 130/130. |

### v8.x — Protocol Conformance

| Version | Highlights |
|---------|-----------|
| **v8.0.0** | **Protocol conformance** (breaking). Every protocol reviewed against its RFC/MS specification and Clean Code; all findings fixed with tests. SMTP per-recipient relay results, verified smarthost TLS, RFC 3464 bounces; IMAP per-session sequence numbers, modified UTF-7; POP3 atomic QUIT + maildrop lock; JMAP full sender policy, paged `/changes`; CalDAV/CardDAV discovery + filters; ActiveSync 14.1 (AirSyncBase, ItemOperations, Search, MeetingResponse, mandatory policy key, remote wipe). Local storage on a Docker volume, S3 with TLS, `coremail storage migrate`. Credential changes close open sessions immediately. New Helm chart 1.0.0. End-to-end tested (MinIO 131/131, filesystem 126/126). |

### v7.x — Secure by Default

| Version | Highlights |
|---------|-----------|
| **v7.0.0** | **Secure by default** (breaking). Mail clients: app passwords required with two-factor authentication, credentials only after TLS (IMAP STARTTLS, POP3 STLS, SMTP 587), shared brute-force lockout. Web/admin: hashed rotating sessions with revocation, hardened MFA (backup codes, WebAuthn, encrypted TOTP), RBAC per area, setup token, `TRUST_PROXY`, no crashes on bad requests. Original messages stored and served byte-exact, atomic UID/modSeq allocation. New: OIDC SSO, LDAP/AD login + sync, certificate auto-renewal, out-of-office replies, S/MIME verification, IMAP SEARCH/literals, CalDAV REPORT + recurring events, quarantine release. Removed: EWS. MinIO image now `pgsty/minio` (pinned). End-to-end tested (95/95). |

### v6.x — Security & Cleanup

| Version | Highlights |
|---------|-----------|
| **v6.0.0** | **Security and cleanup release** after a full code review. Fixed: token handling (refresh tokens no longer accepted as access tokens, bad tokens no longer crash services), JMAP prototype pollution, Bcc leak and delegation scope, XSS in Shared Mailboxes, cross-mailbox access (inbox rules, EWS ResolveNames), SMTP command injection after oversized DATA, IMAP UID FETCH/STORE/EXPUNGE, lost ActiveSync/EWS mail, DKIM for ports 465/587, spam-filter connection stage, retention by delivery time. Removed: unused storage-api, PowerShell stub, dead BCP pages, OpenTelemetry modules. EWS has its own switch. Automated tests for every fix. |

### v5.x — IMAP4rev2 + RFC Compliance + Stack Slim-down

| Version | Highlights |
|---------|-----------|
| **v5.9.0** | **English-only repository**: README, CHANGELOG, docs, code and infra comments, CLI output in English; German README kept as `README.de.md`. Ships the v5.8.0 features as the first published image (`magpeek/coremail-app:5.9.0`). |
| **v5.8.0** | **Admin CLI `coremail`** (new package `cli`, in the image at `/usr/local/bin/coremail`): list, create and delete users/mailboxes/Shared Mailboxes; enable/disable SMTP/IMAP/POP3/JMAP/EWS connectors, listener ports/TLS; SMTP banner; certificates (self-signed, Let's Encrypt, activate, renew). **New `docker-compose.yml`**: only the necessary parameters, mandatory values with startup-abort check, `setup.sh` generates the `.env`. |
| **v5.7.1** | **JMAP server** — new package `jmap-server` (port 3006): RFC 8620 Core, 8621 Mail (Mailbox/Email/Thread/Identity/EmailSubmission/SearchSnippet/VacationResponse), 8887 WebSocket, 9404 Blob, 9425 Quota, 9670 Principals/Sharing, 9749 VAPID. Discovery `/.well-known/jmap`, push via EventSource + WebSocket, toggle in the BCP (default on). See [docs/jmap.md](jmap.md). |
| **v5.7.0** | Build hardening: pnpm pinned to 11, 70 stale `src/*.js` artifacts removed, `noEmit` in frontend tsconfigs. |
| **v5.6.1** | **Distribution groups (DistributionGroups) removed entirely** — rarely used; the use case is better served by Shared Mailboxes (team mailboxes) or an external listserv tool. Schema drop of 2 tables + enum, BCP page removed, EMS cmdlets removed. |
| **v5.6.0** | **OAuth2 / Modern Auth removed entirely from the stack** (~970 LOC + 4 Prisma tables). XOAUTH2 has no mainstream client UI for third-party servers. JWT back on HS256 (`JWT_SECRET`). Mail clients use app passwords, MWA/BCP session JWTs. |
| **v5.5.0** | **IMAP4rev2** (RFC 9051) compliance: STARTTLS + AUTHENTICATE SASL + UNSELECT + ID. Decision against XOAUTH2 documented. |
| **v5.4.0** | Desktop client setup simplified: IMAP account, calendar/contacts via CalDAV/CardDAV. |
| **v5.3.5** | IMAP FETCH completely rewritten: ENVELOPE bug fixed (NIL lists, RFC 3501 §7.4.2), real BODYSTRUCTURE instead of BODY[TEXT], INTERNALDATE, BODY[]/BODY[HEADER]/BODY.PEEK[*]/RFC822 variants |
| **v5.3.1** | Complete IMAP command suite: CREATE, DELETE, RENAME, APPEND, COPY, UID COPY, MOVE, UID MOVE, SEARCH, UID SEARCH, CLOSE, CHECK. UID compound-dispatcher bug fixed. POP3 app-password + byte-stuffing fix. |
| **v5.2.19** | parseLine empty-quoted-string fix (`LIST "" "*"`) — Mac Mail/iOS Mail/Thunderbird could never fetch their folder list via LIST |
| **v5.2.18** | IMAP SPECIAL-USE + LSUB + NAMESPACE + STATUS for Mac Mail / iOS Mail |

### v3.18.x — Feature Polish & Production Hardening

| Version | Highlights |
|---------|-----------|
| **v3.18.40** | External clients setup page in the webmail (CalDAV synchronizer guide) |
| **v3.18.36** | Generic hostname auto-derive for all domains + image privacy banner hardened |
| **v3.18.30** | BigInt crash fix + audit toggle + audit translations |
| **v3.18.25** | Calendar invitations iMIP/iTIP (RFC 6047/5546) — accept/decline buttons in common mail clients |
| **v3.18.18** | CalDAV URL display in the share dialog + toolbar share button |
| **v3.18.14** | Calendar sharing with READ/WRITE permission + sidebar section "Shared with me" |
| **v3.18.11** | MWA Global Address Book (GAL browser) with tabs "My/Global address book" |
| **v3.18.10** | Image privacy banner — external `<img>` blocked until confirmed |
| **v3.18.7** | Audit log v2: filters + PDF + SHA-256 + stats + anomalies + meta-logging |
| **v3.18.5** | eDiscovery & Legal Hold removed entirely |
| **v3.18.4** | Signature rich-text editor (Tiptap) with images/links/fonts (10 fonts) |
| **v3.18.0** | Inbox rules with conditions, actions and exceptions — forward/redirect via BullMQ |

### v3.17.x — Infrastructure Consolidation

| Version | Highlights |
|---------|-----------|
| **v3.17.0** | Integrated HTTPS proxy (port 443, hot reload via Redis, BCP → SSL/TLS management) |
| **v3.16.6** | Recipient autocomplete in compose + resizable panels + view settings |
| **v3.15.0** | DNS hardening: trusted resolvers (8.8.8.8/1.1.1.1/9.9.9.9) + cross-validation |
| **v3.14.0** | Pentest fixes: SMTP brute-force protection + rate limiting + Fail2Ban + firewall |
| **v3.13.0** | SMTP audit: 5 critical bugs fixed + IANA time zones + webmail renamed to MWA |
| **v3.11.0** | Retention policies: DPT/RPT/personal tags + background retention worker |
| **v3.5.5** | MWA now served directly at `/` (instead of `/owa/`) |
| **v3.2.3** | Admin panel renamed: ECP → BCP, path `/ecp/` → `/bcp/` |
| **v2.1.19** | Grafana + Prometheus removed from the stack; Synology compose extended with rspamd + clamav |
