/**
 * Setup wizard after the commit (10.4.2, docs/setup-wizard.md).
 *
 *   GET  /api/v1/setup/secrets-download  the secrets file as an attachment
 *   POST /api/v1/setup/finish            the wizard reached its summary
 *
 * Both need the admin session the wizard signs in with after
 * POST /setup/complete: ORGANIZATION_MANAGEMENT, organisation-wide
 * (requireRoleInSetupWindow — current role from the DB). The download is open only while
 * the wizard has not finished and at most 24 h after the setup was completed
 * (lib/setup-secrets.ts secretsDownloadWindowOpen); outside that window, and
 * when there is no file, it answers 404 like an unknown route. Every download
 * (and every refused attempt of a signed-in admin) is audited as
 * `setup.secrets.download` — never with the file content. Mounted before the
 * setup router with its own rate limit (middleware/security.ts
 * setupFollowUpRateLimit). 10.5: the admin-MFA rule does not apply to these two
 * routes (requireRoleInSetupWindow) — fresh installations start with
 * requireMfaForAdmins on and the wizard's session has no second factor yet.
 *
 * 10.6: the certificate step (Let's Encrypt for a public host name,
 * lib/setup-certificate.ts) — same guard and the same window:
 *
 *   GET  /api/v1/setup/certificate/status     names of the order, contact default,
 *                                             the CA's terms of service, the order's state
 *   POST /api/v1/setup/certificate/preflight  the BCP pre-flight (incl. the staging test)
 *   POST /api/v1/setup/certificate/issue      { email, termsAccepted: true } → order with
 *                                             SMTP/IMAP/POP3, HTTPS once issued
 *
 * The admin certificate routes stay behind the admin-MFA rule; these call the
 * same ACME functions (lib/acme-order.ts). Outside the window, and for a local /
 * private host name (409 LOCAL_HOSTNAME), nothing is ordered. Pre-flight, order
 * and the HTTPS assignment are audited as `setup.certificate.*` (always, like
 * `setup.secrets.*`); own rate limits (setupCertificateRateLimit, status:
 * setupCertificateStatusRateLimit).
 */
import { Router, type Router as RouterType, type Request, type Response, type RequestHandler } from 'express';
import { z } from 'zod';
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';
import { requireRoleInSetupWindow } from '../middleware/auth.js';
import {
  setupCertificateRateLimit, setupCertificateStatusRateLimit, setupFollowUpRateLimit,
} from '../middleware/security.js';
import { audit, auditContext } from '../lib/audit.js';
import {
  readSecretsForDownload, removeStagedSecretsCopy, secretsDownloadFilename, secretsDownloadWindowOpen,
} from '../lib/setup-secrets.js';
import {
  acmeTermsOfServiceUrl, activateHttpsCertificate, LE_REPOSITORY_URL, preflightForServer,
  requestLetsEncryptCertificate, type DirectoryFetch,
} from '../lib/acme-order.js';
import { renewalSettled, startRenewal } from '../lib/cert-renewal.js';
import { MAIL_SERVICES } from '../lib/protocol-cert-assign.js';
import {
  configuredHostname, defaultContactEmail, findSetupCertificate, isInProgress, isIssued, setupCertificatePlan, viewOf,
  type SetupCertificateRow,
} from '../lib/setup-certificate.js';
import { isIssuableHostname } from '../lib/setup-state.js';

export interface SetupLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export interface SetupFollowUpOptions {
  log?: SetupLogger;
  /** Replaces the rate limit (tests). */
  rateLimit?: RequestHandler;
  /** 10.6: replaces the certificate rate limits (tests). */
  certificateRateLimit?: RequestHandler;
  certificateStatusRateLimit?: RequestHandler;
  /** 10.6: reads the ACME directory for the terms of service (tests). */
  fetchDirectory?: DirectoryFetch;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/** body of POST /setup/certificate/issue */
const IssueSchema = z.object({
  email: z.string().trim().max(254).email(),
  termsAccepted: z.literal(true),
});

const NOT_FOUND = { error: 'Not found' };

export function createSetupFollowUpRouter(opts: SetupFollowUpOptions = {}): RouterType {
  const log = opts.log ?? createLogger('api:setup');
  const limit = opts.rateLimit ?? setupFollowUpRateLimit;
  const env = (): NodeJS.ProcessEnv => opts.env ?? process.env;
  const now = (): Date => (opts.now ? opts.now() : new Date());
  const router: RouterType = Router();

  const refuse = (req: Request, res: Response, reason: string): void => {
    audit({
      ...(req.apiUser ? { actorId: req.apiUser.userId, actorEmail: req.apiUser.email } : {}),
      action: 'setup.secrets.download', targetType: 'secrets', targetName: 'coremail.env',
      ...auditContext(req), success: false, errorMsg: reason,
    });
    res.status(404).json(NOT_FOUND);
  };

  router.get('/secrets-download', limit, requireRoleInSetupWindow(), async (req: Request, res: Response) => {
    const s = await prisma.serverSettings.findUnique({
      where: { id: 'singleton' },
      select: { setupCompletedAt: true, setupWizardFinishedAt: true, publicHostname: true },
    });
    if (!secretsDownloadWindowOpen(s, now())) {
      await removeStagedSecretsCopy(env());
      log.warn({ userId: req.apiUser?.userId }, 'Secrets download refused: outside the setup window');
      refuse(req, res, 'outside the setup window');
      return;
    }
    const content = await readSecretsForDownload(env());
    if (!content) {
      log.warn({ userId: req.apiUser?.userId }, 'Secrets download refused: no readable secrets file');
      refuse(req, res, 'no secrets file');
      return;
    }
    const filename = secretsDownloadFilename(s?.publicHostname, now());
    audit({
      ...(req.apiUser ? { actorId: req.apiUser.userId, actorEmail: req.apiUser.email } : {}),
      action: 'setup.secrets.download', targetType: 'secrets', targetName: 'coremail.env',
      ...auditContext(req), success: true,
    });
    log.info({ userId: req.apiUser?.userId, bytes: content.length }, 'Secrets file downloaded by the setup wizard');
    res.set({
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.status(200).end(content);
  });

  router.post('/finish', limit, requireRoleInSetupWindow(), async (req: Request, res: Response) => {
    const r = await prisma.serverSettings.updateMany({
      where: { id: 'singleton', setupCompletedAt: { not: null }, setupWizardFinishedAt: null },
      data: { setupWizardFinishedAt: now() },
    });
    await removeStagedSecretsCopy(env());
    if (r.count > 0) log.info({ userId: req.apiUser?.userId }, 'Setup wizard finished — secrets download closed');
    res.status(204).end();
  });

  // ── 10.6: certificate step ──────────────────────────────────────────────────

  const certLimit = opts.certificateRateLimit ?? setupCertificateRateLimit;
  const statusLimit = opts.certificateStatusRateLimit ?? setupCertificateStatusRateLimit;

  type Actor = { actorId?: string; actorEmail?: string; ipAddress?: string; userAgent?: string };
  const actorOf = (req: Request): Actor => ({
    ...(req.apiUser ? { actorId: req.apiUser.userId, actorEmail: req.apiUser.email } : {}),
    ...auditContext(req),
  });

  /** setupCompletedAt while the setup window is open, else null. */
  const openWindow = async (): Promise<Date | null> => {
    const s = await prisma.serverSettings.findUnique({
      where: { id: 'singleton' }, select: { setupCompletedAt: true, setupWizardFinishedAt: true },
    });
    return secretsDownloadWindowOpen(s, now()) ? (s?.setupCompletedAt ?? null) : null;
  };

  const refuseCert = (req: Request, res: Response, action: 'preflight' | 'issue'): void => {
    audit({
      ...actorOf(req), action: `setup.certificate.${action}`, targetType: 'certificate',
      success: false, errorMsg: 'outside the setup window',
    });
    log.warn({ userId: req.apiUser?.userId, action }, 'Setup certificate request refused: outside the setup window');
    res.status(404).json(NOT_FOUND);
  };

  const LOCAL_HOSTNAME = {
    error: 'The host name is local / private — Let\'s Encrypt cannot issue for it',
    code: 'LOCAL_HOSTNAME',
  } as const;

  // Certificates this process already watches for the HTTPS assignment.
  const watching = new Set<string>();

  /** Once the running issuance of `certId` succeeds, serve the certificate on HTTPS too (like the dashboard card). */
  const assignHttpsWhenIssued = (certId: string, actor: Actor, hostname: string): void => {
    const settled = renewalSettled(certId);
    if (!settled || watching.has(certId)) return;
    watching.add(certId);
    void settled.then(async (ok) => {
      if (!ok) return;
      await assignHttps(certId, actor, hostname);
    }).catch((err: unknown) => log.warn({ err, certId }, 'HTTPS assignment after the setup issuance failed'))
      .finally(() => watching.delete(certId));
  };

  const assignHttps = async (certId: string, actor: Actor, hostname: string): Promise<boolean> => {
    const r = await activateHttpsCertificate(certId);
    audit({
      ...actor, action: 'setup.certificate.https', targetType: 'certificate', targetId: certId, targetName: hostname,
      success: r.ok, ...(r.ok ? {} : { errorMsg: r.reason }),
    });
    if (r.ok) log.info({ certId }, 'Setup certificate issued and assigned to HTTPS (SMTP/IMAP/POP3 by the issuance)');
    else log.warn({ certId, reason: r.reason }, 'Setup certificate could not be assigned to HTTPS');
    return r.ok;
  };

  router.get('/certificate/status', statusLimit, requireRoleInSetupWindow(), async (req: Request, res: Response) => {
    const since = await openWindow();
    if (!since) { res.status(404).json(NOT_FOUND); return; }
    const host = await configuredHostname();
    const existing = isIssuableHostname(host) ? await findSetupCertificate(host, since) : null;
    const certificate = existing ? viewOf(existing, now()) : null;
    // While polling the wizard only needs the order's state (no DNS look-ups).
    if (req.query['view'] === 'certificate') {
      res.json({ eligible: isIssuableHostname(host), hostname: host || null, certificate });
      return;
    }
    const plan = await setupCertificatePlan();
    const tos = plan.eligible
      ? await acmeTermsOfServiceUrl(opts.fetchDirectory ? { fetchDirectory: opts.fetchDirectory } : {})
      : null;
    res.json({
      eligible: plan.eligible,
      hostname: plan.hostname,
      domains: plan.domains,
      sans: plan.sans,
      contactEmail: plan.eligible ? await defaultContactEmail(req.apiUser?.email, existing) : null,
      termsOfServiceUrl: tos ?? LE_REPOSITORY_URL,
      termsOfServiceFromDirectory: tos !== null,
      certificate,
    });
  });

  router.post('/certificate/preflight', certLimit, requireRoleInSetupWindow(), async (req: Request, res: Response) => {
    if (!(await openWindow())) { refuseCert(req, res, 'preflight'); return; }
    const plan = await setupCertificatePlan();
    if (!plan.eligible || !plan.hostname) { res.status(409).json(LOCAL_HOSTNAME); return; }
    const report = await preflightForServer(plan.domains, { external: true });
    audit({
      ...actorOf(req), action: 'setup.certificate.preflight', targetType: 'certificate', targetName: plan.hostname,
      changes: { domains: plan.domains, ok: report.ok, external: report.external.status },
      success: report.ok, ...(report.ok ? {} : { errorMsg: 'prerequisites not met' }),
    });
    log.info({ domains: plan.domains, ok: report.ok, external: report.external.status }, 'Setup wizard: Let\'s Encrypt pre-flight');
    res.json({ domains: plan.domains, report });
  });

  router.post('/certificate/issue', certLimit, requireRoleInSetupWindow(), async (req: Request, res: Response) => {
    const since = await openWindow();
    if (!since) { refuseCert(req, res, 'issue'); return; }
    const parsed = IssueSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const termsIssue = parsed.error.issues.some((i) => i.path[0] === 'termsAccepted');
      res.status(400).json(termsIssue
        ? { error: 'The Let\'s Encrypt terms of service must be accepted', code: 'TERMS_REQUIRED' }
        : { error: 'A valid contact e-mail address is required', code: 'INVALID_EMAIL' });
      return;
    }
    const email = parsed.data.email.toLowerCase();
    const plan = await setupCertificatePlan();
    if (!plan.eligible || !plan.hostname) { res.status(409).json(LOCAL_HOSTNAME); return; }
    const hostname = plan.hostname;
    const actor = actorOf(req);
    const auditIssue = (success: boolean, certId: string, extra: Record<string, unknown> = {}, errorMsg?: string) => audit({
      ...actor, action: 'setup.certificate.issue', targetType: 'certificate', targetId: certId, targetName: hostname,
      // the contact address is the admin's own input — kept, it is what Let's Encrypt was given
      changes: { domains: plan.domains, contactEmail: email, ...extra },
      success, ...(errorMsg ? { errorMsg } : {}),
    });

    let row: SetupCertificateRow | null = await findSetupCertificate(hostname, since);
    if (row && isIssued(row)) {
      // Idempotent: an already issued setup certificate is only (re)assigned to HTTPS.
      if (!row.isActiveHttps) await assignHttps(row.id, actor, hostname);
      row = await findSetupCertificate(hostname, since);
      res.status(200).json({ certificate: row ? viewOf(row, now()) : null });
      return;
    }
    if (row && isInProgress(row)) {
      // Running (or left PENDING by a restart — startRenewal takes a dead lock over).
      if (!renewalSettled(row.id)) await startRenewal(row.id, 'issue').catch(() => undefined);
      assignHttpsWhenIssued(row.id, actor, hostname);
      res.status(202).json({ certificate: viewOf(row, now()) });
      return;
    }

    let certId: string;
    if (row) {
      // Retry of a failed setup order: same row (and ACME account), current names and contact.
      await prisma.certificate.update({ where: { id: row.id }, data: { acmeEmail: email, domains: plan.domains } });
      const started = await startRenewal(row.id, 'issue').catch((err: unknown) => ({ started: false as const, reason: String(err) }));
      if (!started.started) {
        auditIssue(false, row.id, { retry: true }, `not started (${started.reason})`);
        res.status(409).json({ error: 'The certificate order is busy — try again in a minute', code: 'BUSY' });
        return;
      }
      certId = row.id;
    } else {
      const r = await requestLetsEncryptCertificate({
        name: hostname, domains: plan.domains, email, services: [...MAIL_SERVICES], autoRenew: true, staging: false,
      });
      if (!r.ok) {
        auditIssue(false, r.id, {}, r.error);
        res.status(503).json({ error: r.error, code: 'NOT_STARTED' });
        return;
      }
      certId = r.cert.id;
    }
    auditIssue(true, certId, row ? { retry: true } : {});
    log.info({ certId, domains: plan.domains }, 'Setup wizard: Let\'s Encrypt certificate ordered');
    assignHttpsWhenIssued(certId, actor, hostname);
    const current = await findSetupCertificate(hostname, since);
    res.status(202).json({ certificate: current ? viewOf(current, now()) : null });
  });

  return router;
}

export const setupFollowUpRouter: RouterType = createSetupFollowUpRouter();
