# api-gateway security behaviour

Settings and contracts of the api-gateway hardening (8.0.x OWASP wave). All
switches are environment variables of the `coremail` container; the defaults
are the secure choice.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `HTTP_REDIRECT_HTTPS` | `true` | Plain-HTTP requests get `308` to `https://…` while the integrated HTTPS proxy serves a certificate marked "active for HTTPS". `false` disables it. |
| `MAIL_SEND_RATE_LIMIT` | `30` | Messages per user and window via `POST /api/v1/mail/send` (`0` = off). Over the limit: `429` + `Retry-After`. |
| `MAIL_SEND_RATE_WINDOW_SEC` | `60` | Window of the send rate limit. |
| `MAIL_SEND_MAX_RECIPIENTS` | `500` | Max. recipients (to + cc + bcc) per message. |
| `IMAGE_PROXY_RATE_LIMIT` | `120` | Image proxy requests per user and window (`0` = off). |
| `IMAGE_PROXY_RATE_WINDOW_SEC` | `60` | Window of the image proxy limit. |

The rate limits count in Redis (`ratelimit:<scope>:<userId>:<window>`), so they
hold across restarts. If Redis does not answer within 500 ms, an in-process
counter takes over.

## HTTP → HTTPS redirect and HSTS

- The redirect applies once the integrated HTTPS proxy is listening and at least
  one served certificate has `isActiveHttps` (BCP → SSL/TLS → lock icon).
- Target host: the requested host if a served certificate covers it, otherwise
  `ServerSettings.publicHostname`. Client-supplied hosts are never echoed, so
  there is no open redirect. Non-443 `HTTPS_PORT` values are added to the URL.
- Exempt: `/.well-known/acme-challenge/*`, `/healthz`, `/livez`, loopback peers
  (checked on the raw socket address), and requests that are already HTTPS.
  A request counts as HTTPS if it came in on the TLS socket, or if it carries
  `X-Forwarded-Proto: https` from a proxy trusted by `TRUST_PROXY`.
- External TLS terminator (Traefik, Caddy, DSM) in front of port 3000: set
  `TRUST_PROXY` so its `X-Forwarded-Proto` is honoured. If you cannot set it,
  set `HTTP_REDIRECT_HTTPS=false`. The redirect only applies when the integrated
  proxy has an active HTTPS certificate.
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
  including reconnects, because a ticket cannot be reused.

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

## Admin exports

- CSV exports (audit log, message trace) prefix cells that start with
  `= + - @ TAB CR` with `'`. This prevents formula injection.
- `X-CoreMail-Signature` on audit-log exports is `hmac-sha256=<hex>`. It is an
  HMAC-SHA256 over the exact payload, with a key derived via HKDF-SHA256 from
  `JWT_SECRET` + `PEPPER` (info `audit-export`). Verifying it needs the server
  key; it was previously an unkeyed `sha256=` hash.
- `GET /api/v1/admin/message-trace/export` requires the Authorization header.
  Fetch it with `fetch()` and download it as a blob. A `window.open()` cannot
  authenticate.

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

## Proxied services

For every request proxied to an internal service (JMAP, ActiveSync, CalDAV,
Autodiscover, auth-service), the gateway removes client-supplied forwarding and
internal identity headers:

- `Forwarded`, `X-Forwarded-*`, `X-Real-IP`
- `X-Internal-*`, `X-CoreMail-*`, `X-User-*`, `X-Auth-*`

It then sets the following from trusted values:

- `X-Forwarded-For`: the client IP, per `TRUST_PROXY`
- `X-Forwarded-Proto`: from the TLS socket, or from a trusted proxy
- `X-Forwarded-Host`: the `Host` header, or a forwarded host from a trusted proxy
