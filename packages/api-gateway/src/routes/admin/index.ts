/**
 * Admin router table (v6). Single source of truth for the /api/v1/admin/*
 * mounts — used by server.ts and by the RBAC sweep test (rbac.test.ts),
 * which enumerates every route below and asserts a USER token gets 403.
 *
 * Every router guards itself with requireArea(<area>) (see lib/rbac.ts for
 * the role → area matrix). Order matters only for Express matching, never
 * for authorization.
 */
import type { Router } from 'express';
import { adminDashboardRouter } from './dashboard.js';
import { adminGlobalSettingsRouter } from './global-settings.js';
import { adminMailboxesRouter } from './mailboxes.js';
import { adminAliasesRouter } from './aliases.js';
import { adminDomainsRouter } from './domains.js';
import { adminQueuesRouter } from './queues.js';
import { adminLogsRouter } from './logs.js';
import { adminBackupsRouter } from './backups.js';
import { adminEmsRouter } from './ems.js';
import { adminRetentionRouter } from './retention.js';
import { adminAuditLogRouter } from './audit-log.js';
import { adminServersRouter } from './servers.js';
import { adminServicesRouter } from './services.js';
import { adminCertificatesRouter } from './certificates.js';
import { adminSharedMailboxesRouter } from './shared-mailboxes.js';
import { adminQuarantineRouter } from './quarantine.js';
import { adminTransportRulesRouter } from './transport-rules.js';
import { adminMobileRouter } from './mobile.js';
import { adminMessageTraceRouter } from './message-trace.js';
import { adminConnectorsRouter } from './connectors.js';
import { adminOrganisationRouter } from './organisation.js';
import { adminSecurityRouter } from './security.js';
import { adminSecurityAttacksRouter } from './security-attacks.js';
import { adminSecurityProtectionRouter } from './security-protection.js';
import { adminSmtpConfigRouter } from './smtp-config.js';
import { adminLdapRouter } from './ldap.js';
import { adminSsoRouter } from './sso.js';
import { adminStorageRouter } from './storage.js';
import { adminBrandingRouter } from './branding.js';
import { adminProtocolAccessRouter } from './protocol-access.js';
import { adminWebmailPoliciesRouter } from './webmail-policies.js';
import { adminMcpRouter } from './mcp.js';
import { adminSetupStateRouter } from './setup-state.js';
import { adminPasskeyPolicyRouter, adminMailboxPasskeysRouter } from './passkeys.js';

export const ADMIN_PREFIX = '/api/v1/admin';

/** [mount path relative to ADMIN_PREFIX, router] in registration order. */
export const ADMIN_MOUNTS: ReadonlyArray<readonly [string, Router]> = [
  ['/dashboard',            adminDashboardRouter],
  ['/settings',             adminGlobalSettingsRouter],
  ['/mailboxes',            adminMailboxesRouter],
  // 10.6: passkeys of a mailbox (/:id/passkeys, /:id/passkey-recovery, /:id/passkey-policy,
  // /:id/mfa-reset) — area recipients, own router so the paths stay together
  ['/mailboxes',            adminMailboxPasskeysRouter],
  // Alias router mounts on /admin itself — internal routes are /mailboxes/:id/aliases,
  // /shared-mailboxes/:id/aliases, /aliases, /aliases/:id (guards only those paths).
  ['',                      adminAliasesRouter],
  ['/domains',              adminDomainsRouter],
  ['/queues',               adminQueuesRouter],
  ['/backups',              adminBackupsRouter],
  ['/logs',                 adminLogsRouter],
  ['/ems',                  adminEmsRouter],
  ['/compliance/retention', adminRetentionRouter],
  ['/audit-log',            adminAuditLogRouter],
  ['/servers',              adminServersRouter],
  ['/services',             adminServicesRouter],
  ['/certificates',         adminCertificatesRouter],
  ['/shared-mailboxes',     adminSharedMailboxesRouter],
  ['/quarantine',           adminQuarantineRouter],
  ['/transport-rules',      adminTransportRulesRouter],
  ['/mobile',               adminMobileRouter],
  ['/message-trace',        adminMessageTraceRouter],
  ['/connectors',           adminConnectorsRouter],
  ['/organisation',         adminOrganisationRouter],
  ['/security',             adminSecurityRouter],
  ['/security/attacks',     adminSecurityAttacksRouter],
  // 10.5: attack protection — locks, block list / exceptions, notifications (area hygiene, organisation-wide)
  ['/security/protection',  adminSecurityProtectionRouter],
  ['/smtp-config',          adminSmtpConfigRouter],
  ['/ldap',                 adminLdapRouter],
  ['/sso',                  adminSsoRouter],
  // v7.1: object storage status + migration (ORGANIZATION_MANAGEMENT only)
  ['/storage',              adminStorageRouter],
  // 9.3: branding (area organisation — write ORGANIZATION_MANAGEMENT, read SERVER_MANAGEMENT / VIEW_ONLY_ORG)
  ['/branding',             adminBrandingRouter],
  // 9.4: per-protocol access switches (server/domain: area servers, user: area recipients)
  ['/protocol-access',      adminProtocolAccessRouter],
  // 9.4: webmail policies (same split: server/domain = servers, user = recipients)
  ['/webmail-policies',     adminWebmailPoliciesRouter],
  // 10.3: admin MCP interface — switch + allowlist (area servers), own tokens (every admin role)
  ['/mcp',                  adminMcpRouter],
  // 10.4.2: BCP dashboard card "Zertifikat einrichten" (area servers)
  ['/setup-state',          adminSetupStateRouter],
  // 10.6: passkey policy (area organisation, organisation-wide admins only)
  ['/authentication/passkeys', adminPasskeyPolicyRouter],
];

/** Admin endpoints that are intentionally public (no auth). */
export const PUBLIC_ADMIN_ROUTES: ReadonlyArray<string> = ['GET /api/v1/admin/settings/public'];

/**
 * 10.3: mutating admin endpoints every admin role may call — they change only
 * the caller's own personal credentials (MCP tokens), never organisation data.
 * VIEW_ONLY_ORG passes them (read tokens only, enforced in the route); USER never.
 */
export const PERSONAL_ADMIN_WRITES: ReadonlyArray<string> = [
  'POST /api/v1/admin/mcp/tokens',
  'DELETE /api/v1/admin/mcp/tokens/:id',
];

export function mountAdminRoutes(app: { use: (path: string, router: Router) => unknown }): void {
  for (const [path, router] of ADMIN_MOUNTS) app.use(`${ADMIN_PREFIX}${path}`, router);
}
