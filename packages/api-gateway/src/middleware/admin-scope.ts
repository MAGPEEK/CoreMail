/**
 * Admin management scopes (9.5) — the request side: loading an admin's scope
 * and the guards every recipient / domain bound admin route uses. Pure rules:
 * lib/admin-scope.ts; route decisions: docs/rbac.md.
 *
 * The admin guards (middleware/auth.ts adminGuard) resolve the scope together
 * with the current role and put it on `req.apiUser.adminScope`; `scopeOf(req)`
 * fails closed (no domains) when that never happened.
 */
import type { Request, Response, NextFunction } from 'express';
import { prisma } from '@coremail/storage';
import {
  EMPTY_SCOPE, ORG_ONLY_REFUSAL, OUT_OF_SCOPE_NOT_FOUND, OUT_OF_SCOPE_REFUSAL,
  addressInScope, aliasInScope, inScope, isScoped, scopeFromRows,
  type AdminScope, type DomainScope,
} from '../lib/admin-scope.js';

/** Scope of `userId` with `role`: ORGANIZATION_MANAGEMENT never reads rows. Throws on database errors. */
export async function loadAdminScope(userId: string, role: string): Promise<AdminScope> {
  if (role === 'ORGANIZATION_MANAGEMENT') return scopeFromRows(role, []);
  const rows = await prisma.adminScope.findMany({
    where: { userId },
    select: { domain: { select: { id: true, name: true } } },
  });
  return scopeFromRows(role, (rows ?? []).map((r) => r.domain));
}

/** The resolved scope of the request's admin; fails closed (sees nothing) when it is missing. */
export function scopeOf(req: Request): AdminScope {
  return req.apiUser?.adminScope ?? EMPTY_SCOPE;
}

/** Object kinds an admin route addresses by id. */
export type ScopeTarget = 'user' | 'shared' | 'resource' | 'domain' | 'alias' | 'device' | 'quarantine' | 'senderList';

/** Is the object `id` of `kind` visible inside `scope`? Unknown ids → false. */
const VISIBLE: Readonly<Record<ScopeTarget, (id: string, scope: DomainScope) => Promise<boolean>>> = {
  domain: (id, scope) => Promise.resolve(inScope(scope, id)),
  user: async (id, scope) => inScope(scope, (await prisma.user.findUnique({ where: { id }, select: { domainId: true } }))?.domainId),
  shared: async (id, scope) =>
    inScope(scope, (await prisma.sharedMailbox.findUnique({ where: { id }, select: { domainId: true } }))?.domainId),
  resource: async (id, scope) =>
    inScope(scope, (await prisma.resourceMailbox.findUnique({ where: { id }, select: { domainId: true } }))?.domainId),
  alias: async (id, scope) => {
    const a = await prisma.emailAlias.findUnique({
      where: { id },
      select: { domainId: true, targetUser: { select: { domainId: true } }, targetShared: { select: { domainId: true } } },
    });
    return !!a && aliasInScope(scope, a);
  },
  device: async (id, scope) =>
    inScope(scope, (await prisma.activeSyncDevice.findUnique({ where: { id }, select: { user: { select: { domainId: true } } } }))?.user?.domainId),
  // view rule: the first recipient (Quarantine.toAddr); releasing / deleting needs every recipient (routes)
  quarantine: async (id, scope) => {
    const q = await prisma.quarantine.findUnique({ where: { id }, select: { toAddr: true } });
    return !!q && addressInScope(scope, q.toAddr);
  },
  senderList: async (id, scope) => {
    const e = await prisma.blacklist.findUnique({ where: { id }, select: { scope: true, scopeId: true } });
    if (!e?.scopeId) return false; // GLOBAL (and webmail USER-JUNK without target) entries are organisation-wide
    if (e.scope === 'DOMAIN') return inScope(scope, e.scopeId);
    if (e.scope === 'USER') return VISIBLE.user(e.scopeId, scope);
    return false;
  },
};

/** Is the object visible to the request's admin? Organisation-wide admins: always (no query). */
export async function targetInScope(req: Request, kind: ScopeTarget, id: string): Promise<boolean> {
  const scope = scopeOf(req);
  return isScoped(scope) ? VISIBLE[kind](id, scope) : true;
}

function checkTarget(req: Request, res: Response, next: NextFunction, kind: ScopeTarget, id: string): void {
  targetInScope(req, kind, id).then((ok) => {
    if (ok) next();
    else res.status(404).json(OUT_OF_SCOPE_NOT_FOUND);
  }, next);
}

/**
 * `router.param(<name>, scopeParam(kind))` — every route of the router with that
 * parameter answers 404 for an object outside the scope (and for an unknown id,
 * with the same body — no existence oracle).
 */
export function scopeParam(kind: ScopeTarget) {
  return (req: Request, res: Response, next: NextFunction, id: string): void => {
    checkTarget(req, res, next, kind, String(id));
  };
}

/** Route middleware: like scopeParam for one route (routers whose `:id` means different kinds). */
export function requireInScope(kind: ScopeTarget, param = 'id') {
  return (req: Request, res: Response, next: NextFunction): void => {
    checkTarget(req, res, next, kind, String(req.params[param] ?? ''));
  };
}

/** Route middleware: server-wide routes are for organisation-wide admins only (403 SCOPE_ORG_ONLY). */
export function requireUnscoped(req: Request, res: Response, next: NextFunction): void {
  if (isScoped(scopeOf(req))) { res.status(403).json(ORG_ONLY_REFUSAL); return; }
  next();
}

/** 403 OUT_OF_SCOPE when `domainId` is outside the scope; true when the caller may go on. */
export function allowDomain(req: Request, res: Response, domainId: string | null | undefined): boolean {
  if (inScope(scopeOf(req), domainId)) return true;
  res.status(403).json(OUT_OF_SCOPE_REFUSAL);
  return false;
}

/** 403 OUT_OF_SCOPE when the domain of `address` is outside the scope; true when the caller may go on. */
export function allowAddress(req: Request, res: Response, address: string): boolean {
  if (addressInScope(scopeOf(req), address)) return true;
  res.status(403).json(OUT_OF_SCOPE_REFUSAL);
  return false;
}
