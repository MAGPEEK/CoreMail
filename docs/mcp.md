# Admin MCP interface (`/mcp`)

Since 10.3 administrators can manage a CoreMail server with any client that speaks the
**Model Context Protocol** (MCP, revision `2025-06-18`, Streamable HTTP transport). The
interface is **off by default**. Every tool runs as the admin who owns the token — with that
admin's current role and management scope — through the same admin API the BCP uses.

## Setup

1. **Switch it on** — BCP → *Infrastruktur* → *KI-Schnittstelle (MCP)* → *MCP-Endpunkt
   aktivieren* (needs write access to the servers area: SERVER_MANAGEMENT or
   ORGANIZATION_MANAGEMENT). Off → `/mcp` answers `404` like any unknown path and every open MCP
   session ends at once (all gateway instances, via `CHANNEL_SETTINGS_RELOAD {type:'mcp'}`).
2. *(optional)* **Restrict the client IPs** — one IP address or CIDR range per line
   (`192.0.2.10`, `10.0.0.0/8`, `2001:db8::/32`; at most 100). Empty = every address. Other
   addresses get `404`. The client IP is `req.ip`, so behind a reverse proxy set `TRUST_PROXY`
   (see [api-gateway-security.md](api-gateway-security.md)).
3. **Create a token** on the same page: name, rights (*Nur lesen* = `read`, *Lesen und ändern* =
   `write`) and validity (30 / 90 / 180 / 365 days; the API accepts 1–365, default 90). The token
   is shown **once** — copy it into the client configuration.
4. **Configure the client** with the endpoint URL (shown on the page, e.g.
   `https://mail.example.com/mcp`) and the token as a bearer header. Generic example (the exact
   structure and file depend on the client):

```json
{
  "mcpServers": {
    "coremail": {
      "type": "http",
      "url": "https://mail.example.com/mcp",
      "headers": { "Authorization": "Bearer cm_mcp_…" }
    }
  }
}
```

The endpoint is served by the api-gateway on its HTTP port and through the integrated HTTPS
proxy (443). Use HTTPS — the token is a bearer credential.

## Tokens

| Property | Value |
|---|---|
| Format | `cm_mcp_` + 43 base64url characters (32 random bytes) |
| Stored | `McpToken` (`mcp_tokens`): sha256 of the token only, the first 13 characters as display prefix, name, mode, expiry, last use (time + IP), creation, revocation (time + reason) |
| Modes | `read` — only read tools are listed and callable; `write` — read and write tools (only for roles that can change anything; VIEW_ONLY_ORG gets read tokens only) |
| Expiry | required, 1–365 days (default 90) |
| Limit | 20 active tokens per admin |
| Who | every admin role creates and revokes its **own** tokens; ORGANIZATION_MANAGEMENT sees (`?all=true`) and revokes every token |
| 2FA | created through the admin guard: with `requireMfaForAdmins` on, only from an MFA-verified session; the token remembers it — switching `requireMfaForAdmins` on later stops tokens created without MFA (`403 MFA_NOT_VERIFIED`) |

A token stops working immediately when it

- expires or is revoked (owner or ORGANIZATION_MANAGEMENT; its MCP sessions end on every
  gateway instance);
- belongs to an admin whose sessions are revoked: role change, deactivation, deletion, password
  reset or change, *sign out everywhere*, LDAP sync deactivation — `revokeAllSessions()`
  (`@coremail/storage/auth`) revokes the admin's MCP tokens in the same step and the live MCP
  sessions end through the `LiveConnectionRegistry` (protocol `mcp`);
- belongs to an account that is no longer an active admin (checked on every request with the
  current role from the database, independent of any event), or was created before a
  "revoke all" mark of the account (shared Redis marks — covers a failed database update).

Admin API (BCP): `GET/PUT /api/v1/admin/mcp/settings`, `GET/POST /api/v1/admin/mcp/tokens`,
`DELETE /api/v1/admin/mcp/tokens/:id` — scope decisions in [rbac.md](rbac.md).

## Protocol

- `POST /mcp` — one JSON-RPC 2.0 message per request (no batches). Requests get one
  `application/json` response; notifications and client responses get `202`.
- `initialize` opens a session: the response carries `Mcp-Session-Id`. Every later request needs
  that header (`400` without, `404` for an unknown, ended or foreign session — a session belongs
  to the token that created it; idle timeout `MCP_SESSION_IDLE_MINUTES`, default 30).
- `MCP-Protocol-Version`: `2025-06-18` and `2025-03-26` are accepted (absent = `2025-03-26`, per
  the transport spec); anything else → `400`.
- `DELETE /mcp` with `Mcp-Session-Id` ends the session (`204`). `GET /mcp` → `405` — the server
  sends no server-initiated messages (capability `tools` with `listChanged: false` only).
- Methods: `initialize`, `ping`, `tools/list`, `tools/call`; anything else → `-32601`.

### Authorization

MCP authorization (OAuth 2.1) is optional for HTTP servers; CoreMail does not run an
authorization server and publishes no OAuth metadata. The endpoint accepts only the personal MCP
tokens above as `Authorization: Bearer`. A request without or with an invalid token gets `401`
with `WWW-Authenticate: Bearer realm="CoreMail MCP"` (`error="invalid_token"` when a token was
sent).

## Tools (v1)

Read tools (also for read tokens):

| Tool | What | Admin route(s) |
|---|---|---|
| `server_status` | version and start time; with servers read: service health, storage driver | `GET /dashboard/version`, `GET /servers/health` |
| `list_domains` | domains, search, paging | `GET /domains` |
| `domain_dns_check` | DNS records of a domain (by name or id), found vs. expected | `GET /domains/:id/dns-check` |
| `list_mailboxes` | user mailboxes; filter text / domain / role / active; paging | `GET /mailboxes` |
| `get_mailbox` | one mailbox (address or id) with quota levels, folders, aliases | `GET /mailboxes/:id`, `GET /mailboxes/:id/aliases` |
| `list_aliases` | all aliases or those of one (shared) mailbox | `GET /aliases`, `GET /(shared-)mailboxes/:id/aliases` |
| `protocol_access` | protocol switches of the server, a domain or a mailbox | `GET /protocol-access[/domains/:id \| /users/:id]` |
| `queue_status` | outbound queue counts and the newest failed jobs | `GET /queues/stats`, `GET /queues/jobs?state=failed` |
| `message_trace_search` | mail-flow log by sender / recipient / subject / status / time | `GET /message-trace` |
| `message_trace_detail` | one mail-flow entry with stages, related entries, path | `GET /message-trace/:id` |
| `list_certificates` | TLS certificates (never key material) | `GET /certificates` |
| `audit_log_search` | audit entries by action / actor / target / text / success / time | `GET /audit-log` |

Write tools (write tokens):

| Tool | What | Admin route(s) |
|---|---|---|
| `create_mailbox` | new user mailbox; without `password` a random 32-character initial password is generated and returned once (`initialPassword`) | `POST /mailboxes` |
| `update_mailbox` | display name, quota, active state, role (only the given fields) | `PUT /mailboxes/:id` |
| `add_alias` / `remove_alias` | alias of a user or shared mailbox | `POST /(shared-)mailboxes/:id/aliases`, `DELETE /aliases/:id` |
| `set_quota` | quota with optional warning / prohibit-send levels | `PUT /mailboxes/:id` |
| `set_protocol_access` | protocol switches of the server, a domain or a mailbox | `PUT /protocol-access[...]` |
| `create_domain` | new hosted domain (DKIM key generated) | `POST /domains` |
| `sender_list_add` / `sender_list_remove` | block / allow entries (GLOBAL, DOMAIN, USER) | `POST/DELETE /security/sender-lists[/:id]` |
| `assign_retention_policy` | policy (name or id) → all mailboxes, a domain or a mailbox | `POST /compliance/retention/:id/assignments` |

There is no tool that deletes a mailbox or a domain, reveals a password, or returns keys or
secrets (DKIM / certificate private keys, TOTP, token hashes).

`tools/list` contains only the tools the token's mode and the admin's role can use at all (e.g.
no certificates for a domain-scoped admin, no `create_domain` below ORGANIZATION_MANAGEMENT);
calling an unlisted tool answers `-32602 Unknown tool`. Invalid arguments and refusals of the
admin route come back as a tool result with `isError: true` and the route's message, so the
client can correct itself.

## Security model

- **No second implementation.** Every tool runs the existing `/api/v1/admin/*` routers in-process
  (`lib/mcp/dispatch.ts`) with the token's admin as `req.apiUser` — exactly what `requireAuth`
  sets for a BCP session. The admin guards re-read the current role and management scope from the
  database, enforce forced 2FA, and the routes apply their own validation, escalation guards
  (`canAssignRole`, `canManageAccount`), scope filters (out-of-scope ids answer like unknown ids)
  and the redaction of other domains' addresses — identical to the BCP. The internal app is never
  bound to a socket. A read token cannot reach a mutating route even through a tool (defence in
  depth in the dispatcher).
- **Results** are filtered for secret fields at any depth (passwords, hashes, private keys, TOTP,
  backup codes, tokens) and capped at `MCP_MAX_RESULT_KB` (default 256 KiB; lists are shortened
  and marked `truncated`).
- **Audit.** Every tool call writes `mcp.tool.<name>` (actor = the admin, target, client IP and
  user agent, `changes.tokenId` / `tokenName` / `mode` / arguments with every password replaced by
  `[redacted]`, success or the error). Token and switch changes write `mcp.token.create`,
  `mcp.token.revoke`, `mcp.settings.update`. `mcp.*` is always audited, even with the audit
  toggle off. The admin routes write their own entries as for the BCP (e.g. `user.role.change`).
- **Limits.** Tool calls per token: `MCP_RATE_LIMIT_PER_MINUTE` (default 60, `429` +
  `Retry-After`). Request body: `MCP_MAX_BODY_KB` (default 64 KiB, `413`). Unknown or malformed
  tokens count as failed logins of the client IP in the shared mail/web lockout
  (`MAIL_AUTH_IP_*`; a locked IP gets `429`); the global API limiter counts MCP requests per
  token.
- **DNS rebinding.** A request with an `Origin` header is accepted only when the origin's host is
  the public host name (BCP → server settings) or listed in `MCP_ALLOWED_ORIGINS` (comma
  separated origins); otherwise `403`. Requests without `Origin` (non-browser clients) pass. The
  endpoint sends no CORS headers, so browser pages of other origins cannot call it at all.
- **Order of checks:** switch → IP allowlist (both `404`) → Origin (`403`) → IP lockout (`429`) →
  token (`401` / `403` MFA) → session / protocol.

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `MCP_RATE_LIMIT_PER_MINUTE` | 60 | tool calls per token and minute (0 = off) |
| `MCP_MAX_BODY_KB` | 64 | request body limit |
| `MCP_MAX_RESULT_KB` | 256 | tool result size cap |
| `MCP_SESSION_IDLE_MINUTES` | 30 | idle timeout of an MCP session |
| `MCP_ALLOWED_ORIGINS` | — | extra browser origins allowed besides the public host name |

## Implementation

- api-gateway `lib/mcp/`: `handler.ts` (endpoint, checks, JSON-RPC), `protocol.ts` (framing,
  versions), `tokens.ts` (create / verify / revoke), `sessions.ts` (sessions + live
  connections), `settings.ts` (switch, allowlist cache, reload), `net.ts` (allowlist, Origin),
  `dispatch.ts` (in-process admin routes), `tools.ts` (tool catalogue), `result.ts` (secret
  filter, size cap, audit arguments); `routes/admin/mcp.ts` (BCP API).
- storage `auth/mcp-tokens.ts` (format, hash, `revokeMcpTokensOfUser`), called by
  `revokeAllSessions()`; schema `McpToken`, `ServerSettings.mcpEnabled` / `mcpAllowedIps`.
- BCP `pages/McpPage.tsx`, `lib/mcp.ts`.
- Tests: `api-gateway/src/routes/mcp.test.ts` (switch, tokens, auth + lockout, full handshake,
  read tokens, scope + redaction, Origin, allowlist, rate limit, 2FA, audit, revocation / expiry
  / role loss), `src/lib/mcp/mcp-lib.test.ts`, `admin-panel/src/lib/mcp.test.ts`, storage
  `auth/auth.test.ts` (revocation with "revoke all").

## Known limits

- MCP sessions live in the gateway process (the chart runs one replica). With several gateway
  instances behind a load balancer without stickiness a client re-initializes when it reaches
  another instance; tokens, switch and revocations apply on every instance.
- No server-initiated messages (no SSE stream), no resources or prompts — tools only.
