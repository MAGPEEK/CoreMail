/**
 * Admin management scopes (9.5) — pure logic, no I/O.
 *
 * An admin role assignment may be limited to domains (table `admin_scopes`,
 * one row per admin + domain). No rows = organisation-wide (the pre-9.5
 * behaviour); ORGANIZATION_MANAGEMENT is always organisation-wide. A scoped
 * admin:
 *  - never reaches the server-wide areas (lib/rbac.ts UNSCOPED_ONLY_AREAS) nor
 *    the server-wide routes of the other areas (middleware/admin-scope.ts
 *    requireUnscoped);
 *  - sees in lists only objects of its domains (the `*Where` helpers below);
 *  - gets 404 — the same answer as for an unknown id — for an object of another
 *    domain addressed by id (no existence oracle);
 *  - gets 403 OUT_OF_SCOPE when a write would place something in a domain
 *    outside the scope (create, an alias / sender-list target): domain names
 *    are public DNS facts, so the refusal reveals nothing.
 * The decision for every admin route is listed in docs/rbac.md.
 */

export interface ScopeDomain { readonly id: string; readonly name: string }

export type AdminScope =
  | { readonly kind: 'organisation' }
  | { readonly kind: 'domains'; readonly domains: readonly ScopeDomain[] };

export type DomainScope = Extract<AdminScope, { kind: 'domains' }>;

export const ORGANISATION_SCOPE: AdminScope = Object.freeze({ kind: 'organisation' as const });

/** Fail-closed scope of a request whose scope was never resolved: it sees nothing. */
export const EMPTY_SCOPE: AdminScope = Object.freeze({ kind: 'domains' as const, domains: Object.freeze([]) });

/** The scope of an admin with `role` and the domains of its AdminScope rows. */
export function scopeFromRows(role: string, rows: readonly ScopeDomain[]): AdminScope {
  if (role === 'ORGANIZATION_MANAGEMENT' || rows.length === 0) return ORGANISATION_SCOPE;
  const domains = [...rows].sort((a, b) => a.name.localeCompare(b.name)).map((d) => Object.freeze({ id: d.id, name: d.name.toLowerCase() }));
  return Object.freeze({ kind: 'domains' as const, domains: Object.freeze(domains) });
}

export function isScoped(scope: AdminScope): scope is DomainScope {
  return scope.kind === 'domains';
}

/** Domain ids of a scoped admin; null = organisation-wide. */
export function scopeDomainIds(scope: AdminScope): string[] | null {
  return isScoped(scope) ? scope.domains.map((d) => d.id) : null;
}

/** Is an object of domain `domainId` inside the scope? (No domain → only organisation-wide.) */
export function inScope(scope: AdminScope, domainId: string | null | undefined): boolean {
  if (!isScoped(scope)) return true;
  return !!domainId && scope.domains.some((d) => d.id === domainId);
}

/** Lower-cased domain part of an address (`Name <a@b>` and bare `a@b`); '' without one. */
export function domainOfAddress(address: string): string {
  const bare = address.trim().replace(/^.*<([^>]*)>.*$/, '$1').trim().toLowerCase();
  const at = bare.lastIndexOf('@');
  return at < 0 ? '' : bare.slice(at + 1);
}

/** Is the domain of `address` inside the scope? */
export function addressInScope(scope: AdminScope, address: string): boolean {
  if (!isScoped(scope)) return true;
  const domain = domainOfAddress(address);
  return !!domain && scope.domains.some((d) => d.name === domain);
}

/** All addresses inside the scope (an empty list only for organisation-wide admins). */
export function allAddressesInScope(scope: AdminScope, addresses: readonly string[]): boolean {
  if (!isScoped(scope)) return true;
  return addresses.length > 0 && addresses.every((a) => addressInScope(scope, a));
}

/** At least one address inside the scope (organisation-wide: always). */
export function anyAddressInScope(scope: AdminScope, addresses: readonly string[]): boolean {
  if (!isScoped(scope)) return true;
  return addresses.some((a) => addressInScope(scope, a));
}

/** Both Prisma `where` objects (an empty one is left out, so organisation-wide queries stay unchanged). */
export function andWhere(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  if (Object.keys(a).length === 0) return b;
  if (Object.keys(b).length === 0) return a;
  return { AND: [a, b] };
}

/** Prisma `where` for a model with a `domainId` column ({} = organisation-wide). */
export function domainIdWhere(scope: AdminScope): Record<string, unknown> {
  const ids = scopeDomainIds(scope);
  return ids ? { domainId: { in: ids } } : {};
}

/** Prisma `where` for the Domain model itself. */
export function domainRowWhere(scope: AdminScope): Record<string, unknown> {
  const ids = scopeDomainIds(scope);
  return ids ? { id: { in: ids } } : {};
}

/** Prisma `where`: the address column `field` ends in one of the scope's domains. */
export function addressWhere(scope: AdminScope, field: string): Record<string, unknown> {
  if (!isScoped(scope)) return {};
  if (scope.domains.length === 0) return { [field]: { in: [] } };
  return { OR: scope.domains.map((d) => ({ [field]: { endsWith: `@${d.name}`, mode: 'insensitive' } })) };
}

/**
 * An alias is inside the scope when its own domain AND its target mailbox's
 * domain are (deleting or disabling it changes the target's mail flow).
 */
export function aliasInScope(
  scope: AdminScope,
  alias: { domainId: string; targetUser?: { domainId: string } | null; targetShared?: { domainId: string } | null },
): boolean {
  const targetDomain = alias.targetUser?.domainId ?? alias.targetShared?.domainId;
  return inScope(scope, alias.domainId) && inScope(scope, targetDomain);
}

/** Prisma `where` for EmailAlias rows inside the scope (see aliasInScope). */
export function aliasWhere(scope: AdminScope): Record<string, unknown> {
  const ids = scopeDomainIds(scope);
  if (!ids) return {};
  return {
    domainId: { in: ids },
    OR: [{ targetUser: { domainId: { in: ids } } }, { targetShared: { domainId: { in: ids } } }],
  };
}

/** The answer for an object outside the scope addressed by id — identical to an unknown id. */
export const OUT_OF_SCOPE_NOT_FOUND = Object.freeze({ error: 'Not found' });

/** The answer when a write would place something in a domain outside the scope. */
export const OUT_OF_SCOPE_REFUSAL = Object.freeze({
  error: 'This domain is outside your management scope',
  code: 'OUT_OF_SCOPE',
});

/** The answer of a server-wide route to a scoped admin. */
export const ORG_ONLY_REFUSAL = Object.freeze({
  error: 'Only organisation-wide admins may use this function',
  code: 'SCOPE_ORG_ONLY',
});

/** Public form of a scope (GET /admin/me/permissions, role assignments). */
export function scopeView(scope: AdminScope): { kind: 'organisation' } | { kind: 'domains'; domains: ScopeDomain[] } {
  return isScoped(scope) ? { kind: 'domains', domains: scope.domains.map((d) => ({ id: d.id, name: d.name })) } : { kind: 'organisation' };
}
