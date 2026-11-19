/**
 * `coremail role …` — admin roles and management scopes (9.5):
 *   coremail role list [--admins]                     who holds which role, with its scope
 *                                                     (GET /api/v1/admin/organisation/role-assignments)
 *   coremail role set <email|id> <ROLE>               change the role (PUT /api/v1/admin/mailboxes/:id)
 *   coremail role scope <email|id> <domain...>        limit the admin role to these domains
 *   coremail role scope <email|id> --organisation     organisation-wide again
 *                                                     (PUT /api/v1/admin/organisation/role-assignments/:id/scope)
 *   coremail role me                                  the signed-in admin's areas, actions and scope
 *                                                     (GET /api/v1/admin/me/permissions)
 * Roles and scopes are assigned by ORGANIZATION_MANAGEMENT only (the API
 * refuses everyone else); a change is audited and ends the account's web
 * sessions (the CLI session of that account included).
 */
import { Command } from 'commander';
import { resolveDomain, resolveUser, type CoreMailClient } from '../client.js';
import { fail, printJson, printTable } from '../output.js';

export const ROLES = [
  'USER', 'HELP_DESK', 'RECIPIENT_MANAGEMENT', 'COMPLIANCE_MANAGEMENT',
  'HYGIENE_MANAGEMENT', 'SERVER_MANAGEMENT', 'VIEW_ONLY_ORG', 'ORGANIZATION_MANAGEMENT',
] as const;

export type Scope = { kind: 'organisation' } | { kind: 'domains'; domains: Array<{ id: string; name: string }> };

export interface RoleAssignment {
  id: string; email: string; displayName: string; role: string; active: boolean; scope?: Scope;
}

/** "organisation" or the domain names (an older server sends no scope → organisation). */
export function scopeLabel(scope: Scope | undefined): string {
  return scope?.kind === 'domains' ? scope.domains.map((d) => d.name).join(', ') : 'organisation';
}

/** Table rows of `role list` (`adminsOnly`: without USER accounts). */
export function roleRows(list: RoleAssignment[], adminsOnly: boolean): Array<Record<string, unknown>> {
  return list
    .filter((u) => !adminsOnly || u.role !== 'USER')
    .map((u) => ({ email: u.email, role: u.role, scope: u.role === 'USER' ? '-' : scopeLabel(u.scope), active: u.active ? 'yes' : 'no' }));
}

/** The domains given for `role scope`, or [] with --organisation; both or neither is an error. */
export function scopeArgs(domains: string[], organisation: boolean): string[] {
  if (organisation && domains.length) throw new Error('Pass domains OR --organisation, not both');
  if (!organisation && !domains.length) throw new Error('Pass at least one domain, or --organisation for the whole organisation');
  return organisation ? [] : domains;
}

export function normalizeRole(raw: string): string {
  const role = raw.trim().toUpperCase();
  if (!(ROLES as readonly string[]).includes(role)) throw new Error(`Invalid role: ${raw} (${ROLES.join(', ')})`);
  return role;
}

export function registerRole(program: Command, api: () => CoreMailClient, json: () => boolean): void {
  const c = program.command('role').description('Admin roles and management scopes (domains an admin role is limited to)');

  c.command('list').description('Accounts with their role and management scope')
    .option('--admins', 'only accounts with an admin role')
    .action(async (opts: { admins?: boolean }) => {
      const list = await api().get<RoleAssignment[]>('/api/v1/admin/organisation/role-assignments');
      if (json()) { printJson(list); return; }
      printTable(roleRows(list, opts.admins === true), [
        { key: 'email', label: 'Email' }, { key: 'role', label: 'Role' }, { key: 'scope', label: 'Scope' }, { key: 'active', label: 'Active' },
      ]);
    });

  c.command('set <user> <role>').description('Change the role of an account (ends its web sessions)')
    .action(async (ref: string, rawRole: string) => {
      let role: string;
      try { role = normalizeRole(rawRole); } catch (e) { fail((e as Error).message); }
      const u = await resolveUser(api(), ref);
      const updated = await api().put<{ email: string; role: string }>(`/api/v1/admin/mailboxes/${u.id}`, { role });
      if (json()) { printJson(updated); return; }
      process.stdout.write(`${updated.email}: role ${updated.role}\n`);
    });

  c.command('scope <user> [domains...]').description('Limit the admin role to domains (names or ids); --organisation = whole organisation')
    .option('--organisation', 'organisation-wide (removes every domain limit)')
    .action(async (ref: string, domains: string[], opts: { organisation?: boolean }) => {
      let names: string[];
      try { names = scopeArgs(domains, opts.organisation === true); } catch (e) { fail((e as Error).message); }
      const client = api();
      const u = await resolveUser(client, ref);
      const domainIds = await Promise.all(names.map(async (n) => (await resolveDomain(client, n)).id));
      const r = await client.put<{ role: string; scope: Scope; changed: boolean }>(
        `/api/v1/admin/organisation/role-assignments/${u.id}/scope`, { domainIds },
      );
      if (json()) { printJson(r); return; }
      process.stdout.write(`${u.email} (${r.role}): scope ${scopeLabel(r.scope)}${r.changed ? ' — web sessions ended' : ' (unchanged)'}\n`);
    });

  c.command('me').description("The signed-in admin's role, areas and management scope")
    .action(async () => {
      const p = await api().get<{ role: string; areas: Record<string, string>; scope?: Scope }>('/api/v1/admin/me/permissions');
      if (json()) { printJson(p); return; }
      process.stdout.write(`Role:  ${p.role}\nScope: ${scopeLabel(p.scope)}\n`);
      printTable(Object.entries(p.areas).map(([area, access]) => ({ area, access })), [
        { key: 'area', label: 'Area' }, { key: 'access', label: 'Access' },
      ]);
    });
}
