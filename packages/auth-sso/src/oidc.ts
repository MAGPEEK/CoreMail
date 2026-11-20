/**
 * OIDC SSO login (v6.1) — authorization code flow with PKCE (S256), state and
 * nonce, run by the api-gateway routes under /auth/sso/*.
 *
 *   start     → state/nonce/code_verifier stored server-side (Redis, 10 min),
 *               bound to a browser cookie (only its SHA-256 is stored)
 *   callback  → state consumed exactly once + cookie binding checked, code
 *               exchanged with the PKCE verifier, ID token validated by
 *               openid-client (signature via discovery/JWKS, iss, aud, exp,
 *               iat, nonce), then the CoreMail account policy below
 *   exchange  → the SPA trades a one-time code (60 s, same cookie binding) for
 *               a normal CoreMail session or an MFA challenge — tokens never
 *               appear in a URL
 *
 * Account policy (callback):
 *   - `email_verified` must be true (per provider `requireEmailVerified`,
 *     default on — only for IdPs that never send the claim)
 *   - the e-mail domain must be an active CoreMail domain AND in the provider's
 *     allowed domains (`forcedDomains`; empty = the provider's own domain)
 *   - an existing account is used when it is an OIDC account of this provider
 *     (externalId `oidc:<providerId>:<sub>`, bound on first use); LOCAL/LDAP
 *     accounts only with the per-provider `allowLinking` opt-in — and (v8.1)
 *     bound to the first IdP subject that linked them (durable column
 *     `User.oidcSubject`; externalId stays the LDAP id); another subject → `account_mismatch`
 *   - unknown users are created + their mailbox provisioned with `autoProvision`
 *   - MFA: by default the IdP is trusted as second factor (no CoreMail MFA
 *     prompt). With `requireMfa` users with CoreMail MFA enrolled get the normal
 *     MFA challenge. The session counts as "MFA verified" (requireMfaForAdmins)
 *     only after that challenge or when the ID token's `amr` names an MFA method.
 *     v8.1: with requireMfaForAdmins, admin roles never get "MFA verified" from
 *     `amr` and always get the CoreMail challenge (when enrolled), unless the
 *     provider has requireMfa=false AND OIDC_TRUST_IDP_MFA_FOR_ADMINS=true.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Issuer, custom, generators, type Client, type IdTokenClaims } from 'openid-client';
import { createLogger } from '@coremail/core';
import { prisma, ensureMailboxProvisioned } from '@coremail/storage';
import {
  authRedis, createMfaChallenge, getMfaState, issueSession, maintenanceBlock, webLoginBlocked,
  type ClientInfo, type MfaMethod, type TokenPair,
} from '@coremail/storage/auth';

const log = createLogger('auth:sso');

custom.setHttpOptionsDefaults({ timeout: 8000 });

export const SSO_STATE_TTL = 10 * 60;
export const SSO_EXCHANGE_TTL = 60;
export const SSO_COOKIE = 'cm_sso';
const STATE_PREFIX = 'auth:sso:state:';
const EXCHANGE_PREFIX = 'auth:sso:exchange:';

export type SsoTarget = 'mwa' | 'bcp';

export type SsoError =
  | 'provider_unavailable' | 'invalid_state' | 'idp_error' | 'token_invalid' | 'email_missing' | 'email_unverified'
  | 'domain_not_allowed' | 'account_inactive' | 'account_not_linked' | 'account_mismatch' | 'no_account' | 'maintenance';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const random = () => randomBytes(32).toString('base64url');

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Single-use read: only the caller whose DEL removed the key gets the value. */
async function consume(key: string): Promise<string | null> {
  const r = authRedis();
  const v = await r.get(key);
  if (v === null) return null;
  return (await r.del(key)) === 1 ? v : null;
}

// ── Providers ─────────────────────────────────────────────────────────────────

export interface SsoProviderRow {
  id: string;
  domainId: string;
  name: string;
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  claimMap: unknown;
  autoProvision: boolean;
  forcedDomains: string[];
  active: boolean;
  scopes?: string;
  requireEmailVerified?: boolean;
  allowLinking?: boolean;
  requireMfa?: boolean;
  domain?: { name: string } | null;
}

/** Public list for the login pages — id + display name only, never client data. */
export async function listPublicProviders(): Promise<{ id: string; name: string }[]> {
  const rows = await prisma.oidcProvider.findMany({ where: { active: true }, orderBy: { name: 'asc' } });
  return rows.map((p) => ({ id: p.id, name: p.name }));
}

async function loadProvider(id: string): Promise<SsoProviderRow | null> {
  if (typeof id !== 'string' || id.length === 0 || id.length > 64) return null;
  const p = await prisma.oidcProvider.findUnique({ where: { id }, include: { domain: { select: { name: true } } } });
  return p && p.active ? (p as unknown as SsoProviderRow) : null;
}

const clientCache = new Map<string, { client: Client; at: number }>();
const CLIENT_TTL_MS = 10 * 60_000;

/** Drops cached discovery/clients (admin update/delete). */
export function invalidateOidcClient(providerId?: string): void {
  if (!providerId) { clientCache.clear(); return; }
  for (const k of clientCache.keys()) if (k.startsWith(`${providerId}|`)) clientCache.delete(k);
}

export async function getOidcClient(p: SsoProviderRow, redirectUri: string): Promise<Client> {
  const key = `${p.id}|${sha256(`${p.discoveryUrl}|${p.clientId}|${p.clientSecret}|${redirectUri}`)}`;
  const hit = clientCache.get(key);
  if (hit && Date.now() - hit.at < CLIENT_TTL_MS) return hit.client;
  const issuer = await Issuer.discover(p.discoveryUrl);
  const client = new issuer.Client({
    client_id: p.clientId,
    client_secret: p.clientSecret,
    redirect_uris: [redirectUri],
    response_types: ['code'],
  });
  invalidateOidcClient(p.id);
  clientCache.set(key, { client, at: Date.now() });
  return client;
}

/** Admin "test discovery": fetch + summarize the discovery document. */
export async function describeDiscovery(discoveryUrl: string): Promise<{
  issuer: string; authorizationEndpoint?: string; tokenEndpoint?: string; jwksUri?: string;
  pkceS256: boolean; scopes: string[]; idTokenAlgs: string[];
}> {
  const issuer = await Issuer.discover(discoveryUrl);
  const m = issuer.metadata as Record<string, unknown>;
  const arr = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  const out = {
    issuer: issuer.metadata.issuer,
    pkceS256: arr(m['code_challenge_methods_supported']).includes('S256'),
    scopes: arr(m['scopes_supported']),
    idTokenAlgs: arr(m['id_token_signing_alg_values_supported']),
  } as Awaited<ReturnType<typeof describeDiscovery>>;
  if (typeof m['authorization_endpoint'] === 'string') out.authorizationEndpoint = m['authorization_endpoint'];
  if (typeof m['token_endpoint'] === 'string') out.tokenEndpoint = m['token_endpoint'];
  if (typeof m['jwks_uri'] === 'string') out.jwksUri = m['jwks_uri'];
  return out;
}

// ── Start ─────────────────────────────────────────────────────────────────────

interface StateRecord {
  providerId: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  target: SsoTarget;
  binding: string; // sha256(browser cookie)
}

export function ssoRedirectUri(baseUrl: string, providerId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/auth/sso/${encodeURIComponent(providerId)}/callback`;
}

export type StartResult =
  | { ok: true; url: string; cookie: string }
  | { ok: false; error: SsoError };

export async function startSso(providerId: string, target: SsoTarget, baseUrl: string): Promise<StartResult> {
  const p = await loadProvider(providerId);
  if (!p) return { ok: false, error: 'provider_unavailable' };
  const redirectUri = ssoRedirectUri(baseUrl, p.id);
  let client: Client;
  try {
    client = await getOidcClient(p, redirectUri);
  } catch (err) {
    log.error({ err, providerId }, 'OIDC discovery failed');
    return { ok: false, error: 'provider_unavailable' };
  }
  const state = random();
  const nonce = random();
  const codeVerifier = generators.codeVerifier();
  const cookie = random();
  const rec: StateRecord = { providerId: p.id, nonce, codeVerifier, redirectUri, target, binding: sha256(cookie) };
  await authRedis().setex(`${STATE_PREFIX}${sha256(state)}`, SSO_STATE_TTL, JSON.stringify(rec));
  const url = client.authorizationUrl({
    scope: p.scopes?.trim() || 'openid email profile',
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
    nonce,
    code_challenge: generators.codeChallenge(codeVerifier),
    code_challenge_method: 'S256',
  });
  return { ok: true, url, cookie };
}

// ── Callback ──────────────────────────────────────────────────────────────────

export type CallbackResult =
  | { ok: true; code: string; target: SsoTarget }
  | { ok: false; error: SsoError; target: SsoTarget };

const MFA_AMR = new Set(['mfa', 'otp', 'hwk', 'swk', 'sc', 'fpt', 'face', 'iris', 'retina', 'vbm', 'sms', 'tel']);

function claimString(claims: IdTokenClaims, name: string): string | undefined {
  const v = (claims as Record<string, unknown>)[name];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

// ── v8.1: binding of linked accounts + admin MFA policy ───────────────────────

/**
 * Legacy (pre-8.1 release candidate) Redis key that held the IdP binding of a
 * linked LDAP account. Read once and migrated into `User.oidcSubject`.
 */
export const SSO_LINK_PREFIX = 'auth:sso:link:';

/**
 * Binds a LOCAL/LDAP account that logs in through `allowLinking` to the IdP
 * subject of its first SSO login; later logins must present the same subject.
 * The binding lives in the durable column `User.oidcSubject` — `externalId`
 * stays free for the LDAP directory id (LDAP login/sync and a later LOCAL→LDAP
 * takeover compare it with `ldap:<id>`).
 * Older bindings are migrated on use: a LOCAL account's `externalId = oidc:…`
 * (moved to oidcSubject, externalId cleared) and the Redis key above.
 * Returns false when the account is bound to another subject.
 */
async function bindLinkedAccount(
  user: { id: string; externalId: string | null; oidcSubject: string | null },
  subject: string,
): Promise<boolean> {
  if (user.oidcSubject) return user.oidcSubject === subject;
  const key = `${SSO_LINK_PREFIX}${user.id}`;
  const legacyColumn = user.externalId?.startsWith('oidc:') ? user.externalId : null;
  const legacyRedis = legacyColumn ? null : await authRedis().get(key).catch(() => null);
  const bound = legacyColumn ?? legacyRedis ?? subject;
  // conditional write: two concurrent first logins cannot both bind
  const r = await prisma.user.updateMany({
    where: { id: user.id, oidcSubject: null },
    data: { oidcSubject: bound, ...(legacyColumn ? { externalId: null } : {}) },
  });
  if (r.count === 0) {
    const now = await prisma.user.findUnique({ where: { id: user.id }, select: { oidcSubject: true } });
    return now?.oidcSubject === subject;
  }
  if (legacyRedis) await authRedis().del(key).catch(() => undefined);
  log.info({ userId: user.id, migrated: bound !== subject || Boolean(legacyColumn ?? legacyRedis) }, 'SSO: linked account bound to the IdP subject');
  return bound === subject;
}

async function requireMfaForAdmins(): Promise<boolean> {
  const s = await prisma.serverSettings.findUnique({ where: { id: 'singleton' }, select: { requireMfaForAdmins: true } });
  return s?.requireMfaForAdmins === true;
}

function trustIdpMfaForAdmins(): boolean {
  return process.env['OIDC_TRUST_IDP_MFA_FOR_ADMINS'] === 'true';
}

export async function completeSsoCallback(
  providerId: string,
  params: Record<string, string>,
  cookie: string | undefined,
  client: ClientInfo,
): Promise<CallbackResult> {
  const state = params['state'];
  if (!state || state.length > 256) return { ok: false, error: 'invalid_state', target: 'mwa' };
  const raw = await consume(`${STATE_PREFIX}${sha256(state)}`); // single use, also on failure below
  if (!raw) return { ok: false, error: 'invalid_state', target: 'mwa' };
  const rec = JSON.parse(raw) as StateRecord;
  const target = rec.target;
  if (rec.providerId !== providerId || !cookie || !sameHash(sha256(cookie), rec.binding)) {
    log.warn({ providerId, ip: client.ip }, 'SSO callback: state/provider/cookie mismatch');
    return { ok: false, error: 'invalid_state', target };
  }
  if (params['error']) {
    log.info({ providerId, error: params['error'] }, 'SSO: IdP returned an error');
    return { ok: false, error: 'idp_error', target };
  }

  const p = await loadProvider(providerId);
  if (!p) return { ok: false, error: 'provider_unavailable', target };

  let claims: IdTokenClaims;
  try {
    const oidc = await getOidcClient(p, rec.redirectUri);
    const tokenSet = await oidc.callback(rec.redirectUri, params, {
      state, nonce: rec.nonce, code_verifier: rec.codeVerifier, response_type: 'code',
    });
    if (!tokenSet.id_token) throw new Error('no id_token');
    claims = tokenSet.claims();
  } catch (err) {
    log.warn({ err: (err as Error).message, providerId }, 'SSO: code exchange / ID token validation failed');
    return { ok: false, error: 'token_invalid', target };
  }

  const map = (p.claimMap && typeof p.claimMap === 'object' ? p.claimMap : {}) as Record<string, string>;
  const email = claimString(claims, map['email'] || 'email')?.toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'email_missing', target };
  const verified = (claims as Record<string, unknown>)['email_verified'];
  if ((p.requireEmailVerified ?? true) && verified !== true && verified !== 'true') {
    log.warn({ providerId, email }, 'SSO: email not verified by the IdP');
    return { ok: false, error: 'email_unverified', target };
  }

  const domainName = email.slice(email.lastIndexOf('@') + 1);
  const allowed = (p.forcedDomains.length > 0 ? p.forcedDomains : [p.domain?.name ?? '']).map((d) => d.trim().toLowerCase());
  const domain = await prisma.domain.findUnique({ where: { name: domainName }, select: { id: true, active: true } });
  if (!domain || !domain.active || !allowed.includes(domainName)) {
    log.warn({ providerId, email }, 'SSO: e-mail domain not allowed');
    return { ok: false, error: 'domain_not_allowed', target };
  }

  const externalId = `oidc:${p.id}:${claims.sub}`;
  const displayName = claimString(claims, map['name'] || 'name') ?? email;
  let user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, role: true, domainId: true, active: true, authSource: true, externalId: true, oidcSubject: true },
  });
  if (user) {
    if (!user.active) return { ok: false, error: 'account_inactive', target };
    if (user.authSource === 'OIDC') {
      if (user.externalId && user.externalId !== externalId) {
        log.warn({ providerId, email }, 'SSO: account is bound to another IdP subject');
        return { ok: false, error: 'account_mismatch', target };
      }
      if (!user.externalId) await prisma.user.update({ where: { id: user.id }, data: { externalId } });
    } else if (!p.allowLinking) {
      log.warn({ providerId, email, authSource: user.authSource }, 'SSO: existing non-SSO account, linking disabled');
      return { ok: false, error: 'account_not_linked', target };
    } else if (!(await bindLinkedAccount(user, externalId))) {
      // v8.1: a linked LOCAL/LDAP account is bound to the first IdP subject that
      // used it — another subject with the same (verified) e-mail is refused.
      log.warn({ providerId, email, authSource: user.authSource }, 'SSO: linked account is bound to another IdP subject');
      return { ok: false, error: 'account_mismatch', target };
    }
  } else {
    if (!p.autoProvision) return { ok: false, error: 'no_account', target };
    try {
      user = await prisma.user.create({
        data: { email, displayName, passwordHash: null, role: 'USER', authSource: 'OIDC', externalId, domainId: domain.id },
        select: { id: true, email: true, role: true, domainId: true, active: true, authSource: true, externalId: true, oidcSubject: true },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') return { ok: false, error: 'account_mismatch', target };
      throw err;
    }
    await ensureMailboxProvisioned(user.id);
    log.info({ userId: user.id, email, providerId }, 'SSO user provisioned');
  }

  if (await maintenanceBlock(user.role)) return { ok: false, error: 'maintenance', target };

  const amr = (claims as Record<string, unknown>)['amr'];
  const idpMfa = Array.isArray(amr) && amr.some((a) => typeof a === 'string' && MFA_AMR.has(a.toLowerCase()));
  // v8.1: with requireMfaForAdmins, an admin account does not get "MFA verified"
  // from the IdP's `amr` claim (a self-asserted IdP statement) unless the
  // provider does not require CoreMail MFA AND the operator explicitly trusts
  // IdP MFA for admins (OIDC_TRUST_IDP_MFA_FOR_ADMINS=true, default false).
  // Such admins get the CoreMail MFA challenge when enrolled; otherwise the
  // session stays unverified and the admin API answers MFA_NOT_VERIFIED.
  const adminNeedsLocalMfa = user.role !== 'USER' && await requireMfaForAdmins()
    && (p.requireMfa || !trustIdpMfaForAdmins());
  let outcome: ExchangeOutcome = { kind: 'session', userId: user.id, mfaVerified: idpMfa && !adminNeedsLocalMfa };
  if (p.requireMfa || adminNeedsLocalMfa) {
    const mfa = await getMfaState(user.id);
    if (mfa.enabled) {
      const method = mfa.webauthn ? 'webauthn' : 'totp';
      const methods: MfaMethod[] = [];
      if (mfa.webauthn) methods.push('webauthn');
      if (mfa.totp) methods.push('totp');
      if (mfa.backupCodes > 0) methods.push('backup_code');
      outcome = { kind: 'mfa', userId: user.id, challengeToken: await createMfaChallenge(user.id, method, methods), method, methods };
    }
  }

  const code = random();
  const ex: ExchangeRecord = { binding: rec.binding, outcome };
  await authRedis().setex(`${EXCHANGE_PREFIX}${sha256(code)}`, SSO_EXCHANGE_TTL, JSON.stringify(ex));
  log.info({ userId: user.id, providerId, mfa: outcome.kind === 'mfa' }, 'SSO callback accepted');
  return { ok: true, code, target };
}

// ── Code exchange ─────────────────────────────────────────────────────────────

type ExchangeOutcome =
  | { kind: 'session'; userId: string; mfaVerified: boolean }
  | { kind: 'mfa'; userId: string; challengeToken: string; method: 'totp' | 'webauthn'; methods: MfaMethod[] };

interface ExchangeRecord {
  binding: string;
  outcome: ExchangeOutcome;
}

export type ExchangeResult =
  | { kind: 'tokens'; tokens: TokenPair }
  | { kind: 'mfa'; challengeToken: string; method: string; methods: MfaMethod[] }
  | { kind: 'invalid' }
  | { kind: 'maintenance'; message: string }
  /** 9.4: Webmail is switched off for the account (no admin role). */
  | { kind: 'protocol_disabled' };

export async function exchangeSsoCode(code: string, cookie: string | undefined, client: ClientInfo): Promise<ExchangeResult> {
  if (typeof code !== 'string' || code.length < 16 || code.length > 128) return { kind: 'invalid' };
  const raw = await consume(`${EXCHANGE_PREFIX}${sha256(code)}`);
  if (!raw) return { kind: 'invalid' };
  const rec = JSON.parse(raw) as ExchangeRecord;
  if (!cookie || !sameHash(sha256(cookie), rec.binding)) return { kind: 'invalid' };
  const o = rec.outcome;
  if (o.kind === 'mfa') return { kind: 'mfa', challengeToken: o.challengeToken, method: o.method, methods: o.methods };

  const user = await prisma.user.findUnique({
    where: { id: o.userId }, select: { id: true, email: true, role: true, domainId: true, active: true },
  });
  if (!user?.active) return { kind: 'invalid' };
  const blocked = await maintenanceBlock(user.role);
  if (blocked) return { kind: 'maintenance', message: blocked };
  if (await webLoginBlocked(user, client.surface)) return { kind: 'protocol_disabled' };
  const tokens = await issueSession(user, { ...client, mfaVerified: o.mfaVerified });
  log.info({ userId: user.id, source: 'oidc' }, 'Login successful (SSO)');
  return { kind: 'tokens', tokens };
}
