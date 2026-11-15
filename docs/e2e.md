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

## 3. Run

```bash
node scripts/e2e/run.mjs                 # all steps, in order
node scripts/e2e/run.mjs imap pop3       # single steps (state is kept in state.json)
node --test scripts/e2e/repo-hygiene.test.mjs   # static regression checks (no stack needed)
```

Steps: `setup users smtp imap pop3 jmap dav eas eas-body eas-commands rest admin mfa live lockout restart`.
`live`: B keeps an IMAP IDLE connection, an authenticated SMTP submission session and a
POP3 session open, changes the password in the web client and expects `* BYE`, `421 4.7.0` and
`-ERR [AUTH]` right away; A's IDLE connection (app password) stays usable. The new password of B
is written to `credentials.json`.
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
  (default `e2e.test`), `E2E_ENV_FILE`, `E2E_COMPOSE_PROJECT`.

## 4. Tear down

```bash
docker compose -p coremail-e2e --env-file "$E2E_STATE_DIR/e2e.env" \
  -f infra/docker/docker-compose.yml -f infra/docker/docker-compose.e2e.yml down -v
rm -f "$E2E_STATE_DIR"/state.json   # next run starts from a fresh setup
```

Always pass `-p coremail-e2e`: `down -v` then removes only the e2e containers and volumes.
