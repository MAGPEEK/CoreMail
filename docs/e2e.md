# End-to-end tests (real container stack)

`scripts/e2e/` drives a locally built CoreMail stack over real sockets and HTTP:
setup wizard, RBAC, SMTP 25/465/587, IMAP 143/993, POP3 110/995, JMAP, CalDAV/CardDAV,
ActiveSync, REST/web, transport-rule quarantine, out-of-office, TOTP MFA + app passwords,
brute-force lockout and a container restart. Node 22+ only, no extra dependencies.

Everything stays on the machine: ports are published on `127.0.0.1` only, and the runner
switches outbound delivery to a smarthost **sink container** (`sink`, see
`scripts/e2e/smtp-sink.mjs`) before any mail is sent, so auto-replies, DSNs and relayed
mail never reach the internet.

## 1. State directory and test env (outside the repo)

```bash
export E2E_STATE_DIR=/tmp/coremail-e2e        # holds e2e.env, credentials.json, state.json, results
mkdir -p "$E2E_STATE_DIR"
node -e "const h=n=>require('crypto').randomBytes(n).toString('hex');require('fs').writeFileSync(process.env.E2E_STATE_DIR+'/e2e.env',
 ['JWT_SECRET='+h(32),'PEPPER='+h(32),'POSTGRES_PASSWORD='+h(20),'REDIS_PASSWORD='+h(20),'MINIO_ROOT_PASSWORD='+h(20),
  'COREMAIL_SECRETS_PATH='+process.env.E2E_STATE_DIR+'/secrets'].join('\n')+'\n')"
```

`COREMAIL_SECRETS_PATH` keeps the secrets directory of `coremail-init` (10.4) out of the
repository (default: `infra/docker/secrets/`, git-ignored); `coremail-init` copies the e2e.env
values into it. Remove it together with the volumes (`down -v`).

Test passwords are generated on first use into `$E2E_STATE_DIR/credentials.json`.
Do not put real passwords there.

## 2. Build and start

```bash
docker build -f infra/docker/Dockerfile.app -t coremail-app:e2e .
docker compose -p coremail-e2e --env-file "$E2E_STATE_DIR/e2e.env" \
  -f infra/docker/docker-compose.yml -f infra/docker/docker-compose.e2e.yml up -d
```

`docker-compose.e2e.yml` overrides the production file: image `coremail-app:e2e`,
container names `coremail-e2e*`, host ports

| Service | Host port | | Service | Host port |
|---|---|---|---|---|
| SMTP 25 | 12525 | | IMAP 143 / 993 | 12143 / 12993 |
| Submission 587 | 12587 | | POP3 110 / 995 | 12110 / 12995 |
| SMTPS 465 | 12465 | | HTTP 3000 / HTTPS 443 | 18080 / 18443 |
| Sink HTTP (`GET /messages`) | 18025 | | | |

MinIO uses `pgsty/minio` (override with `E2E_MINIO_IMAGE`) because `minio/minio` is no
longer pullable from Docker Hub. ClamAV downloads its signatures on first start
(a few minutes); the mail tests do not wait for it.

The app ↔ rspamd network uses `10.253.254.0/29` in the e2e stack (production:
`10.253.253.0/29`), override with `E2E_RSPAMD_NET_PREFIX`. To exercise the
setup.sh defaults of a new installation as well, append to `e2e.env`:
`COREMAIL_DB_USER=coremail_app`, `COREMAIL_DB_PASSWORD=…`,
`RSPAMD_CONTROLLER_PASSWORD=…`, `BACKUP_ENCRYPTION_KEY=<64 hex>` (see
`docs/deployment-security.md`).

### Storage run modes (v8.0)

| `E2E_STORAGE` | Compose files | Object storage |
|---|---|---|
| `minio` (default) | `docker-compose.yml` + `docker-compose.e2e.yml` | bundled MinIO (`OBJECT_STORAGE` unset → pre-8.0 behaviour) |
| `filesystem` | … + `docker-compose.e2e-filesystem.yml` | `coremail-data` volume, **no MinIO container** |

```bash
E2E_STORAGE=filesystem   # export it for `up` AND for run.mjs (restart/storage steps use it)
docker compose -p coremail-e2e --env-file "$E2E_STATE_DIR/e2e.env" -f infra/docker/docker-compose.yml \
  -f infra/docker/docker-compose.e2e.yml -f infra/docker/docker-compose.e2e-filesystem.yml up -d
```

The `storage` step checks `/healthz` + `/api/v1/admin/storage` in both modes. In filesystem mode it
verifies the raw files on the volume (content = name, owner `node`, modes 0750/0640). In minio
mode it runs the migration test: probe mail on MinIO → `OBJECT_STORAGE=filesystem` without
migrating (mail services must stay closed, healthz 503 `missing-objects`) →
`coremail storage migrate --from minio --to filesystem` → services start by themselves → probe,
Archive message and attachment byte-exact over IMAP/POP3/REST → re-run copies nothing → restart.
Afterwards the stack runs on the filesystem driver (`state.storageMigrated`).

## 3. Run

```bash
node scripts/e2e/run.mjs                 # all steps, in order
node scripts/e2e/run.mjs imap pop3       # single steps (state is kept in state.json)
node --test scripts/e2e/repo-hygiene.test.mjs   # static regression checks (no stack needed)
```

Steps: `setup users smtp imap pop3 jmap dav dav-tasks contacts eas eas-body eas-commands eas-legacy eas-pim rest webmail admin tls legacy-clients backup branding profile-photo mfa live protocols policies scopes mapi lockout restart storage schema-upgrade`.
`eas-pim` (w3): a 14.1 device provisions and its FolderSync lists the default calendar (type 8),
`tasks:default` (7) and `notes:default` (10); an event created over REST arrives in the calendar
Sync with the event id as ServerId; a task added by the device (ClientId → ServerId) is a task over
REST, a REST change of it reaches the device as a Change and a device Delete removes it; a note
added by the device is a note over REST; a weekly meeting with a deleted occurrence added by the
device expands without that occurrence over REST (10.0: the room booking check is gone with the
room feature). Contacts (w3): the
FolderSync lists `contacts:default` (9); a contact created over REST arrives in the contacts Sync
(names, Email1Address, MobilePhoneNumber, CompanyName); a contact added by the device (names,
e-mail, business phone, business address, NickName, body) is a contact over REST and its vCard is
served over CardDAV. Every response carries only 14.1 tags. See
[activesync.md](activesync.md#calendar-tasks-and-notes-w3) and
[activesync.md](activesync.md#contacts-w3).
`eas-legacy`: OPTIONS announces `12.1,14.0,14.1` and an unannounced version (2.5) is served as 14.1
(Status 142 in WBXML for the unprovisioned device); a 12.1
device gets HTTP 449 without a policy key, provisions, syncs (no Email2 / 14.x tags in any
response), sends a mail in the 12.1 query-string form (raw MIME, `SaveInSent=T`, empty 200) that
reaches user A, and runs a FolderSync with a base64-encoded request line; a 14.0 device gets
Status 142 in WBXML, provisions, syncs (Email2 ConversationId present), reads UserInformation in the
EmailAddresses form and sends with ComposeMail WBXML (9.4: empty success response). 9.4: the 14.0
device pings without `X-MS-PolicyKey` (served — Status 5 for the too short heartbeat — while
FolderSync without key and an unknown device still get 142); with BCP → Settings → Mail set to 1 MB
(applied at once through the settings reload) a 2 MB SendMail gets Status 122 (14.0) / HTTP 413
(12.1) and a 3 MB body HTTP 413 at the request-body cap, then the limit is restored to 25 MB. See [activesync.md](activesync.md).
`dav-tasks` (9.5): the calendar home lists the task list (`/dav/calendars/<id>/tasks/`, VTODO); a
VTODO `PUT` is a task in `GET /api/v1/tasks/:id` (status rules applied), a webmail change shows in
`GET` (WAITING as `NEEDS-ACTION`, `CATEGORIES` kept), a task created with `POST /api/v1/tasks` is in
`REPORT calendar-query` (VTODO time-range), completing a recurring task over CalDAV creates the
next one, `DELETE` honours `If-Match`. See [caldav.md](caldav.md).
`schema-upgrade` builds a database from the 8.0.0 schema (`E2E_SCHEMA_BASE`, default `d5ad681`) and checks that schema-sync upgrades it (new unique constraint over the new optional `tasks.uid`, two tasks of one user kept); on 9.5.x databases (`E2E_SCHEMA_BASE_9_5`, default `af6bd185` = v9.5.1) it refuses duplicates for a new unique constraint and fails closed on a dropped column with data — both times the room tables next to it stay untouched; 9.5: it also upgrades a 9.4.0 database (`E2E_SCHEMA_BASE_9_4`, default `46ec9d80`) whose user has two tasks — the new `UNIQUE (userId, uid)` over the new optional `tasks.uid` is applied without a duplicate check, the tasks are kept. 10.0: a 9.5.x database with room rows is upgraded **without** `COREMAIL_ALLOW_SCHEMA_DATA_LOSS` — every retired room table is logged, the pre-migration dump is written first and holds the room rows, the room's own owner-less mailbox (folder, message, attachment) is deleted while a user's mailbox and an unrelated mailbox stay, then the tables and the `ResourceType` enum are gone and the other data is kept (the refused dropped-column scenario keeps the room mailbox until its `COREMAIL_ALLOW_SCHEMA_DATA_LOSS` run removes it) (`E2E_PG_CONTAINER` selects the PostgreSQL container). `rest` checks that `/calendar/rooms` answers 404, `smtp` that `/admin/resources` answers 404 and a room address is refused at RCPT with 550 5.1.1.
`webmail` (9.3): shared / delegated mailboxes in the mail view at API level — A lists the team
mailbox in `GET /api/v1/user/accessible-mailboxes` (FULL_ACCESS + SEND_AS), hides and shows it
(persisted; B without access gets 404, an invalid ref 400), lists folders / messages / search and
creates, renames a folder in it via `/api/v1/mail/shared-mailboxes/:id` (never visible in the own
mailbox, no reparenting into it); the pre-9.3 `/api/v1/user/shared-mailboxes/:id` routes still answer
with their 9.2 shapes (folder array, `{ total, messages }`, protected folder 403, create 201,
delete 204); B gets
READ_ONLY on the team mailbox and a READ_ONLY delegation on A's mailbox: reads work, every write
route answers 403 `READ_ONLY`; after the grants are removed B gets 403 `NO_ACCESS`. The test folder
and grants are removed again. 9.4: A creates a named signature, sets it as default for the own
address and the team mailbox, the legacy `/user/signature` mirrors it, B cannot edit it, deleting
it clears the defaults. 9.4 compose: `/compose/<draftId>` (a draft in its own window) serves the
webmail, `GET /api/v1/mail/drafts/:id` loads the draft with its quote marker (B gets 404), `PUT`
replaces it (new id, the old one 404), the draft is deleted again; see [compose.md](compose.md).
`rest` (9.4) additionally checks the preferences round trip (partial PATCH,
400 on invalid values, `migrateFromLocal` ignored once written), `?markRead=false`, `?sort=&dir=`,
`/auth/sessions` (current marked, ending another session, `revoke-others`) and the read-receipt
route. See [user-settings.md](user-settings.md).
`tls` (9.3): generates a test CA + a leaf for `mail.<E2E_DOMAIN>` with openssl inside the app
container and uploads it WITHOUT services (the mail ports must not change), then assigns
SMTP/IMAP/POP3 with `PUT /api/v1/admin/certificates/:id` only and expects 993 / 465 / 995 (TLS) and
143 / 587 (STARTTLS) / 110 (STLS) to serve exactly that certificate (SHA-256 fingerprint, the
intermediate is sent) and `GET /api/v1/admin/certificates/served` to agree (its `https` entry is
`null` or a well-formed probe of the integrated HTTPS server); removing the services
must bring every port back to the self-signed default for `mail.<E2E_DOMAIN>` (one certificate on
all ports, visible as the SELF_SIGNED protocol certificate). The uploaded certificate is deleted.
See [certificates.md](certificates.md).
`legacy-clients`: the IMAPS listener refuses a TLS 1.0 client by default, accepts TLS 1.0/1.1 a few
seconds after „Zusätzlich veraltete TLS-Versionen 1.0/1.1 zulassen (optional)" is switched on (no container restart) and refuses it again
after switching off; Autodiscover answers 401 Basic first, then IMAP/SMTP with an explicit
`<Encryption>` (mixed-case path); the device relay refuses an external recipient while off, refuses
`0.0.0.0/0` and `::ffff:0:0/96`, then (private networks + `<E2E_DOMAIN>`) accepts the external RCPT for that
sender domain only, refuses a relayed message with an `.exe` attachment at DATA (attachment filter) and
is switched off again. See [legacy-tls.md](legacy-tls.md), [device-relay.md](device-relay.md),
[autodiscover.md](autodiscover.md).
`backup` (9.3): B gets a folder `E2E-Backup` with two APPENDed messages (attachment, `\Flagged \Seen`);
a mailbox backup of B (encrypted ZIP in the bucket) is restored from the STORED archive into A
(`mode: subfolder`) and A must see `Wiederhergestellt <date>.E2E-Backup` over IMAP with both
messages byte-exact and their flags; a second restore and an upload of the downloaded ZIP add
nothing (duplicates); HELP_DESK gets 403; „Empfohlene Sicherung einrichten" creates the full +
system schedules once, the system schedule's run-now writes a `pg_dump` (`PGDMP`) to `system/…`;
the created schedules are deleted again. Skipped with `E2E_STORAGE=filesystem` (no MinIO, no
backup bucket). See [backup.md](backup.md).
`admin` (9.3) starts with `GET /api/v1/admin/security/capabilities`: on the standard stack (both
storage modes include rspamd and ClamAV) rspamd must be `available` and ClamAV `available` or
`unavailable` (still loading its signatures), never `absent`; no host name or URL in the reply.
ClamAV must not report `host-not-found` there (the container is part of the stack).
With `E2E_SCANNERS=absent` (a stack without both containers that sets `RSPAMD_ENABLED=false` /
`CLAMAV_ENABLED=false`, like the minimal compose file) both must be `absent` with reason
`disabled-by-config` — a missing host name alone is `unavailable`, never `absent`.
At its end (9.4) `admin` checks the hygiene settings: a mailbox-scoped sender block refuses that
recipient at RCPT TO (550 5.7.1) but not another one and appears in the CSV export; the BCP spoofing
action `reject` takes effect without a restart (a forged local header From → 550 after DATA; skipped
when `LOCAL_SPOOF_ACTION` is set); a per-IP API limit of 15 answers `RateLimit-Limit: 15` and 429
for anonymous requests while the signed-in admin is unaffected (restored to 500, the gateway limits
are reset afterwards).
`branding` (9.3): sets product name + colour (a low-contrast header colour must come back as a
warning), uploads a generated PNG logo and an SVG favicon, checks the public
`GET /api/v1/branding`, the asset headers (`nosniff`, sandbox CSP, immutable, content hash = file
name), refuses hostile SVGs (onload, script, external href, DOCTYPE/XXE) with 400 `SVG_UNSAFE`,
checks the injected `<title>`, colour variable, favicon and `#cm-branding` JSON in `/` and `/bcp/`,
and ends with `POST /api/v1/admin/branding/reset` (defaults back, old assets 404).
`profile-photo` (9.5): user A uploads a PNG that carries an `eXIf` chunk with GPS text; the stored
photo (`GET /api/v1/users/<id>/photo`) must be a 512×512 JPEG without an APP1 segment or any of the
metadata, served `private` with a content-hash ETag; user B of the same domain gets it, revalidates
it (304) and finds A through `POST /api/v1/users/photos/lookup`; a progressive JPEG of 2 000 tiny
scans is refused (415 `UNSUPPORTED`) without being decoded; an SVG body is refused (415
`TYPE`); A's `DELETE /api/v1/user/photo` and an admin's `DELETE /api/v1/admin/mailboxes/<id>/photo`
each end in 404.
`live`: B keeps an IMAP IDLE connection, an authenticated SMTP submission session and a
POP3 session open, changes the password in the web client and expects `* BYE`, `421 4.7.0` and
`-ERR [AUTH]` right away; A's IDLE connection (app password) stays usable. The new password of B
is written to `credentials.json`.
`protocols` (9.4): `inherit` on the server level is refused (400, two-state); the admin switches
IMAP off for B (`PUT /api/v1/admin/protocol-access/users/:id`)
→ B's IMAP IDLE connection gets `* BYE IMAP access has been disabled for this account` and is
closed, a new login with the correct password gets `NO [AUTHORIZATIONFAILED]`, a wrong one still
`NO [AUTHENTICATIONFAILED]`, B's `/api/v1/user/client-config` lists no IMAP server; Webmail off →
`POST /auth/login` and B's existing session on
`/api/v1/mail/folders` answer 403 `PROTOCOL_DISABLED`; back to inherit → web login and IMAP work.
B's switches are reset to inherit at the end. See [protocol-access.md](protocol-access.md).
`policies` (9.4): the server level of the webmail policies is readable and refuses `inherit`; the
calendar and tasks modules off for B (`PUT /api/v1/admin/webmail-policies/users/:id`) → B's
`/api/v1/calendar` and `/api/v1/tasks` answer 403 `FEATURE_DISABLED`, `/api/v1/user/features`
reports them off, mail keeps working, CalDAV `PROPFIND /dav/calendars/<id>/` → 403; the blocked
extension `bin` → the attachment download answers 403 `ATTACHMENT_BLOCKED`; `bin` as "save only" →
`?inline=1` 403 `INLINE_PREVIEW_DISABLED`, the plain download 200; external images "always block" →
the image proxy 403 `EXTERNAL_IMAGES_BLOCKED`; the module "App-Passwörter" off for B → B's existing
app password fails on IMAP (`NO`) and JMAP (401) while the primary password works, back to inherit
→ the app password works again. Everything is reset to inherit at the end. See
[webmail-policies.md](webmail-policies.md).
`scopes` (9.5): a second domain `scope-b.<E2E_DOMAIN>` with one mailbox and a HELP_DESK admin
limited to the e2e domain (`PUT /api/v1/admin/organisation/role-assignments/:id/scope`).
`GET /api/v1/admin/me/permissions` reports the scope and no server-wide areas; the mailbox list
holds only the e2e domain; the other-domain mailbox answers 404 with the same body as an unknown
id (GET and PUT); enabling an own-domain USER works; `/admin/servers/settings` and changing its
own scope → 403; the scope change is in the audit log (`user.role.scope`); deleting the domain
while it still scopes the admin → 409 `DOMAIN_SCOPES_ADMINS`. Everything is removed at the end.
See [rbac.md](rbac.md).
`mapi` (9.4): MAPI over HTTP is off by default (Connect → 403 without a password prompt; GET →
X-ResponseCode 2; no credentials → 401; an NTLM header gets the Basic challenge only; Autodiscover
with `X-MapiHttpCapability: 1` announces no mapiHttp block). The admin turns the switch on for A:
Autodiscover now announces the mapiHttp block (MailStore + AddressBook URLs, A's LegacyDN, no
EXCH/EXPR). B sends A a mail over SMTP submission; A connects (`Connect`, cookies, PROCESSING/DONE),
logs on, finds the mail in the Inbox contents table, opens it and reads the body through a stream.
Cached mode (9.5): an ICS contents synchronization of the Inbox (`RopSynchronizationConfigure`,
`RopFastTransferSourceGetBuffer` until Done) carries the mail and ends with an ICS state; after a new
mail and `RopSetMessageReadFlag` on the first one, a synchronization with that state (uploaded with
`RopSynchronizationUploadStateStream*`) sends only the new mail as a change and the read state as
`IncrSyncRead`, a third one nothing; a malformed uploaded state is refused with `RpcFormat`; a
draft created offline in Drafts (an ID from `RopGetLocalReplicaIds`, `ImportMessageChange` +
`SaveChangesMessage`) keeps that ID — `RopOpenMessage` opens it by it, a second import edits it,
and with the collector's state merged in the next download sends neither back while the server
holds exactly one (edited) draft under that ID (`offlineDraftRoundTrip` in the test client, also
run by `app.test.ts`); a hierarchy synchronization lists the default folders under their MAPI
names (Inbox, Drafts, Sent Items, Deleted Items, Junk Email, Archive) and the Outbox directly below
Top of Information Store. A (with a fresh logon) then creates a message in the Outbox (`SetProperties`, `ModifyRecipients`, `SubmitMessage`) that
reaches B (IMAP search). The address book: `Bind`, `GetSpecialTable`, `QueryRows` (paged) lists A and
B, `ResolveNames` finds B by address (an unknown address stays unresolved), `DNToMId` maps A's DN,
`Unbind`. A `NotificationWait` after `RopRegisterNotification` wakes within 3 s of a new mail and the
following empty `Execute` carries a RopNotify NewMail. Switch off → the running session and a new
Connect get 403 and Autodiscover drops the mapiHttp block. A's switch is reset to inherit. The
compose override sets `MAPI_ALLOW_PLAIN_HTTP=true` (the runner uses plain HTTP) and
`MAPI_HTTPS_TRUSTED=true` (no CA certificate in the stack). See [mapi.md](mapi.md).
`setup` reads the one-time setup token from `/secrets/setup-token` in `coremail-e2e` (10.4,
the secrets directory of `coremail-init`) and falls back to `docker logs coremail-e2e`; with the
file in use it also checks that the log names the file and never contains the token. Each run prints
`[PASS]/[FAIL]` lines and writes `$E2E_STATE_DIR/results-all.json` (all steps),
`results-<step>+<step>.json` (a short selection of steps) or `results-<n>-steps-<hash>.json` (a
long selection — the joined names would exceed the Windows path limit); the exit code is
non-zero when a check failed.

Notes:
- The api-gateway rate limiters (auth: 20 requests / 15 min per IP) are in-memory. When the
  runner hits a 429 it restarts the `api-gateway` program via supervisorctl and retries once
  (logged as `429 … resetting gateway rate limits`).
- Inbound port 25 is greylisted on first contact; the `smtp` step lowers
  `greylistWaitSec` to 60 s through the admin API and retries after 62 s.
- The `lockout` step clears the `mailauth:*` Redis keys afterwards.
- Environment overrides: `E2E_HOST`, `E2E_*_PORT`, `E2E_CONTAINER`, `E2E_DOMAIN`
  (default `e2e.test`), `E2E_ENV_FILE`, `E2E_COMPOSE_PROJECT`, `E2E_STORAGE` (`minio` | `filesystem`),
  `E2E_SCANNERS` (`deployed` default | `absent`).

## 4. Tear down

```bash
docker compose -p coremail-e2e --env-file "$E2E_STATE_DIR/e2e.env" \
  -f infra/docker/docker-compose.yml -f infra/docker/docker-compose.e2e.yml down -v
rm -f "$E2E_STATE_DIR"/state.json   # next run starts from a fresh setup
```

Always pass `-p coremail-e2e`: `down -v` then removes only the e2e containers and volumes.
