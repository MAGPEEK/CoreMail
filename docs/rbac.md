# Admin roles and management scopes (RBAC)

CoreMail's admin API (`/api/v1/admin/*`) and the BCP are guarded by **roles**
(enum `UserRole`) mapped to **areas**. Since 9.5 a role assignment can also be
limited to one or more **domains** — a *management scope* (for example a help
desk admin for `a.example` only).

Code: `packages/api-gateway/src/lib/rbac.ts` (role → area → action maps),
`lib/admin-scope.ts` (scope rules, pure), `middleware/admin-scope.ts` (scope
guards), `middleware/auth.ts` (`requireArea` / `requireAction` / `requireRole` /
`requireAdmin`). BCP: `packages/admin-panel/src/lib/permissions.ts`,
`hooks/usePermissions.ts`, `pages/RbacPage.tsx`.

## Roles and areas

| Area           | write                 | read (GET/HEAD)                                          |
|----------------|-----------------------|----------------------------------------------------------|
| `dashboard`    | —                     | every admin role                                         |
| `organisation` | —                     | SERVER_MANAGEMENT, VIEW_ONLY_ORG                         |
| `identity`     | —                     | VIEW_ONLY_ORG                                            |
| `servers`      | SERVER_MANAGEMENT     | VIEW_ONLY_ORG                                            |
| `recipients`   | RECIPIENT_MANAGEMENT  | HELP_DESK, VIEW_ONLY_ORG                                 |
| `domains`      | —                     | RECIPIENT_MANAGEMENT, SERVER_MANAGEMENT, VIEW_ONLY_ORG   |
| `hygiene`      | HYGIENE_MANAGEMENT    | VIEW_ONLY_ORG                                            |
| `compliance`   | COMPLIANCE_MANAGEMENT | —                                                        |

ORGANIZATION_MANAGEMENT has write on every area. Narrow actions (HELP_DESK
password reset / enable-disable / sign-out of USER accounts,
`backupMailboxData`) are listed in `lib/rbac.ts` (`ADMIN_ACTIONS`). Only
ORGANIZATION_MANAGEMENT assigns roles and changes admin accounts
(`canAssignRole`, `canManageAccount`).

## Management scopes (9.5)

### Model

- Table `admin_scopes` (Prisma `AdminScope`): one row per admin and domain,
  `@@unique([userId, domainId])`. Additive schema change.
- **No rows = organisation-wide** — every admin of a pre-9.5 installation keeps
  its access unchanged.
- ORGANIZATION_MANAGEMENT is always organisation-wide (rows are ignored).
- Scopable roles: HELP_DESK, RECIPIENT_MANAGEMENT, COMPLIANCE_MANAGEMENT,
  HYGIENE_MANAGEMENT, VIEW_ONLY_ORG. SERVER_MANAGEMENT works only on
  server-wide areas, a scope would leave it nothing to write; it is refused
  (`400 ROLE_NOT_SCOPABLE`). An account whose role changes keeps its rows; they
  only ever restrict (a scoped SERVER_MANAGEMENT keeps the dashboard and the
  domains of its scope).
- A user's rows are deleted with the user. A domain that still scopes an admin
  cannot be deleted (`409 DOMAIN_SCOPES_ADMINS`, FK `Restrict`): a vanished last
  row would silently widen the admin to the whole organisation.

### What a scoped admin can do

1. **Server-wide areas are closed**: `organisation`, `identity`, `servers`
   (`UNSCOPED_ONLY_AREAS`). This covers services, certificates, storage, server
   and global settings, branding, LDAP/SSO, queues, system logs, connectors,
   SMTP configuration, backups (also the per-mailbox `backupMailboxData`
   action), the server level of protocol access and webmail policies. The
   guards refuse with `403 FORBIDDEN_ROLE`, also through narrow `extra`
   predicates of `requireArea`; `requireRole()` never passes.
2. **Server-wide routes of the other areas** answer `403 SCOPE_ORG_ONLY`
   (`requireUnscoped`), see the route table.
3. **Lists** contain only objects of the scope's domains.
4. **An object of another domain addressed by id → `404 {"error":"Not found"}`**
   — the same status and body as an unknown id. The scope check runs before the
   handler (`router.param` / `requireInScope`), so there is no existence oracle.
5. **A write that would place something in another domain → `403 OUT_OF_SCOPE`**
   (create a mailbox / shared mailbox / resource with a domain or address of
   another domain, an alias address in another domain, a GLOBAL or other-domain
   sender-list entry). Domain names are public DNS facts, so this reveals
   nothing; the 404 rule applies to object ids.
6. Domains are never moved: no admin route changes the `domainId` of an
   existing mailbox, shared mailbox, resource or alias, and a domain with
   mailboxes cannot be renamed (existing rule).

The admin guard reads the scope from the database together with the current
role (cached 15 s per user, dropped on every auth invalidation event of the
user) and puts it on `req.apiUser.adminScope` — never from the token.
`scopeOf(req)` fails closed: a request without a resolved scope sees nothing.

### Escalation rules

- Only ORGANIZATION_MANAGEMENT assigns or clears scopes
  (`scopeAssignmentError`). It is organisation-wide itself, so no admin can hand
  out a role or scope beyond its own; nobody can widen its own scope.
- Scoped admins cannot change, reset, sign out or delete admin accounts
  (`canManageAccount`: admin accounts are ORGANIZATION_MANAGEMENT-only), so an
  organisation-wide admin account inside their domain is out of reach too.
- Scoped admins create USER accounts only (`canAssignRole`).
- Delegations and shared-mailbox permissions: the grantee must be inside the
  scope as well (`404 Grantee not found` / `User not found`).

### API

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/api/v1/admin/me/permissions` | every admin | `{ role, areas, actions, scope, mfaVerified }` — `scope` = `{ kind: 'organisation' }` or `{ kind: 'domains', domains: [{ id, name }] }`; areas / actions without the server-wide ones for scoped admins |
| GET | `/api/v1/admin/organisation/role-assignments` | organisation readers | every account with `role` and `scope` |
| PUT | `/api/v1/admin/organisation/role-assignments/:id/scope` | ORGANIZATION_MANAGEMENT | body `{ domainIds: string[] }` (`[]` = organisation-wide); `400 ROLE_NOT_SCOPABLE` / `UNKNOWN_DOMAIN`; answers `{ id, role, scope, changed }` |

A scope change is audited as `user.role.scope` (always logged, also with the
audit log switched off; `changes: { role, before: { domains }, after: { domains } }`)
and revokes the admin's web/API sessions like a role change
(`revokeAllSessions(id, { reason: 'scope-change' })` → `publishUserAuthChange`;
mail-protocol logins are not affected).

CLI (`packages/cli`, docs/cli.md): `coremail role list [--admins]`,
`coremail role set <user> <ROLE>`, `coremail role scope <user> <domain...>`,
`coremail role scope <user> --organisation`, `coremail role me`.

### BCP

- `GET /admin/me/permissions` → `usePermissions().scope` / `.scoped`.
- Sidebar and 403 page: the organisation-wide pages of otherwise reachable
  areas (`transport-rules`, `retention`) are hidden for scoped admins
  (`UNSCOPED_ONLY_PATHS`); server-wide areas are absent from `areas` anyway.
- Protection page: a scoped admin sees only the sender lists; the audit-log
  statistics are not loaded.
- Domain pickers (mailbox / shared-mailbox dialogs) list `/admin/domains`,
  which the API already limits to the scope.
- RBAC page: a "Verwaltungsbereich" column; ORGANIZATION_MANAGEMENT edits the
  domains of scopable admin accounts (confirmation: the account's web sessions
  end).

## Route decisions

Legend: **filter** = list limited to the scope · **404** = object outside the
scope answers like an unknown id · **OUT_OF_SCOPE** = 403 for a target domain
outside the scope · **org** = organisation-wide admins only (403
`SCOPE_ORG_ONLY`, or `FORBIDDEN_ROLE` through the area) · **role** = the role
matrix already limits the route to ORGANIZATION_MANAGEMENT (never scoped) ·
**unchanged** = not bound to a domain, same for scoped admins.

### recipients

| Route | Decision |
|---|---|
| `GET /mailboxes` | filter (domainId) |
| `GET /mailboxes/quota-defaults` | unchanged (server default percentages, read only) |
| `PUT /mailboxes/quota-defaults`, `POST /mailboxes/recalculate-all-quotas`, `POST /mailboxes/bulk-provision` | org |
| `POST /mailboxes` | OUT_OF_SCOPE unless `domainId` is in the scope (the address must match the domain — existing rule); role ≠ USER → `FORBIDDEN_ROLE` |
| `GET/PUT/DELETE /mailboxes/:id`, `POST /:id/recoverable/purge`, `/:id/recalculate-quota`, `/:id/revoke-sessions`, `/:id/provision`, `GET/PUT /:id/mail-flow`, `GET/POST /:id/delegates`, `DELETE /:id/delegates/:granteeId` | 404 (`router.param('id')`); delegate grantee outside → 404 `Grantee not found`; admin accounts → `FORBIDDEN_ROLE` |
| `GET /shared-mailboxes` | filter |
| `POST /shared-mailboxes` | OUT_OF_SCOPE (domainId) |
| `GET/PUT/DELETE /shared-mailboxes/:id`, `/:id/provision`, `/:id/mail-flow`, `/:id/permissions…` | 404; permission grantee outside → 404 `User not found` |
| `GET /resources` | filter |
| `POST /resources` | OUT_OF_SCOPE (domainId and the address's domain) |
| `GET/PUT/DELETE /resources/:id`, `GET /:id/bookings`, `DELETE /:id/bookings/:bookingId` | 404; a booking must belong to the resource of the path (was not checked before 9.5) |
| `GET /resources/freebusy/query?email=` | 404 for a resource outside the scope |
| `GET /aliases` | filter (alias domain and target domain) |
| `GET/POST /mailboxes/:id/aliases`, `GET/POST /shared-mailboxes/:id/aliases` | 404 for the owner; alias address in another domain → OUT_OF_SCOPE; list filtered |
| `PATCH/DELETE /aliases/:aliasId` | 404 unless alias domain and target are in the scope |
| `GET /mobile/devices` | filter (device user's domain) |
| `GET /mobile/devices/:id`, `PATCH /:id/status`, `POST /:id/wipe`, `DELETE /:id` | 404 |
| `GET/PUT /protocol-access/users/:id`, `GET/PUT /webmail-policies/users/:id` | 404 |
| `/ems/mailboxes…`, `/ems/mailbox-statistics`, `/ems/resource-mailboxes` | org (cmdlet bridge addresses objects organisation-wide) |

### domains

| Route | Decision |
|---|---|
| `GET /domains` | filter (count and list) |
| `GET /domains/:id`, `/:id/dkim-record`, `/:id/dns-check` | 404 |
| `POST /domains`, `PUT/DELETE /domains/:id`, `PATCH /:id/toggle`, `POST /:id/make-primary`, `/:id/regenerate-dkim` | role (write = ORGANIZATION_MANAGEMENT); `DELETE` → 409 `DOMAIN_SCOPES_ADMINS` while an admin is scoped to the domain |
| `GET /protocol-access/domains/:id`, `GET /webmail-policies/domains/:id` | domains readers: read inside the scope, 404 outside; `PUT` needs servers write (org) |
| `/ems/accepted-domains` | org |

### hygiene

| Route | Decision |
|---|---|
| `GET /security/sender-lists`, `GET /export.csv` | filter: DOMAIN entries of the scope's domains, USER entries of their mailboxes (GLOBAL not listed) |
| `POST /security/sender-lists` | GLOBAL or a target outside → OUT_OF_SCOPE |
| `POST /security/sender-lists/import` | rows outside the scope are row errors (nothing written) |
| `PATCH/DELETE /security/sender-lists/:id` | 404 |
| `GET /quarantine`, `GET /quarantine/stats` | filter by the first recipient (`toAddr`) |
| `GET /quarantine/:id` | 404 |
| `POST /quarantine/:id/release`, `DELETE /quarantine/:id` | 404 outside; OUT_OF_SCOPE unless EVERY envelope recipient is in the scope (a release delivers to all) |
| `DELETE /quarantine` (bulk) | org |
| `/security/settings`, `/security/status`, `/security/rspamd/*`, `/security/dnsbl*`, `/security/dns-check`, `/security/clamav*`, `/security/capabilities`, `/security/spoofing`, `/security/attacks*`, `/transport-rules*`, `/ems/transport-rules*` | org |

### compliance

| Route | Decision |
|---|---|
| `GET /audit-log`, `/export.csv`, `/export.json`, `/export.pdf` | filter: entries whose `targetId` is an object of the scope (user, its mailbox, shared mailbox and its mailbox, resource, alias, domain), whose `targetName` is an address of the scope's domains, or whose actor is the admin itself |
| `GET /audit-log/stats`, `GET /audit-log/anomalies` | org |
| `POST /audit-log/verify-export` | unchanged (checks a file, returns no data) |
| `GET /message-trace`, `GET /message-trace/export` (mail-flow log) | filter: sender or a recipient in the scope's domains (always the filtered scan, `TRACE_SCAN_LIMIT`) |
| `/compliance/retention*` | org |

### dashboard

| Route | Decision |
|---|---|
| `GET /dashboard/version` | unchanged |
| `GET /dashboard` | user, domain, shared-mailbox and storage figures filtered; audit, sign-in, error and attack widgets off; anonymous server counters (message volume, queue, sessions, host metrics) unchanged |

### event stream

| Route | Decision |
|---|---|
| `GET /api/v1/events` | the organisation-wide admin feed (`security:attack`) only for admins confirmed organisation-wide (the stream joins it after the scope lookup; a scoped admin or a failed lookup never gets it) |

### organisation, identity, servers (server-wide)

Every route of `/settings` (except the public `GET /settings/public`),
`/organisation` (incl. role assignments and scopes), `/branding`, `/ldap`,
`/sso`, `/servers`, `/services`, `/certificates`, `/queues`, `/logs`,
`/backups` (incl. per-mailbox backups), `/connectors`, `/smtp-config`,
`/storage`, `GET/PUT /protocol-access`, `/protocol-access/overview`,
`GET/PUT /webmail-policies`: **org**.

## Tests

- `api-gateway/src/lib/admin-scope.test.ts` — scope rules, `where` builders,
  scope-aware areas/actions, `scopeAssignmentError`, fail-closed `scopeOf`.
- `api-gateway/src/routes/admin/admin-scope.test.ts` — every router family
  (mailboxes, domains, shared, resources, aliases, mobile, sender lists,
  quarantine, audit, message trace, protocol access / webmail policies,
  server-wide routes), 404 = unknown id, OUT_OF_SCOPE creates, scope
  assignment (audit, session revocation, cache) and escalation.
- `admin-panel/src/lib/permissions.test.ts` — scope parsing, hidden pages.
- `cli/src/commands/role.test.ts`; e2e step `scopes` (docs/e2e.md).

## Known limits

- `GET /api/v1/user/me` → `adminAreas` (fallback for pre-8.x BCPs) is not
  scope-aware; the BCP uses `/admin/me/permissions`, the API enforces anyway.
- Per-mailbox backups (`backupMailboxData`) stay organisation-wide: the backup
  service lists jobs and archives without a mailbox owner filter.
