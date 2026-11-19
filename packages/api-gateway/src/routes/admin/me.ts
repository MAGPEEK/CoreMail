/**
 * GET /api/v1/admin/me/permissions (8.x) — what the signed-in admin may do.
 *
 *   { role, areas: { "<area>": "write" | "read" }, actions: { "<area>": AdminAction[] },
 *     scope: { kind: "organisation" } | { kind: "domains", domains: [{ id, name }] }, mfaVerified }
 *
 * `areas` comes from ROLE_PERMISSIONS (lib/rbac.ts), the same map every
 * requireArea() guard consults, so the BCP hides exactly what the API would
 * refuse. 9.5: `scope` is the admin's management scope (lib/admin-scope.ts) —
 * a scoped admin's areas and actions leave out the server-wide areas, and the
 * BCP limits domain pickers to `scope.domains`. Guarded by requireAdmin: any
 * admin role (VIEW_ONLY_ORG: GET only), current-role check and forced admin MFA
 * apply as on every admin route — the role reported is the stricter of token
 * role and current database role, the scope is read from the database.
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { requireAdmin } from '../../middleware/auth.js';
import { scopeOf } from '../../middleware/admin-scope.js';
import { allowedActions, allowedAreas } from '../../lib/rbac.js';
import { isScoped, scopeView } from '../../lib/admin-scope.js';

export const adminMeRouter: RouterType = Router();

adminMeRouter.get('/permissions', requireAdmin, (req: Request, res: Response) => {
  const user = req.apiUser!;
  const scope = scopeOf(req);
  const scoped = isScoped(scope);
  res.set('Cache-Control', 'no-store');
  res.json({
    role: user.role,
    areas: allowedAreas(user.role, scoped),
    // narrow actions beyond read/write, e.g. HELP_DESK { recipients: [resetPassword, toggleActive, revokeSessions] }
    actions: allowedActions(user.role, scoped),
    scope: scopeView(scope),
    mfaVerified: user.mfaVerified === true,
  });
});
