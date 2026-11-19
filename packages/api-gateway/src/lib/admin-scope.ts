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

// ─── Addresses of other domains in detail views ─────────────────────────────

/**
 * Shown to a scoped admin instead of an address of a hosted domain outside its
 * scope (grantees, other recipients, audit details); a run of several hidden
 * addresses becomes one label with their count.
 */
export const OTHER_DOMAIN_LABEL = '(andere Domain)';

export function otherDomainLabel(count: number): string {
  return count <= 1 ? OTHER_DOMAIN_LABEL : `(andere Domain, ${count} Adressen)`;
}

/**
 * An address with an optional display name ("Name" <a@b>, Name <a@b>) or a bare
 * address. Group 1 = the address of the angle form, group 2 = a bare address.
 */
const ADDRESS_RE = /(?:"[^"\r\n]*"|[^\s",;:<>()[\]@]+(?:[ \t]+[^\s",;:<>()[\]@]+)*)?[ \t]*<([^<>\s@]+@[^<>\s]+)>|([\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*)/gu;
const HIDDEN_MARK = '\u0001';
const HIDDEN_RUN_RE = /\u0001(?:[ \t]*[,;][ \t]*\u0001)*/g;
const LIST_SEPARATORS_RE = /^[\s,;]*$/;

/** Redacts the addresses of other hosted domains for one admin (see addressRedactor). */
export interface AddressRedactor {
  /** false = organisation-wide: every method returns its input unchanged */
  readonly active: boolean;
  /** hosted domains outside the scope (lower-case) */
  readonly hiddenDomains: readonly string[];
  /** Is this address (bare or with display name) one the admin must not see? */
  hides(address: string | null | undefined): boolean;
  /** A text with every hidden address replaced (runs of a list → one label with a count). */
  text(value: string): string;
  /** text() for an optional column. */
  optionalText<T extends string | null | undefined>(value: T): T;
  /** Strings, array elements and object keys / values of a JSON value, recursively. */
  deep<T>(value: T): T;
  /** A person row ({ email, displayName? }) of another domain: both fields become the label. */
  person<T extends { email: string; displayName?: string | null }>(p: T): T;
}

const identity = <T>(v: T): T => v;

/** The redactor of organisation-wide admins: nothing is hidden. */
export const NO_REDACTION: AddressRedactor = Object.freeze({
  active: false, hiddenDomains: Object.freeze([]) as readonly string[],
  hides: () => false, text: identity, optionalText: identity, deep: identity, person: identity,
});

/**
 * Pure (w3 scope leaks): the redactor of a scoped admin. Hidden are addresses
 * of hosted domains (`hostedDomains`, the Domain table) outside the scope —
 * the other tenants of the server. Addresses of external domains stay visible
 * (the correspondents of the scope's mailboxes: quarantine senders, mail-flow
 * partners), and so does the viewer's own address (`viewerEmail`). An
 * organisation-wide scope → NO_REDACTION.
 */
export function addressRedactor(scope: AdminScope, hostedDomains: readonly string[], viewerEmail?: string): AddressRedactor {
  if (!isScoped(scope)) return NO_REDACTION;
  const own = new Set(scope.domains.map((d) => d.name));
  const hidden = new Set(hostedDomains.map((d) => d.toLowerCase()).filter((d) => !own.has(d)));
  const viewer = viewerEmail?.trim().toLowerCase() ?? '';
  const hides = (address: string | null | undefined): boolean => {
    if (!address) return false;
    const bare = address.trim().replace(/^.*<([^>]*)>.*$/, '$1').trim().toLowerCase();
    return bare !== viewer && hidden.has(domainOfAddress(bare));
  };

  /** The text with hidden addresses replaced, their number and whether nothing else was in it. */
  const redact = (value: string): { text: string; count: number; pure: boolean } => {
    let count = 0;
    const marked = value.replaceAll(HIDDEN_MARK, '').replace(ADDRESS_RE, (match, angle: string | undefined, bare: string | undefined) => {
      if (!hides(angle ?? bare)) return match;
      count += 1;
      return HIDDEN_MARK;
    });
    if (count === 0) return { text: value, count, pure: false };
    const pure = LIST_SEPARATORS_RE.test(marked.replaceAll(HIDDEN_MARK, ''));
    const text = marked.replace(HIDDEN_RUN_RE, (run) => otherDomainLabel(run.split(HIDDEN_MARK).length - 1));
    return { text, count, pure };
  };

  const deep = (value: unknown): unknown => {
    if (typeof value === 'string') return redact(value).text;
    if (Array.isArray(value)) {
      // elements that are only hidden addresses collapse into one label with their count
      let hiddenCount = 0;
      let at = -1;
      const out: unknown[] = [];
      for (const v of value) {
        const r = typeof v === 'string' ? redact(v) : null;
        if (r?.pure) {
          hiddenCount += r.count;
          if (at < 0) at = out.length;
        } else {
          out.push(r ? r.text : deep(v));
        }
      }
      if (hiddenCount > 0) out.splice(at, 0, otherDomainLabel(hiddenCount));
      return out;
    }
    if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        let key = redact(k).text;
        for (let n = 2; key in out; n += 1) key = `${redact(k).text} #${n}`;
        out[key] = deep(v);
      }
      return out;
    }
    return value;
  };

  return Object.freeze({
    active: true,
    hiddenDomains: Object.freeze([...hidden].sort()),
    hides,
    text: (value: string) => redact(value).text,
    optionalText: <T extends string | null | undefined>(value: T): T => (typeof value === 'string' ? redact(value).text : value) as T,
    deep: <T>(value: T): T => deep(value) as T,
    person: <T extends { email: string; displayName?: string | null }>(p: T): T =>
      (hides(p.email) ? { ...p, email: OTHER_DOMAIN_LABEL, ...('displayName' in p ? { displayName: OTHER_DOMAIN_LABEL } : {}) } : p),
  });
}

/** Public form of a scope (GET /admin/me/permissions, role assignments). */
export function scopeView(scope: AdminScope): { kind: 'organisation' } | { kind: 'domains'; domains: ScopeDomain[] } {
  return isScoped(scope) ? { kind: 'domains', domains: scope.domains.map((d) => ({ id: d.id, name: d.name })) } : { kind: 'organisation' };
}
