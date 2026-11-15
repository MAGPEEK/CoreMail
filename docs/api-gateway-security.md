# api-gateway security behaviour

Settings and contracts of the api-gateway hardening (8.0.x OWASP wave). All
switches are environment variables of the `coremail` container; the defaults
are the secure choice.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `HTTP_REDIRECT_HTTPS` | `true` | Plain-HTTP requests get `308` to `https://…` while the integrated HTTPS proxy serves a certificate marked "active for HTTPS". `false` disables it. |
| `HTTPS_PUBLIC_PORT` | `443` | Port in the redirect URL (v8.1): the port clients reach, e.g. `8443` for a `8443:443` mapping. |
| `AUDIT_EXPORT_SIGNING_KEY` | — | Optional dedicated key (≥ 32 characters) for audit export signatures (v8.1). Rotating it invalidates old signatures. |
| `MAIL_SEND_RATE_LIMIT` | `30` | Messages per user and window via `POST /api/v1/mail/send` (`0` = off). Over the limit: `429` + `Retry-After`. |
| `MAIL_SEND_RATE_WINDOW_SEC` | `60` | Window of the send rate limit. |
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
  `8443:8443` set `HTTPS_PUBLIC_PORT=8443` as well (before v8.1 the listener
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
  including reconnects, because a ticket cannot be reused. Since 8.1 the MWA
  (`useMailEvents`) and the BCP dashboard do exactly that
  (`lib/reconnectingEventSource.ts`, ticket request through the API client, one
  refresh on a 401); neither puts the access token into a URL any more.

## Auth rate limits and error codes (v8.1)

- Login, password reset and `/auth/mfa/*` (non-GET) share the strict limiter:
  20 requests per 15 minutes per IP.
- `POST /auth/refresh` and `/auth/logout` have their own limiter: 300 **failed**
  requests per 15 minutes per IP (successful refreshes are not counted). The
  access token lives in memory, so every page load and every new tab refreshes.
  Before v8.1 these refreshes used up the login budget and users got `429`.
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

`POST /auth/sso/exchange` answers like `POST /auth/login` (8.1): browser
clients (`X-CoreMail-Client: web`, BCP additionally `X-CoreMail-App: bcp`) get
the refresh token only as the HttpOnly cookie `cm_rt` / `cm_rt_bcp`, the body
carries `{ accessToken, expiresIn }`. Other clients still get the full pair.

## Password reset token check

`POST /auth/reset-password/verify { token }` → `{ valid }` (8.1). The token
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
  can be at most `MAIL_SEND_MAX_RECIPIENTS` of them. Otherwise:
  `400 { error, invalid? }`.
- `inReplyTo` may be a Message-ID or the internal id of the replied-to message.
  - An internal id is resolved within the mailboxes the caller can read. The
    headers then carry the parent's Message-ID and its References chain.
  - An internal id is never written into a header.
- `references` (8.1, optional): the client's References chain — an array of
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
- v8.1: `AUDIT_EXPORT_SIGNING_KEY` (at least 32 characters) is an optional
  dedicated key. If set, it wins over the `JWT_SECRET` + `PEPPER` derivation, so
  rotating the JWT secret no longer touches export signatures. **Rotating the key
  in use (this variable, or `JWT_SECRET`/`PEPPER` without it) invalidates the
  signatures of all earlier exports.** Keep the old key if old exports must stay
  verifiable.
- v8.1: verification without the key in hand:
  `POST /api/v1/admin/audit-log/verify-export` (compliance area). The body is the
  exported file, byte-exact, as `application/octet-stream`. The signature goes in
  the `X-CoreMail-Signature` header (or `?signature=`). The answer is
  `{ valid, bytes, algorithm }`. CLI: `coremail audit verify <file> --signature <value>`.
- `GET /api/v1/admin/message-trace/export` requires the Authorization header.
  Fetch it with `fetch()` and download it as a blob. A `window.open()` cannot
  authenticate. Since 8.1 it honours `sender`, `recipient`, `subject` and
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
- MBOX import (8.1): `POST /backups/import/:userId?folderId=<id>`, the body is
  forwarded to the backup-service as raw bytes (streamed, never decoded — so
  encrypted `.mbox.enc` backups and non-UTF-8 mailboxes arrive intact), capped
  by `BACKUP_IMPORT_MAX_BYTES`. The target folder list for the BCP picker comes
  from `GET /backups/users/:userId/folders`.
- "Sign out everywhere" (8.1): `POST /api/v1/admin/mailboxes/:id/revoke-sessions`
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
`{ role, areas: { <area>: 'read'|'write' }, actions: { <area>: AdminAction[] }, mfaVerified }`.
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

Exception (v8.1): `X-CoreMail-Client` with the value `web` and `X-CoreMail-App`
with `bcp` or `mwa` pass through, lower-cased. The auth-service needs them so
that `/auth/mfa/verify` sets the refresh token as cookie instead of returning it
in the body. Other values and every other `X-CoreMail-*` header are dropped.

It then sets the following from trusted values:

- `X-Forwarded-For`: the client IP, per `TRUST_PROXY`
- `X-Forwarded-Proto`: from the TLS socket, or from a trusted proxy
- `X-Forwarded-Host`: the `Host` header, or a forwarded host from a trusted proxy
