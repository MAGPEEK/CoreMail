/**
 * 10.6: passkeys (docs/passkeys.md). Proxied by the api-gateway.
 *
 * Public (/auth/passkey, own per-IP limiter in the gateway):
 *   GET  /status            { enabled }  — show the "sign in with a passkey" button
 *   POST /login/options     → { flowId, publicKey }; the flow is bound to the HttpOnly
 *                             SameSite=Strict cookie cm_pk (Path=/auth/passkey, 300 s)
 *   POST /login/verify      { flowId?, response } → session (cm_rt / cm_rt_bcp like
 *                             /auth/login) or PASSKEY_UNKNOWN / PASSKEY_NOT_ELIGIBLE /
 *                             PASSKEYS_DISABLED / PROTOCOL_DISABLED / maintenance /
 *                             PASSKEY_CHALLENGE_EXPIRED / IP_LOCKED / IP_BLOCKED
 *   POST /recovery/options  { token } → registration options of an admin recovery link
 *   POST /recovery/verify   { token, flowId, response, name } → { ok } (no session)
 *
 * Signed-in user (/auth/passkeys, Bearer):
 *   GET    /                          list + policy
 *   POST   /registration/options      re-auth (currentPassword | mfaCode | passkey) → { flowId, publicKey }
 *   POST   /registration/verify       { flowId, response, name } → 201 { credential }
 *   PATCH  /:id                       { name }
 *   DELETE /:id                       re-auth; 409 LAST_PASSKEY for a passkey-only account
 *   POST   /reauth/options            → { flowId, publicKey } for verifyReauth (404 without passkeys)
 *   GET    /signal                    data for the WebAuthn Signal API
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@coremail/core';
import { prisma } from '@coremail/storage';
import {
  clientInfoOf, deleteCredential, isSecureRequest, isWebClient, listCredentials, loadPasskeyServerPolicy,
  passkeysAllowedFor, passkeysEnabledAnywhere, readCookie, renameCredential, tokenPairResponse,
} from '@coremail/storage/auth';
import {
  completePasskeyLogin, completeRecovery, getRpConfig, passkeyLoginOptions, passkeyReadiness, passkeyReauthOptions,
  passkeyRegistrationOptions, passkeySignalData, recoveryRegistrationOptions, verifyPasskeyRegistration,
  type PasskeyErrorCode,
} from '@coremail/storage/auth/webauthn';
import { requireBearerSession } from './bearer.js';
import { requireReauth } from './mfa.js';

const log = createLogger('auth:passkeys');

export const PASSKEY_FLOW_COOKIE = 'cm_pk';
const FLOW_COOKIE_PATH = '/auth/passkey';
const FLOW_TTL = 300;

function flowCookie(req: Request, value: string, maxAge: number): string {
  const expires = maxAge <= 0 ? '; Expires=Thu, 01 Jan 1970 00:00:00 GMT' : '';
  return `${PASSKEY_FLOW_COOKIE}=${value}; Path=${FLOW_COOKIE_PATH}; Max-Age=${maxAge}${expires}; HttpOnly; SameSite=Strict${isSecureRequest(req) ? '; Secure' : ''}`;
}

const ERROR_STATUS: Record<PasskeyErrorCode, number> = {
  PASSKEY_CHALLENGE_EXPIRED: 401,
  PASSKEY_UNKNOWN: 401,
  PASSKEY_NOT_ELIGIBLE: 403,
  PASSKEY_INVALID: 400,
  PASSKEY_DUPLICATE: 409,
  PASSKEY_ID_TOO_LONG: 400,
  PASSKEY_COUNTER: 400,
  PASSKEYS_DISABLED: 403,
  PASSKEY_RECOVERY_INVALID: 400,
};
const ERROR_TEXT: Record<PasskeyErrorCode, string> = {
  PASSKEY_CHALLENGE_EXPIRED: 'The request expired — please try again',
  PASSKEY_UNKNOWN: 'This passkey is not registered',
  PASSKEY_NOT_ELIGIBLE: 'This security key can only be used as a second factor',
  PASSKEY_INVALID: 'Passkey verification failed',
  PASSKEY_DUPLICATE: 'This passkey is already registered',
  PASSKEY_ID_TOO_LONG: 'The credential id is too long',
  PASSKEY_COUNTER: 'Passkey verification failed',
  PASSKEYS_DISABLED: 'Passkeys are not enabled for this account',
  PASSKEY_RECOVERY_INVALID: 'The recovery link is invalid, expired or already used',
};
function sendError(res: Response, code: PasskeyErrorCode): void {
  res.status(ERROR_STATUS[code]).json({ error: ERROR_TEXT[code], code });
}

type Handler = (req: Request, res: Response) => Promise<void>;
function safe(fn: Handler) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await fn(req, res);
    } catch (err) {
      log.error({ err, path: req.path }, 'Passkey route error');
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    }
  };
}

// ── Public: sign-in, recovery ─────────────────────────────────────────────────

export const passkeyPublicRouter: RouterType = Router();
passkeyPublicRouter.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

passkeyPublicRouter.get('/status', safe(async (_req, res) => {
  const policy = await loadPasskeyServerPolicy();
  res.json({ enabled: policy.passwordless && await passkeysEnabledAnywhere() });
}));

passkeyPublicRouter.post('/login/options', safe(async (req, res) => {
  if (!(await passkeysEnabledAnywhere())) { sendError(res, 'PASSKEYS_DISABLED'); return; }
  const opts = await passkeyLoginOptions(clientInfoOf(req).surface);
  if (!opts) { sendError(res, 'PASSKEYS_DISABLED'); return; }
  res.append('Set-Cookie', flowCookie(req, opts.flowId, FLOW_TTL));
  res.json(opts);
}));

const VerifySchema = z.object({ flowId: z.string().min(16).max(256).optional(), response: z.unknown() });

passkeyPublicRouter.post('/login/verify', safe(async (req, res) => {
  const parsed = VerifySchema.safeParse(req.body);
  if (!parsed.success || parsed.data.response === undefined) { res.status(400).json({ error: 'Invalid request' }); return; }
  // The flow is bound to the browser that asked for it: the cookie must carry the
  // same flow id (browsers always send it; other clients may send only the cookie).
  const cookie = readCookie(req.headers, PASSKEY_FLOW_COOKIE);
  const flowId = parsed.data.flowId ?? cookie;
  if (!flowId || (cookie && cookie !== flowId) || (!cookie && isWebClient(req.headers))) {
    res.append('Set-Cookie', flowCookie(req, '', 0));
    sendError(res, 'PASSKEY_CHALLENGE_EXPIRED');
    return;
  }
  const outcome = await completePasskeyLogin(flowId, parsed.data.response, clientInfoOf(req));
  res.append('Set-Cookie', flowCookie(req, '', 0));
  if (outcome.kind === 'tokens') {
    const r = tokenPairResponse(req, outcome.tokens);
    if (r.setCookie) res.append('Set-Cookie', r.setCookie);
    res.json(r.body);
    return;
  }
  if (outcome.headers) res.set(outcome.headers);
  res.status(outcome.status).json(outcome.body);
}));

passkeyPublicRouter.post('/recovery/options', safe(async (req, res) => {
  const token = (req.body as { token?: unknown } | undefined)?.token;
  const r = await recoveryRegistrationOptions(token);
  if ('error' in r) { sendError(res, r.error); return; }
  res.json(r);
}));

const RecoverySchema = z.object({
  token: z.string().min(20).max(128),
  flowId: z.string().min(16).max(256),
  response: z.unknown(),
  name: z.string().max(100).optional(),
});

passkeyPublicRouter.post('/recovery/verify', safe(async (req, res) => {
  const parsed = RecoverySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }
  const r = await completeRecovery({ ...parsed.data, name: parsed.data.name, ip: req.ip });
  if (!r.ok) { sendError(res, r.code); return; }
  res.json({ ok: true, credential: r.credential });
}));

// ── Signed-in user ────────────────────────────────────────────────────────────

export const passkeyUserRouter: RouterType = Router();
passkeyUserRouter.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

type UserHandler = (req: Request, res: Response, ctx: { userId: string; sessionId: string | null }) => Promise<void>;
function authed(fn: UserHandler) {
  return safe(async (req, res) => {
    const s = await requireBearerSession(req, res);
    if (!s) return;
    await fn(req, res, s);
  });
}

async function accountOf(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, displayName: true, domainId: true, authSource: true, passwordLoginDisabled: true },
  });
}

passkeyUserRouter.get('/', authed(async (_req, res, { userId }) => {
  const user = await accountOf(userId);
  if (!user) { res.status(404).json({ error: 'Not found' }); return; }
  const [passkeys, server, allowed, rp] = await Promise.all([
    listCredentials(userId), loadPasskeyServerPolicy(), passkeysAllowedFor(user), getRpConfig(),
  ]);
  res.json({
    passkeys,
    allowed,
    passwordless: server.passwordless,
    passwordLoginDisabled: user.passwordLoginDisabled === true,
    // OIDC-only accounts sign in at their identity provider — no passkeys (docs/passkeys.md)
    eligible: String(user.authSource) !== 'OIDC',
    rpId: rp.rpID,
    ready: passkeyReadiness(rp).ready,
  });
}));

passkeyUserRouter.post('/registration/options', authed(async (req, res, { userId, sessionId }) => {
  const user = await accountOf(userId);
  if (!user) { res.status(404).json({ error: 'Not found' }); return; }
  if (String(user.authSource) === 'OIDC' || !(await passkeysAllowedFor(user))) { sendError(res, 'PASSKEYS_DISABLED'); return; }
  if (!(await requireReauth(req, res, userId))) return;
  const opts = await passkeyRegistrationOptions(user, { purpose: 'register', sessionId: sessionId ?? undefined });
  res.json(opts);
}));

const RegisterSchema = z.object({ flowId: z.string().min(16).max(256), response: z.unknown(), name: z.string().max(100).optional() });

passkeyUserRouter.post('/registration/verify', authed(async (req, res, { userId }) => {
  const parsed = RegisterSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }
  const user = await accountOf(userId);
  if (!user || String(user.authSource) === 'OIDC' || !(await passkeysAllowedFor(user))) { sendError(res, 'PASSKEYS_DISABLED'); return; }
  const r = await verifyPasskeyRegistration({ userId, flowId: parsed.data.flowId, response: parsed.data.response, name: parsed.data.name, ip: req.ip });
  if (!r.ok) { sendError(res, r.code); return; }
  res.status(201).json({ credential: r.credential });
}));

passkeyUserRouter.post('/reauth/options', authed(async (_req, res, { userId, sessionId }) => {
  const opts = await passkeyReauthOptions(userId, sessionId);
  if (!opts) { res.status(404).json({ error: 'No passkey registered', code: 'NO_PASSKEY' }); return; }
  res.json(opts);
}));

passkeyUserRouter.get('/signal', authed(async (_req, res, { userId }) => {
  const data = await passkeySignalData(userId);
  if (!data) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(data);
}));

passkeyUserRouter.patch('/:id', authed(async (req, res, { userId }) => {
  const parsed = z.object({ name: z.string().min(1).max(100) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid name' }); return; }
  const row = await renameCredential(userId, String(req.params['id'] ?? ''), parsed.data.name);
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ credential: row });
}));

passkeyUserRouter.delete('/:id', authed(async (req, res, { userId }) => {
  if (!(await requireReauth(req, res, userId))) return;
  const user = await accountOf(userId);
  const r = await deleteCredential(userId, String(req.params['id'] ?? ''), { id: userId, email: user?.email, ip: req.ip });
  if (r === 'not_found') { res.status(404).json({ error: 'Not found' }); return; }
  if (r === 'last_passkey') {
    res.status(409).json({ error: 'The last passkey of a passkey-only account cannot be removed', code: 'LAST_PASSKEY' });
    return;
  }
  res.json({ ok: true });
}));
