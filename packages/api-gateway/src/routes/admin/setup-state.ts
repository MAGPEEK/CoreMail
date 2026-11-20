/**
 * Admin API: follow-up state of the setup wizard (10.4, docs/setup-wizard.md).
 *
 *   GET  /api/v1/admin/setup-state                         { certificateChoice, certificateHint }
 *   PUT  /api/v1/admin/setup-state/certificate-choice      { choice: letsencrypt | proxy | later }
 *   POST /api/v1/admin/setup-state/certificate-hint/dismiss hides the dashboard hint
 *
 * Area `servers` (read: GET; write: PUT/POST), organisation-wide only (scope
 * decision in docs/rbac.md). The wizard calls the PUT after setup/complete with
 * the admin session it signs in with; the BCP dashboard reads the hint.
 * Mutations are audited by the admin audit middleware.
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { requireArea } from '../../middleware/auth.js';
import { CERTIFICATE_CHOICES, certificateHintVisible } from '../../lib/setup-state.js';

export const adminSetupStateRouter: RouterType = Router();
adminSetupStateRouter.use(requireArea('servers'));

async function hasTrustedCertificate(): Promise<boolean> {
  const n = await prisma.certificate.count({
    where: { type: { not: 'SELF_SIGNED' }, acmeStaging: false, status: { in: ['ACTIVE', 'EXPIRING', 'RENEWING'] } },
  });
  return n > 0;
}

async function currentState(): Promise<{ certificateChoice: string | null; certificateHint: boolean }> {
  const s = await prisma.serverSettings.findUnique({
    where: { id: 'singleton' },
    select: { setupCertificateChoice: true, setupCertificateHintDismissedAt: true },
  });
  const choice = s?.setupCertificateChoice ?? null;
  // Only look at the certificates when the hint could show at all.
  const hint = choice === 'later' && !s?.setupCertificateHintDismissedAt
    ? certificateHintVisible(choice, null, await hasTrustedCertificate())
    : false;
  return { certificateChoice: choice, certificateHint: hint };
}

adminSetupStateRouter.get('/', async (_req: Request, res: Response) => {
  res.json(await currentState());
});

const ChoiceBody = z.object({ choice: z.enum(CERTIFICATE_CHOICES) }).strict();

adminSetupStateRouter.put('/certificate-choice', async (req: Request, res: Response) => {
  const parsed = ChoiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' });
    return;
  }
  // A new choice shows the hint again when it is "later" (idempotent otherwise).
  await prisma.serverSettings.update({
    where: { id: 'singleton' },
    data: { setupCertificateChoice: parsed.data.choice, setupCertificateHintDismissedAt: null },
  });
  res.json(await currentState());
});

adminSetupStateRouter.post('/certificate-hint/dismiss', async (_req: Request, res: Response) => {
  await prisma.serverSettings.update({
    where: { id: 'singleton' },
    data: { setupCertificateHintDismissedAt: new Date() },
  });
  res.json(await currentState());
});
