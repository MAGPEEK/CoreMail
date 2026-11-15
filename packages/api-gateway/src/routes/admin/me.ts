/**
 * GET /api/v1/admin/me/permissions (8.x) — what the signed-in admin may do.
 *
 *   { role, areas: { "<area>": "write" | "read" }, mfaVerified }
 *
 * `areas` comes from ROLE_PERMISSIONS (lib/rbac.ts), the same map every
 * requireArea() guard consults, so the BCP hides exactly what the API would
 * refuse. Guarded by requireAdmin: any admin role (VIEW_ONLY_ORG: GET only),
 * current-role check and forced admin MFA apply as on every admin route — the
 * role reported is the stricter of token role and current database role.
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { requireAdmin } from '../../middleware/auth.js';
import { allowedAreas } from '../../lib/rbac.js';

export const adminMeRouter: RouterType = Router();

adminMeRouter.get('/permissions', requireAdmin, (req: Request, res: Response) => {
  const user = req.apiUser!;
  res.set('Cache-Control', 'no-store');
  res.json({
    role: user.role,
    areas: allowedAreas(user.role),
    mfaVerified: user.mfaVerified === true,
  });
});
