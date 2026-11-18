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
 ['JWT_SECRET='+h(32),'PEPPER='+h(32),'POSTGRES_PASSWORD='+h(20),'REDIS_PASSWORD='+h(20),'MINIO_ROOT_PASSWORD='+h(20)].join('\n')+'\n')"
```

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

Steps: `setup users smtp imap pop3 jmap dav eas eas-body eas-commands eas-legacy rest webmail admin tls legacy-clients backup branding mfa live protocols policies mapi lockout restart storage schema-upgrade`.
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
`schema-upgrade` builds a database from the 8.0.0 schema (`E2E_SCHEMA_BASE`, default `d5ad681`) and checks that schema-sync upgrades it, refuses duplicates and fails closed on a dropped column with data (`E2E_PG_CONTAINER` selects the PostgreSQL container).
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
seconds after „Ältere Clients erlauben" is switched on (no container restart) and refuses it again
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
the image proxy 403 `EXTERNAL_IMAGES_BLOCKED`. Everything is reset to inherit at the end. See
[webmail-policies.md](webmail-policies.md).
`mapi` (9.4): MAPI over HTTP is off by default (Connect → 403 without a password prompt; GET →
X-ResponseCode 2; no credentials → 401). The admin turns the switch on for A, B sends A a mail over
SMTP submission; A connects (`Connect`, cookies, PROCESSING/DONE), logs on, finds the mail in the
Inbox contents table, opens it and reads the body through a stream, then creates a message in the
Outbox (`SetProperties`, `ModifyRecipients`, `SubmitMessage`) that reaches B (IMAP search). Switch off
→ the running session and a new Connect get 403. A's switch is reset to inherit. The compose override
sets `MAPI_ALLOW_PLAIN_HTTP=true` (the runner uses plain HTTP). See [mapi.md](mapi.md).
`setup` reads the one-time setup token from `docker logs coremail-e2e`. Each run prints
`[PASS]/[FAIL]` lines and writes `$E2E_STATE_DIR/results-<steps>.json`; the exit code is
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
