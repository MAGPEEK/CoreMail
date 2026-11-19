# w3-rbac-scopes — admin management scopes

SemVer: MINOR (additive schema, new endpoints and fields; organisation-wide admins
behave as before). One behaviour change for existing installs: `DELETE
/api/v1/admin/resources/:id/bookings/:bookingId` now requires the booking to
belong to the resource of the path (404 otherwise) — a fix, not a breaking change.

### Added

- Admin management scopes: an admin role (HELP_DESK, RECIPIENT_MANAGEMENT,
  COMPLIANCE_MANAGEMENT, HYGIENE_MANAGEMENT, VIEW_ONLY_ORG) can be limited to one or
  more domains (table `admin_scopes`; no rows = organisation-wide, as before).
  ORGANIZATION_MANAGEMENT stays organisation-wide. A scoped admin never reaches the
  server-wide areas (organisation, identity, servers — incl. backups) nor the
  server-wide routes of its other areas, sees only objects of its domains in every
  list (mailboxes, shared mailboxes, resources, aliases, mobile devices, domains,
  sender lists, quarantine, audit log, message trace, dashboard figures), gets 404 —
  identical to an unknown id — for objects of other domains, and 403 `OUT_OF_SCOPE`
  when creating something in another domain. Every admin route and its decision is
  listed in docs/rbac.md.
- `PUT /api/v1/admin/organisation/role-assignments/:id/scope` `{ domainIds }`
  (ORGANIZATION_MANAGEMENT only): audited as `user.role.scope` (always logged) and
  ends the admin's web/API sessions like a role change (auth event reason
  `scope-change`; mail-protocol logins are not affected).
  `GET /api/v1/admin/organisation/role-assignments` returns each account's `scope`.
- `GET /api/v1/admin/me/permissions` returns `scope`; areas and actions of a scoped
  admin leave out the server-wide ones.
- BCP: management-scope column and domain editor on the RBAC page
  (ORGANIZATION_MANAGEMENT); scoped admins get no transport-rules / retention pages,
  only the sender lists on the protection page, and domain pickers list their
  domains.
- CLI: `coremail role list | set | scope | me`.
- e2e step `scopes`.

### Changed

- Deleting a domain that still scopes an admin is refused with 409
  `DOMAIN_SCOPES_ADMINS` (a vanished last scope row would widen the admin).
- The event stream (`GET /api/v1/events`) joins the admin feed (`security:attack`)
  only after the admin is confirmed organisation-wide (scoped admins never get it).
- `GET /api/v1/admin/protocol-access/domains/:id` and
  `/webmail-policies/domains/:id` are guarded as the domains area (+ servers
  access) — the same roles as before, now scope-aware.

### Fixed

- `DELETE /api/v1/admin/resources/:id/bookings/:bookingId` deleted a booking of any
  resource; the booking must now belong to the resource in the path.

### Security

- Scope checks run before the route handlers and answer out-of-scope ids exactly
  like unknown ids (no existence oracle); the scope is read from the database on
  every admin request (15 s cache dropped on auth events), never from the token,
  and a request without a resolved scope sees nothing (fail closed). Nobody but
  ORGANIZATION_MANAGEMENT assigns scopes, so no admin can grant more than it holds.
- An admin other than ORGANIZATION_MANAGEMENT can no longer grant itself a
  shared-mailbox permission (`POST /api/v1/admin/shared-mailboxes/:id/permissions`
  → 403 `FORBIDDEN_ROLE`), the same rule delegations already had. Applies to
  organisation-wide recipient admins too.
- Blocking, wiping or deregistering a mobile device and creating, changing or
  deleting an alias of an admin account need ORGANIZATION_MANAGEMENT (403
  `FORBIDDEN_ROLE`), like every other change of an admin account.
- Mailbox create and sender-list entries / imports refuse a target of another
  domain before looking the address up — taken and free addresses of other domains
  answer alike (no address oracle for scoped admins).
- The event stream decides on the admin feed from the current database role and
  scope, not from the token role.
- BCP: the sender-list form no longer offers the "Global" scope to admins limited
  to domains.
