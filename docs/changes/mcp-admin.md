### Added

- **Admin MCP interface** (`/mcp`, Model Context Protocol 2025-06-18, Streamable HTTP): administrators
  manage the server with an MCP client. Off by default — BCP → Infrastruktur → *KI-Schnittstelle (MCP)*
  (switch + optional client IP allowlist: servers write; off → `404` and every open MCP session ends at
  once). Docs: `docs/mcp.md`.
- **Personal MCP tokens** (`cm_mcp_…`, 32 random bytes, stored as sha256 only, shown once): every admin
  role manages its own tokens (`read` / `write`, expiry 1–365 days, default 90); ORGANIZATION_MANAGEMENT
  sees and revokes all. Created through the admin guard (forced 2FA respected and remembered). A token
  stops working on expiry, revocation, and every "revoke all sessions" of its owner (role change,
  deactivation, deletion, password reset / change, sign out everywhere) — `revokeAllSessions()` revokes
  the tokens and live MCP sessions end (`LiveConnectionRegistry`, protocol `mcp`).
- **22 tools (v1)**: read — `server_status`, `list_domains`, `domain_dns_check`, `list_mailboxes`,
  `get_mailbox`, `list_aliases`, `protocol_access`, `queue_status`, `message_trace_search`,
  `message_trace_detail`, `list_certificates`, `audit_log_search`; write — `create_mailbox`,
  `update_mailbox`, `add_alias`, `remove_alias`, `set_quota`, `set_protocol_access`, `create_domain`,
  `sender_list_add`, `sender_list_remove`, `assign_retention_policy`. Every tool runs the existing admin
  routes in-process as the token's admin (current role, management scope, redaction unchanged); no
  deletion of mailboxes or domains, no passwords or keys in any result.
- Admin API `GET/PUT /api/v1/admin/mcp/settings`, `GET/POST /api/v1/admin/mcp/tokens`,
  `DELETE /api/v1/admin/mcp/tokens/:id` (scope decisions in `docs/rbac.md`).
- Audit entries `mcp.tool.<name>` (token id, arguments with passwords redacted, success / error),
  `mcp.token.create`, `mcp.token.revoke`, `mcp.settings.update` — always written, even with the audit
  toggle off.
- Limits: tool calls per token (`MCP_RATE_LIMIT_PER_MINUTE`, default 60), request body
  (`MCP_MAX_BODY_KB`, 64), result size (`MCP_MAX_RESULT_KB`, 256), session idle timeout
  (`MCP_SESSION_IDLE_MINUTES`, 30); Origin check against the public host name (`MCP_ALLOWED_ORIGINS`
  for extra origins); unknown tokens count against the client IP in the shared login lockout.
- Schema (additive): table `mcp_tokens` (`McpToken`), `ServerSettings.mcpEnabled` (default false) and
  `ServerSettings.mcpAllowedIps` (default empty).
