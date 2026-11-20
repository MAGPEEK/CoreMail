/**
 * Admin API: BCP dashboard card "Zertifikat einrichten" (10.4.2,
 * docs/setup-wizard.md, docs/certificates.md).
 *
 *   GET  /api/v1/admin/setup-state                          { certificateCard, publicHostname, hostname, acmeEmail }
 *   POST /api/v1/admin/setup-state/certificate-hint/dismiss  "Später" — hides the card for everyone
 *
 * Area `servers` (read: GET; write: POST), organisation-wide only (scope
 * decision in docs/rbac.md). The card shows while no trusted certificate
 * covers the public host name (the certificate the HTTPS server serves for it,
 * lib/served-https-cert.ts) and only to roles that may manage certificates —
 * read-only roles always get `certificateCard: false`. The card itself runs the
 * certificates page's ACME flow (/admin/certificates/*). Mutations are audited
 * by the admin audit middleware.
 *
 * 10.5: `publicHostname` stays the name a Let's Encrypt order may use (null for
 * a local / private name); `hostname` is the configured name whenever the card
 * may show for it — the BCP card offers "Eigene Domain hinzufügen" instead of
 * Let's Encrypt when it is local (admin-panel lib/localHostname.ts).
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { prisma } from '@coremail/storage';
import { requireArea } from '../../middleware/auth.js';
import { canAccess } from '../../lib/rbac.js';
import { certificateCardVisible, isIssuableHostname, isLocalSetupHostname } from '../../lib/setup-state.js';
import { loadServedHttpsCert } from '../../lib/served-https-cert.js';

export const adminSetupStateRouter: RouterType = Router();
adminSetupStateRouter.use(requireArea('servers'));

interface SetupState {
  certificateCard: boolean;
  /** The public host name a Let's Encrypt order may use, else null. */
  publicHostname: string | null;
  /** 10.5: the configured host name when it is public or a local setup name (mail.example.local), else null. */
  hostname: string | null;
  /** Contact address for the ACME account: ServerSettings.adminEmail, else the viewer's own address. */
  acmeEmail: string | null;
}

async function currentState(req: Request): Promise<SetupState> {
  const s = await prisma.serverSettings.findUnique({
    where: { id: 'singleton' },
    select: { publicHostname: true, setupCertificateHintDismissedAt: true, adminEmail: true },
  });
  const host = (s?.publicHostname ?? '').trim().toLowerCase();
  const publicHostname = isIssuableHostname(host) ? host : null;
  const hostname = publicHostname ?? (isLocalSetupHostname(host) ? host : null);
  const acmeEmail = (s?.adminEmail ?? '').trim() || req.apiUser?.email || null;
  const base = {
    publicHostname: host,
    servedTrusted: false,
    dismissedAt: s?.setupCertificateHintDismissedAt ?? null,
    canManageCertificates: canAccess(req.apiUser?.role, 'servers', 'POST'),
  };
  // Only look at the certificates when the card could show at all.
  if (!certificateCardVisible(base)) return { certificateCard: false, publicHostname, hostname, acmeEmail };
  const served = await loadServedHttpsCert();
  return {
    certificateCard: certificateCardVisible({ ...base, servedTrusted: served.cert?.trusted === true }),
    publicHostname,
    hostname,
    acmeEmail,
  };
}

adminSetupStateRouter.get('/', async (req: Request, res: Response) => {
  res.json(await currentState(req));
});

adminSetupStateRouter.post('/certificate-hint/dismiss', async (req: Request, res: Response) => {
  await prisma.serverSettings.update({
    where: { id: 'singleton' },
    data: { setupCertificateHintDismissedAt: new Date() },
  });
  res.json(await currentState(req));
});
