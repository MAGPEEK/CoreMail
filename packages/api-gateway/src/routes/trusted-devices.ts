/**
 * 10.6: the signed-in user's remembered MFA devices ("Gerät merken") —
 * webmail Settings → Sicherheit (storage auth/trusted-devices.ts).
 *
 *   GET    /api/v1/user/trusted-devices        → { devices: [...] }
 *   DELETE /api/v1/user/trusted-devices/:id    → revoke one (own devices only, 404 otherwise)
 *   DELETE /api/v1/user/trusted-devices        → revoke all
 *
 * Own account only; never lists token hashes. Revocations are audited
 * (`user.mfa.trusted-device.revoke`).
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { createLogger } from '@coremail/core';
import { listTrustedDevices, revokeTrustedDevice, revokeTrustedDevicesOfUser } from '@coremail/storage/auth';
import { requireAuth } from '../middleware/auth.js';
import { audit, auditContext } from '../lib/audit.js';

const log = createLogger('api:trusted-devices');

export const trustedDevicesRouter: RouterType = Router();

trustedDevicesRouter.get('/', requireAuth, async (req: Request, res: Response) => {
  const user = req.apiUser!;
  try {
    const devices = await listTrustedDevices(user.userId);
    res.set('Cache-Control', 'no-store');
    res.json({ devices });
  } catch (err) {
    log.error({ err, userId: user.userId }, 'Listing remembered devices failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});

trustedDevicesRouter.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  const user = req.apiUser!;
  const id = String(req.params['id'] ?? '');
  if (!id || id.length > 64) { res.status(400).json({ error: 'Invalid id' }); return; }
  const ok = await revokeTrustedDevice(user.userId, id, 'user');
  if (!ok) { res.status(404).json({ error: 'Not found' }); return; }
  audit({
    actorId: user.userId, actorEmail: user.email,
    action: 'user.mfa.trusted-device.revoke', targetType: 'user', targetId: user.userId,
    changes: { device: id }, ...auditContext(req),
  });
  res.json({ ok: true });
});

trustedDevicesRouter.delete('/', requireAuth, async (req: Request, res: Response) => {
  const user = req.apiUser!;
  const revoked = await revokeTrustedDevicesOfUser(user.userId, 'user');
  audit({
    actorId: user.userId, actorEmail: user.email,
    action: 'user.mfa.trusted-device.revoke', targetType: 'user', targetId: user.userId,
    changes: { all: true, revoked }, ...auditContext(req),
  });
  res.json({ ok: true, revoked });
});
