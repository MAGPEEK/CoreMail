/**
 * 10.6: public self-registration (docs/self-registration.md), mounted at
 * /auth/register before the /auth login limiter.
 *
 *   GET  /auth/register/config → { enabled: true, domains, inviteRequired, mode, minPasswordLength, formToken }
 *                                 404 when switched off or no allowed domain (like an unknown path)
 *   POST /auth/register        → 201 { status: 'pending' | 'active', email }
 *                                 400 INVALID_FORM | INVALID_INPUT | INVALID_LOCAL_PART | INVALID_NAME |
 *                                     PASSWORD_POLICY | DOMAIN_NOT_ALLOWED | INVITE_INVALID
 *                                 409 ADDRESS_UNAVAILABLE (taken AND reserved — one answer)
 *                                 429 RATE_LIMITED | 503 maintenance | 404 when off
 *
 * Abuse protection: the IP block list guard of the gateway (every path), the
 * shared web lockout (a locked client IP gets 429 before any work; honeypot,
 * too-fast forms, forged form tokens, tampered domains and wrong invite codes
 * count as failed attempts for the IP), a per-IP and a global hourly budget,
 * a honeypot field (`website`) and a signed form token with a minimum fill time
 * (lib/self-registration.ts). Every refusal is recorded as a security event
 * (REGISTRATION_ABUSE, protocol web). Accounts get the role USER only; the
 * request body cannot choose a role, quota or state.
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger, hashPassword } from '@coremail/core';
import { prisma, ensureMailboxProvisioned, recordSecurityEvent, sharedLoginLockout } from '@coremail/storage';
import { authRedis, checkPasswordPolicy, requestIpTrusted } from '@coremail/storage/auth';
import { addressCollision } from '../lib/address-collision.js';
import { audit } from '../lib/audit.js';
import {
  checkFormToken, hashInviteCode, inviteStatus, isReservedLocalPart, issueFormToken, loadSelfRegistrationSettings,
  normalizeDisplayName, normalizeInviteCode, normalizeLocalPart, openDomains,
} from '../lib/self-registration.js';
import { notifyPendingRegistration } from '../lib/self-registration-notify.js';

const log = createLogger('self-registration');
export const selfRegistrationRouter: RouterType = Router();

/** Registration attempts per client IP and hour / server-wide per hour. */
export const REGISTER_LIMITS = Object.freeze({
  perIpPerHour: envInt('SELF_REGISTRATION_PER_IP_PER_HOUR', 10),
  globalPerHour: envInt('SELF_REGISTRATION_PER_HOUR', 200),
});

function envInt(name: string, fallback: number): number {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const NOT_FOUND = { error: 'Not found' } as const;
const UNAVAILABLE = { error: 'Diese Adresse ist nicht verfügbar.', code: 'ADDRESS_UNAVAILABLE' } as const;

const RegisterSchema = z.object({
  domainId: z.string().min(1).max(64),
  displayName: z.string().max(200),
  localPart: z.string().max(200),
  password: z.string().min(1).max(1024),
  inviteCode: z.string().max(100).optional(),
  // honeypot — hidden from people, must stay empty
  website: z.string().max(500).optional(),
  formToken: z.string().max(200),
});

function clientIp(req: Request): string {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}

function refusalEvent(req: Request, reason: string, target?: string): void {
  recordSecurityEvent({
    type: 'REGISTRATION_ABUSE', ip: clientIp(req), protocol: 'web',
    ...(target ? { target } : {}), detail: { reason, path: '/auth/register' },
  });
}

/** Counts one hourly attempt; true when the per-IP or the global budget is exhausted. */
async function overBudget(ip: string): Promise<boolean> {
  const redis = authRedis();
  const hour = Math.floor(Date.now() / 3_600_000);
  const bump = async (key: string): Promise<number> => {
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, 3_700);
    return n;
  };
  const [perIp, global] = await Promise.all([bump(`selfreg:ip:${ip}:${hour}`), bump(`selfreg:all:${hour}`)]);
  return perIp > REGISTER_LIMITS.perIpPerHour || global > REGISTER_LIMITS.globalPerHour;
}

// ── GET /auth/register/config ────────────────────────────────────────────────
selfRegistrationRouter.get('/config', async (_req: Request, res: Response) => {
  const s = await loadSelfRegistrationSettings();
  const domains = s.enabled ? await openDomains(s.domainIds) : [];
  res.setHeader('Cache-Control', 'no-store');
  if (!s.enabled || domains.length === 0) { res.status(404).json(NOT_FOUND); return; }
  res.json({
    enabled: true,
    domains,
    inviteRequired: s.inviteOnly,
    mode: s.mode,
    minPasswordLength: s.minPasswordLength,
    formToken: issueFormToken(),
  });
});

// ── POST /auth/register ──────────────────────────────────────────────────────
selfRegistrationRouter.post('/', async (req: Request, res: Response) => {
  const s = await loadSelfRegistrationSettings();
  const domains = s.enabled ? await openDomains(s.domainIds) : [];
  if (!s.enabled || domains.length === 0) { res.status(404).json(NOT_FOUND); return; }
  if (s.maintenanceMode) { res.status(503).json({ error: 'maintenance' }); return; }

  const ip = clientIp(req);
  const hints = { ipTrusted: requestIpTrusted(req) };
  const lockout = sharedLoginLockout('web');
  const lockedFor = await lockout.ipLockedFor(ip);
  if (lockedFor > 0) {
    refusalEvent(req, 'ip-locked');
    res.setHeader('Retry-After', String(lockedFor));
    res.status(429).json({ error: 'Zu viele Versuche. Bitte später erneut versuchen.', code: 'RATE_LIMITED' });
    return;
  }
  if (await overBudget(ip)) {
    refusalEvent(req, 'rate-limit');
    res.setHeader('Retry-After', '3600');
    res.status(429).json({ error: 'Zu viele Registrierungen. Bitte später erneut versuchen.', code: 'RATE_LIMITED' });
    return;
  }
  /** Abuse signal: counts against the client IP in the shared lockout. */
  const abuse = async (reason: string, status: number, body: Record<string, unknown>): Promise<void> => {
    refusalEvent(req, reason);
    await lockout.failIp(ip, hints);
    res.status(status).json(body);
  };

  const parsed = RegisterSchema.safeParse(req.body ?? {});
  if (!parsed.success) { refusalEvent(req, 'invalid-input'); res.status(400).json({ error: 'Ungültige Eingabe', code: 'INVALID_INPUT' }); return; }
  const body = parsed.data;
  const invalidForm = { error: 'Das Formular konnte nicht verarbeitet werden. Bitte laden Sie die Seite neu.', code: 'INVALID_FORM' };
  if (body.website && body.website.trim() !== '') { await abuse('honeypot', 400, invalidForm); return; }
  const token = checkFormToken(body.formToken);
  if (token !== 'ok') { await abuse(`form-${token}`, 400, invalidForm); return; }

  const domain = domains.find((d) => d.id === body.domainId);
  if (!domain) { await abuse('domain-not-allowed', 400, { error: 'Diese Domain ist nicht für die Registrierung freigegeben.', code: 'DOMAIN_NOT_ALLOWED' }); return; }

  // Invite code before the address check: without a valid code no address can be probed.
  let inviteId: string | null = null;
  let inviteUses = 0;
  if (s.inviteOnly) {
    const code = normalizeInviteCode(body.inviteCode ?? '');
    const invite = code ? await prisma.selfRegistrationInvite.findUnique({ where: { codeHash: hashInviteCode(code) } }) : null;
    if (!invite || inviteStatus(invite) !== 'active') {
      await abuse('invite-invalid', 400, { error: 'Der Einladungscode ist ungültig oder abgelaufen.', code: 'INVITE_INVALID' });
      return;
    }
    inviteId = invite.id;
    inviteUses = invite.uses;
  }

  const displayName = normalizeDisplayName(body.displayName);
  if (!displayName) { refusalEvent(req, 'invalid-name'); res.status(400).json({ error: 'Bitte geben Sie Ihren Namen an.', code: 'INVALID_NAME' }); return; }
  const localPart = normalizeLocalPart(body.localPart);
  if (!localPart) {
    refusalEvent(req, 'invalid-local-part');
    res.status(400).json({ error: 'Der Name vor dem @ darf nur Buchstaben, Ziffern, Punkt, Binde- und Unterstrich enthalten.', code: 'INVALID_LOCAL_PART' });
    return;
  }
  const policyError = await checkPasswordPolicy(body.password);
  if (policyError) { refusalEvent(req, 'password-policy'); res.status(400).json({ error: policyError, code: 'PASSWORD_POLICY' }); return; }

  const email = `${localPart}@${domain.name.toLowerCase()}`;
  // Taken (user, shared mailbox, alias) and reserved names get the same answer.
  if (isReservedLocalPart(localPart) || (await addressCollision(email)) !== null) {
    refusalEvent(req, 'address-unavailable', email);
    res.status(409).json(UNAVAILABLE);
    return;
  }

  const passwordHash = await hashPassword(body.password);
  const active = s.mode === 'immediate';
  let userId: string;
  try {
    userId = await prisma.$transaction(async (tx) => {
      if (inviteId) {
        // compare-and-set on the use counter: two registrations never share the last use
        const used = await tx.selfRegistrationInvite.updateMany({
          where: { id: inviteId, uses: inviteUses, revokedAt: null },
          data: { uses: { increment: 1 } },
        });
        if (used.count !== 1) throw Object.assign(new Error('invite race'), { code: 'INVITE_RACE' });
      }
      const user = await tx.user.create({
        data: {
          email, displayName, passwordHash, domainId: domain.id,
          // fixed: self-registered accounts are local USER accounts — never an admin role.
          // 10.6 review: the SelfRegistration row below marks the account for good — it is
          // never linked to an OIDC subject nor taken over by LDAP (storage auth/account-linking.ts)
          role: 'USER', authSource: 'LOCAL', active,
        },
        select: { id: true },
      });
      await tx.selfRegistration.create({
        data: {
          userId: user.id, domainId: domain.id, status: active ? 'IMMEDIATE' : 'PENDING', ipAddress: ip.slice(0, 64),
          ...(inviteId ? { inviteId } : {}),
        },
      });
      return user.id;
    });
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === 'P2002') { refusalEvent(req, 'address-unavailable', email); res.status(409).json(UNAVAILABLE); return; }
    if (code === 'INVITE_RACE') {
      await abuse('invite-invalid', 400, { error: 'Der Einladungscode ist ungültig oder abgelaufen.', code: 'INVITE_INVALID' });
      return;
    }
    throw err;
  }

  try {
    await ensureMailboxProvisioned(userId);
  } catch (err) {
    log.error({ err, userId }, 'self-registration: mailbox provisioning failed — account removed');
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    res.status(500).json({ error: 'Internal server error' });
    return;
  }

  audit({
    actorId: userId, actorEmail: email,
    action: active ? 'auth.register.active' : 'auth.register.pending',
    targetType: 'mailbox', targetId: userId, targetName: email,
    changes: { domain: domain.name, mode: s.mode, ...(inviteId ? { inviteId } : {}) },
    ipAddress: ip, userAgent: req.get('user-agent') ?? '',
  });
  log.info({ userId, email, mode: s.mode }, 'self-registration: account created');
  if (!active) void notifyPendingRegistration({ email, domain: domain.name });
  res.status(201).json({ status: active ? 'active' : 'pending', email });
});
