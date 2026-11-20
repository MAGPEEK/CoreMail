# api-gateway security behaviour

Settings and contracts of the api-gateway hardening (8.0.x OWASP wave). All
switches are environment variables of the `coremail` container; the defaults
are the secure choice.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `HTTP_REDIRECT_HTTPS` | `true` | Plain-HTTP requests get `308` to `https://…` while the integrated HTTPS proxy serves a certificate marked "active for HTTPS". `false` disables it. |
| `HTTPS_PUBLIC_PORT` | `443` | Port in the redirect URL (v9.0): the port clients reach, e.g. `8443` for a `8443:443` mapping. |
| `AUDIT_EXPORT_SIGNING_KEY` | — | Optional dedicated key (≥ 32 characters) for audit export signatures (v9.0). Rotating it invalidates old signatures. |
| `MAIL_SEND_RATE_LIMIT` | `30` | Messages per user and window via `POST /api/v1/mail/send` (`0` = off). Over the limit: `429` + `Retry-After`. |
| `MAIL_SEND_RATE_WINDOW_SEC` | `60` | Window of the send rate limit. Since 10.5 this burst limit (requests per minute) is complemented by the per-account hourly send rate of every submission path (messages + recipients per hour, BCP → SMTP & Routing → Sendelimit; `429` code `SEND_RATE_LIMITED`) — docs/mail-protocol-limits.md. |
| `MAIL_SEND_MAX_RECIPIENTS` | `500` | Max. recipients (to + cc + bcc) per message. |
| `IMAGE_PROXY_RATE_LIMIT` | `120` | Image proxy requests per user and window (`0` = off). |
| `IMAGE_PROXY_RATE_WINDOW_SEC` | `60` | Window of the image proxy limit. |
| `BACKUP_IMPORT_MAX_BYTES` | `524288000` (500 MiB) | Max. body of `POST /api/v1/admin/backups/import/:userId` (checked on `Content-Length` and on the streamed bytes → `413`). |

The rate limits count in Redis (`ratelimit:<scope>:<userId>:<window>`), so they
hold across restarts. If Redis does not answer within 500 ms, an in-process
counter takes over.

## HTTP → HTTPS redirect and HSTS

- The redirect applies once the integrated HTTPS proxy is listening and at least
  one served certificate has `isActiveHttps` (BCP → SSL/TLS → lock icon).
- Target host: the requested host if a served certificate covers it, otherwise
  `ServerSettings.publicHostname`. Client-supplied hosts are never echoed, so
  there is no open redirect.
- Port in the redirect URL: `HTTPS_PUBLIC_PORT` (default `443`, then omitted) —
  the port clients reach, not the listener port `HTTPS_PORT`. With a port mapping
  such as `8443:443` set `HTTPS_PUBLIC_PORT=8443`; with `HTTPS_PORT=8443` and
  `8443:8443` set `HTTPS_PUBLIC_PORT=8443` as well (before v9.0 the listener
  port was used, which leaked the internal port behind a mapping).
- Reverse proxy without `TRUST_PROXY`: a request carrying any `X-Forwarded-*`
  or `Forwarded` header is **not** redirected, and a warning is logged once.
  Its `X-Forwarded-Proto` cannot be trusted, and a proxy that speaks plain HTTP
  to port 3000 would otherwise get an endless `308` loop (e.g. Synology DSM
  Application Portal, Traefik). Direct clients without such headers are still
  redirected.
- Exempt: `/.well-known/acme-challenge/*`, `/healthz`, `/livez`, loopback peers
  (checked on the raw socket address), and requests that are already HTTPS.
  A request counts as HTTPS if it came in on the TLS socket, or if it carries
  `X-Forwarded-Proto: https` from a proxy trusted by `TRUST_PROXY`.
- External TLS terminator (Traefik, Caddy, DSM) in front of port 3000: set
  `TRUST_PROXY` so its `X-Forwarded-Proto` is honoured. If you cannot set it,
  set `HTTP_REDIRECT_HTTPS=false`. The redirect only applies when the integrated
  proxy has an active HTTPS certificate. `infra/docker/docker-compose.synology.yml`
  sets `HTTP_REDIRECT_HTTPS: "false"` because TLS ends at the DSM portal there.
- `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` is
  sent on HTTPS responses only.

## Tokens in URLs: SSE tickets

`requireAuth` accepts the access token **only** in the `Authorization: Bearer`
header. The one exception is the SSE stream, because `EventSource` cannot send
headers:

```
POST /api/v1/events/ticket          Authorization: Bearer <access token>
  → 200 { "ticket": "<43 chars base64url>", "expiresIn": 60 }   (Cache-Control: no-store)
GET  /api/v1/events?ticket=<ticket>
```

- A ticket is single-use and valid for 60 s. It is bound to the user and the
  session of the access token it was issued for. A revoked session (or
  "revoke all sessions") rejects it like the token itself.
- Only the SHA-256 of a ticket is stored, in Redis `auth:sse-ticket:<hash>`.
- `GET /api/v1/events?token=<access token>` still works for one release. It is
  **deprecated** and will be removed.
- Frontends: request a fresh ticket before every `new EventSource(...)`,
  including reconnects, because a ticket cannot be reused. Since 9.0 the MWA
  (`useRealtime`, since 9.4 one connection per browser) and the BCP dashboard do exactly that
  (`lib/reconnectingEventSource.ts`, ticket request through the API client, one
  refresh on a 401); neither puts the access token into a URL any more.

## Global API rate limit (9.4)

Before 9.4 every request counted against a fixed 500 requests / 15 min per client
IP — the users of an office behind one NAT address exhausted it together. Since 9.4:

- **Signed-in requests** (a valid `Authorization: Bearer` access token) count per
  **user**, anonymous requests per **client IP** (IPv6 per /56; the IP follows
  `TRUST_PROXY`). Protocol clients with Basic authentication (ActiveSync, CalDAV,
  JMAP) count per IP as before — their services have their own lockouts.
- **Exempt**: loopback peers (internal services); MAPI over HTTP (`/mapi`, any case — the
  MAPI server limits per authenticated mail account, `MAPI_RATE_LIMIT`, see [mapi.md](mapi.md));
  static files and SPA pages (GET/HEAD
  outside `/api/`, `/auth/`, `/jmap`, `/dav`, `/.well-known/`, Autodiscover and
  ActiveSync); the live-event stream `GET /api/v1/events` (only refused tickets or
  tokens count against the IP budget, and an address whose budget is used up gets no
  stream). `POST /api/v1/events/ticket` counts per user like any API request — every
  stream needs a fresh one-time ticket, so this bounds the streams one token can open.
- Fixed window per bucket; over the limit: `429` with `Retry-After` and
  `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` on every counted response.
- **Configuration**: BCP → Einstellungen → Sicherheit → API-Ratenbegrenzung
  (`ServerSettings.apiRateLimit*`, applied at once after a save, otherwise within
  60 s). Environment variables override the stored values when set — the BCP shows
  them read-only:

| Variable / BCP field | Default | Range |
|---|---|---|
| `API_RATE_LIMIT_ENABLED` | `true` | `false` turns the global limit off (the auth, setup, SSO and admin-mutation limiters below stay) |
| `API_RATE_LIMIT_WINDOW_MIN` | `15` | 1 – 1440 minutes |
| `API_RATE_LIMIT_PER_USER` | `3000` | 10 – 1 000 000 requests per window and signed-in user |
| `API_RATE_LIMIT_PER_IP` | `500` | 10 – 1 000 000 requests per window and client IP (anonymous) |

Sizing: the webmail makes a few requests per user action plus periodic refreshes, so
a busy user stays well below 3000 per 15 minutes; raise the per-IP value only for
many anonymous clients behind one address (e.g. a reverse proxy without `TRUST_PROXY`).
The counters live in the api-gateway process (one instance per installation).

## Auth rate limits and error codes (v9.0)

- Login, password reset and `/auth/mfa/*` (non-GET) share the strict limiter:
  20 requests per 15 minutes per IP.
- `POST /auth/refresh` and `/auth/logout` have their own limiter: 300 **failed**
  requests per 15 minutes per IP (successful refreshes are not counted). The
  access token lives in memory, so every page load and every new tab refreshes.
  Before v9.0 these refreshes used up the login budget and users got `429`.
- The frontends treat `429`, `5xx` and network errors from `/auth/refresh` as
  temporary. They keep the session, retry with backoff (1 s, 2 s, 4 s …, or
  `Retry-After`) and show a notice. They log out only on `401` with
  `SESSION_REVOKED`, `REFRESH_*` or `TOKEN_*`.
- Failed re-authentication (`REAUTH_REQUIRED`, `REAUTH_FAILED` for app-password
  creation and MFA changes) answers `403`, not `401`. The session is valid, so the
  frontends must not refresh and re-send (that counted a second failure and then
  logged the user out). The frontends refresh-and-retry a `401` only when it has
  no `code`, or a `TOKEN_*` / `SESSION_*` / `UNAUTHORIZED` code.

## Refresh cookie for SSO logins

`POST /auth/sso/exchange` answers like `POST /auth/login` (9.0): browser
clients (`X-CoreMail-Client: web`, BCP additionally `X-CoreMail-App: bcp`) get
the refresh token only as the HttpOnly cookie `cm_rt` / `cm_rt_bcp`, the body
carries `{ accessToken, expiresIn }`. Other clients still get the full pair.

## Password reset token check

`POST /auth/reset-password/verify { token }` → `{ valid }` (9.0). The token
travels in the body, not in a URL. `GET /auth/reset-password/verify?token=` is
deprecated (`Deprecation: true` header) and will be removed in the next release.

## Image proxy (external images in mails)

```
GET /api/v1/mail/image-proxy?url=<encoded http(s) URL>     Authorization: Bearer <access token>
```

- `200`: the image bytes, with `Content-Type` taken from upstream. Only raster
  types are allowed: png, jpeg, gif, webp, avif, bmp, ico. SVG is never allowed.
  Response headers: `X-Content-Type-Options: nosniff`,
  `Cache-Control: private, max-age=3600`,
  `Content-Security-Policy: default-src 'none'; sandbox`.
- Errors (JSON `{ error }`):
  - `400` invalid or unsupported URL
  - `403` non-public target (private, loopback or metadata addresses, internal names)
  - `413` image larger than 10 MB
  - `415` not an allowed image type
  - `429` rate limit
  - `502` upstream error, or more than 3 redirects
  - `504` timeout (10 s)
- Every redirect hop and every DNS answer is checked again, and the socket
  lookup re-checks at connect time. No cookies, `Authorization` header or
  `Referer` are sent upstream.
- Frontend: `fetch()` the URL with the Authorization header, then render
  `URL.createObjectURL(blob)` (the CSP `img-src` allows `blob:`).

## Mail sending limits

`POST /api/v1/mail/send`, multipart:

- The whole request is capped at the configured max. message size. That is the
  smaller of `SmtpSettings.maxMessageSizeMb` and `ServerSettings.maxMessageSizeMb`
  (default 25 MB). The cap applies to `Content-Length` and to the bytes actually
  streamed. Over the cap: `413 { error, maxBytes }`.
- At most 10 attachments per message.
- Recipients: each must be `a@b.c` or `Name <a@b.c>`, with no CR/LF, and there
  can be at most the sender's submission limit (9.4: BCP SMTP *max. recipients*, or the
  mailbox's own value — storage `submissionLimitsForUser`, shared with JMAP, ActiveSync
  and MAPI) and never more than `MAIL_SEND_MAX_RECIPIENTS` (the request's upper bound).
  Otherwise: `400 { error, invalid? }`.
- `inReplyTo` may be a Message-ID or the internal id of the replied-to message.
  - An internal id is resolved within the mailboxes the caller can read. The
    headers then carry the parent's Message-ID and its References chain.
  - An internal id is never written into a header.
- `references` (9.0, optional): the client's References chain — an array of
  `<msg-id>` tokens or one space-separated string, at most 50, no CR/LF
  (`400` otherwise). It replaces the server-resolved chain; the resolved
  In-Reply-To is always its last entry. Without it the server chain is used.

## Admin exports

- CSV exports (audit log, message trace) prefix cells that start with
  `= + - @ TAB CR` with `'`. This prevents formula injection.
- `X-CoreMail-Signature` on audit-log exports is `hmac-sha256=<hex>`. It is an
  HMAC-SHA256 over the exact payload, with a key derived via HKDF-SHA256 from
  `JWT_SECRET` + `PEPPER` (info `audit-export`). Verifying it needs the server
  key; it was previously an unkeyed `sha256=` hash.
- v9.0: `AUDIT_EXPORT_SIGNING_KEY` (at least 32 characters) is an optional
  dedicated key. If set, it wins over the `JWT_SECRET` + `PEPPER` derivation, so
  rotating the JWT secret no longer touches export signatures. **Rotating the key
  in use (this variable, or `JWT_SECRET`/`PEPPER` without it) invalidates the
  signatures of all earlier exports.** Keep the old key if old exports must stay
  verifiable.
- v9.0: verification without the key in hand:
  `POST /api/v1/admin/audit-log/verify-export` (compliance area). The body is the
  exported file, byte-exact, as `application/octet-stream`. The signature goes in
  the `X-CoreMail-Signature` header (or `?signature=`). The answer is
  `{ valid, bytes, algorithm }`. CLI: `coremail audit verify <file> --signature <value>`.
- `GET /api/v1/admin/message-trace/export` requires the Authorization header.
  Fetch it with `fetch()` and download it as a blob. A `window.open()` cannot
  authenticate. Since 9.0 it honours `sender`, `recipient`, `subject` and
  `status` exactly like the list endpoint.

## Admin RBAC additions

- Mailbox delegation (`POST`/`DELETE /api/v1/admin/mailboxes/:id/delegates`)
  follows the same rule as modifying the account: an admin's mailbox can only be
  delegated by ORGANIZATION_MANAGEMENT.
- Admins other than ORGANIZATION_MANAGEMENT cannot grant themselves access.
- Grants and revocations are audited (`mailbox.delegate.grant` and
  `mailbox.delegate.revoke`) with the owner and grantee addresses.
- Backups: the following routes hand out or write mailbox content and are open
  to ORGANIZATION_MANAGEMENT and COMPLIANCE_MANAGEMENT only:
  - per-mailbox backup (`POST /backups/mailbox/:userId`)
  - downloads (`GET /backups/download/:jobId`, `GET /backups/archive/download`)
  - MBOX import (`POST /backups/import/:userId`)
- SERVER_MANAGEMENT keeps full backups, schedules and the job list.
- Downloads are recorded in the audit log.
- MBOX import (9.0): `POST /backups/import/:userId?folderId=<id>`, the body is
  forwarded to the backup-service as raw bytes (streamed, never decoded — so
  encrypted `.mbox.enc` backups and non-UTF-8 mailboxes arrive intact), capped
  by `BACKUP_IMPORT_MAX_BYTES`. The target folder list for the BCP picker comes
  from `GET /backups/users/:userId/folders`.
- "Sign out everywhere" (9.0): `POST /api/v1/admin/mailboxes/:id/revoke-sessions`
  replaces the removed `DELETE /auth/sessions/admin/:userId`. Area `recipients`
  (HELP_DESK included, USER accounts only); admin accounts only by
  ORGANIZATION_MANAGEMENT (`canManageAccount`). Ends all web/API sessions
  (`revokeAllSessions` → `publishUserAuthChange`), keeps app passwords, writes
  the audit entry `mailbox.sessions.revoke`.

### One permission map and `GET /api/v1/admin/me/permissions`

`lib/rbac.ts` holds the only role → permission maps the guards use:

- `ROLE_PERMISSIONS` (built from `AREA_MATRIX`): `read`/`write` per area,
  consulted by `requireArea()` and `requireAdmin()`.
- `ADMIN_ACTIONS` + `ROLE_ACTION_GRANTS`: narrow actions beyond read/write,
  consulted by the route guards (`hasAdminAction()`, `requireAction()`):

  | action              | area       | granted to                                                    |
  |---------------------|------------|---------------------------------------------------------------|
  | `resetPassword`     | recipients | write on recipients, HELP_DESK (USER accounts only)           |
  | `toggleActive`      | recipients | write on recipients, HELP_DESK (USER accounts only)           |
  | `revokeSessions`    | recipients | write on recipients, HELP_DESK (USER accounts only)           |
  | `backupMailboxData` | servers    | ORGANIZATION_MANAGEMENT, COMPLIANCE_MANAGEMENT (not SERVER_MANAGEMENT) |

`GET /api/v1/admin/me/permissions` (any admin role, current-role check and
forced admin MFA apply) returns
`{ role, areas: { <area>: 'read'|'write' }, actions: { <area>: AdminAction[] }, scope, mfaVerified }`
(9.5: `scope` = the admin's management scope — organisation-wide or a list of
domains; see [rbac.md](rbac.md)).
The BCP hides areas and actions from it (`usePermissions()`, `<Can>`);
`permissions.test.ts` proves that the guards of every admin router and the
action routes agree with both maps for every role.

`User.lastLoginAt` (8.x, nullable) is set on every successful login — web
password/MFA login and SSO (`issueSession`) and mail-protocol logins
(`verifyMailCredentials`) — at most once per user per 5 minutes and process
(`recordLastLogin()`, `@coremail/storage/auth`). The admin mailbox list and
detail return it.

## Proxied services

For every request proxied to an internal service (JMAP, ActiveSync, CalDAV,
Autodiscover, auth-service), the gateway removes client-supplied forwarding and
internal identity headers:

- `Forwarded`, `X-Forwarded-*`, `X-Real-IP`
- `X-Internal-*`, `X-CoreMail-*`, `X-User-*`, `X-Auth-*`

Exception (v9.0): `X-CoreMail-Client` with the value `web` and `X-CoreMail-App`
with `bcp` or `mwa` pass through, lower-cased. The auth-service needs them so
that `/auth/mfa/verify` sets the refresh token as cookie instead of returning it
in the body. Other values and every other `X-CoreMail-*` header are dropped.

It then sets the following from trusted values:

- `X-Forwarded-For`: the client IP, per `TRUST_PROXY`
- `X-Forwarded-Proto`: from the TLS socket, or from a trusted proxy
- `X-Forwarded-Host`: the `Host` header, or a forwarded host from a trusted proxy

## Connection limits and timeouts (10.5)

Port 3000 and the integrated HTTPS proxy (`HTTPS_PORT`, default 443) defend
against slow and connection-exhaustion attacks: slowloris (headers that never
finish), slow POST (a body that trickles in), idle keep-alive floods and TLS
connections that never complete the handshake. Implementation:
`packages/api-gateway/src/lib/http-hardening.ts`. All values are environment
variables of the `coremail` container; restart the container after a change.

| Variable | Default | Meaning |
|---|---|---|
| `HTTP_HEADERS_TIMEOUT_MS` | `20000` | The complete request headers must arrive within this time (Node `headersTimeout`, min. 1000). Also applies to a connection that sends nothing at all. Answered with `408` and closed. Always kept above `HTTP_KEEPALIVE_TIMEOUT_MS`. |
| `HTTP_REQUEST_TIMEOUT_MS` | `300000` (5 min) | The complete request (headers + body) must arrive within this time (Node `requestTimeout`; `0` = off; never below the headers timeout). Bounds only the **upload**, see below. |
| `HTTP_KEEPALIVE_TIMEOUT_MS` | `5000` | An idle keep-alive connection between two requests is closed after this time. |
| `HTTP_MAX_REQUESTS_PER_SOCKET` | `0` | Requests per keep-alive connection (`0` = unlimited). |
| `HTTP_CONNECTIONS_CHECK_INTERVAL_MS` | `5000` | How often the header/request deadlines are checked (a slow client is cut between the timeout and timeout + interval). |
| `HTTP_MAX_CONNS` | `4000` | Open connections of the gateway in total, HTTP and HTTPS together (`0` = off). |
| `HTTP_MAX_CONNS_PER_IP` | `300` | Open connections per client IP; IPv6 clients are counted per /64 prefix (`0` = off). |
| `HTTP_CONN_EXEMPT_CIDRS` | *(empty)* | Comma-separated IPs/CIDRs without the per-IP cap (the total still applies). Invalid entries are ignored and logged. |
| `HTTPS_HANDSHAKE_TIMEOUT_MS` | `10000` | TLS handshake of the HTTPS proxy (min. 1000); a client that connects and never sends a ClientHello is dropped after this time. |

Invalid values fall back to the default (logged at start); the effective values
are logged once as `HTTP connection hardening active`. The bundled Compose files
pass only the variables listed in the `coremail` service's `environment:`
block; to change one of these, add it there (e.g.
`HTTP_MAX_CONNS_PER_IP: ${HTTP_MAX_CONNS_PER_IP:-}`).

**Long-lived requests are not affected.** `requestTimeout` and
`headersTimeout` bound only *receiving* a request. Once the request is complete,
the response may take as long as it needs: SSE (`/api/v1/events`, heartbeat
every 25 s), ActiveSync `Ping` (up to 59 minutes without a byte), MAPI
`NotificationWait`, JMAP EventSource and CalDAV reports keep working. WebSocket
upgrades (JMAP `/jmap/ws`) leave the HTTP parser after the `101`, so no HTTP
timeout applies to them. There is deliberately no socket inactivity timeout
(`server.timeout` stays `0`): a silent Ping must not be cut.

**Uploads.** The request timeout is a ceiling for the slowest legitimate upload.
The largest bodies are a backup import (`BACKUP_IMPORT_MAX_BYTES`, 500 MiB), an
ActiveSync `SendMail` with attachments and a webmail send. 5 minutes is Node's
own default, so 10.5 does not shorten it; a 500 MiB import then needs about
14 Mbit/s upstream. Raise `HTTP_REQUEST_TIMEOUT_MS` for larger imports over slow
links. The time a slow-POST client can hold a slot is bounded by this value, the
number of slots by the caps below.

**Connection caps.** A connection is counted on the raw TCP socket, for HTTPS
before the TLS handshake. Over the per-IP or the total cap, port 3000 answers a
minimal `503 Service Unavailable` (`Retry-After: 10`, `Connection: close`; the
request never reaches the application), the HTTPS proxy drops the TCP
connection before the handshake. Refusals are logged as `HTTP connection
refused — connection limit reached` at most once per minute per client key and
reason (with the number of suppressed refusals). Loopback (container
healthcheck, in-container CLI) bypasses both caps.

**Sizing (defaults).** Every ActiveSync phone keeps one Ping open, every browser
one SSE stream plus up to six short keep-alive connections while loading. 500
users with two devices and a browser each need about 1500–2500 concurrent
connections, hence `HTTP_MAX_CONNS=4000`. `HTTP_MAX_CONNS_PER_IP=300` leaves room
for an office of about 50 users behind one NAT address; list larger offices in
`HTTP_CONN_EXEMPT_CIDRS` (e.g. `HTTP_CONN_EXEMPT_CIDRS=203.0.113.10,198.51.100.0/28`).

**Behind a reverse proxy (`TRUST_PROXY`).** On port 3000 the socket peer of
every request is then the proxy, so the per-IP cap would count all clients as
one. A peer that `TRUST_PROXY` trusts is therefore **not** subject to the per-IP
cap on port 3000 (the total cap still applies); enforce per-client connection
limits on the proxy itself (e.g. nginx `limit_conn`, Traefik `inFlightReq`).
With `TRUST_PROXY=true` or a hop count every peer is trusted, i.e. the per-IP
cap on port 3000 is off; prefer a list of proxy addresses
(`TRUST_PROXY=10.0.0.5`). The HTTPS proxy never trusts forwarding headers, so
its per-IP cap always applies. If Docker's userland proxy hides client
addresses (all clients appear as the bridge gateway, e.g. `172.18.0.1`, typical
for IPv6 clients into an IPv4-only container), list that address in
`HTTP_CONN_EXEMPT_CIDRS`.
