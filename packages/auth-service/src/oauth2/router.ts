/**
 * OAuth 2.0 Authorization Server — RFC 6749 vollständige Implementierung
 *
 * Unterstützte Grant Types:
 *   - Authorization Code + PKCE S256   (RFC 6749 §4.1, RFC 7636)
 *   - Client Credentials               (RFC 6749 §4.4)
 *   - Resource Owner Password          (RFC 6749 §4.3)
 *   - Refresh Token                    (RFC 6749 §6)
 *
 * Ergänzende Standards:
 *   - Token Revocation                 (RFC 7009)
 *   - Token Introspection              (RFC 7662)
 *   - OIDC Core 1.0 (UserInfo, ID Token, Discovery)
 *   - PKCE                             (RFC 7636)
 *
 * Endpunkte (montiert unter /oauth2 in auth-service):
 *   GET  /oauth2/authorize              — Authorization endpoint
 *   POST /oauth2/authorize/complete     — Intern: OWA ruft nach Login auf
 *   POST /oauth2/consent                — Consent grant/deny
 *   POST /oauth2/token                  — Token endpoint
 *   POST /oauth2/token/revoke           — Revocation (RFC 7009)
 *   POST /oauth2/token/introspect       — Introspection (RFC 7662)
 *   GET  /oauth2/userinfo               — OIDC UserInfo
 *   GET  /oauth2/.well-known/openid-configuration
 *   GET  /oauth2/jwks
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { prisma } from '@coremail/storage/prisma';
import { createLogger, signAccessToken, signIdToken, getPublicJwk } from '@coremail/core';
import { verifyPassword } from '@coremail/core/auth';
import type { Router as RouterType } from 'express';

const log = createLogger('oauth2');

export const oauth2Router: RouterType = Router();

// ── Zeiten ────────────────────────────────────────────────────────────────────
const ACCESS_TOKEN_TTL_SEC  = 3_600;         // 1 Stunde
const REFRESH_TOKEN_TTL_SEC = 30 * 86_400;   // 30 Tage
const AUTH_CODE_TTL_SEC     = 600;           // 10 Minuten

// ── CORS (RFC 6749 Tokens werden oft von SPAs/Clients verwendet) ───────────────
function addCors(res: Response): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

oauth2Router.options('*', (_req: Request, res: Response) => {
  addCors(res);
  res.sendStatus(204);
});

// CORS-Middleware für alle OAuth-Routen
oauth2Router.use((_req: Request, res: Response, next: NextFunction) => {
  addCors(res);
  next();
});

// ── BASE_URL aus DB ────────────────────────────────────────────────────────────
async function getBaseUrl(): Promise<string> {
  try {
    const s = await prisma.serverSettings.findUnique({ where: { id: 'singleton' } });
    if (s?.publicHostname) {
      const proto = s.useHttps ? 'https' : 'http';
      const port  = s.httpPort;
      const portSuffix =
        (s.useHttps && port === 443) || (!s.useHttps && port === 80) ? '' : `:${port}`;
      return `${proto}://${s.publicHostname}${portSuffix}`;
    }
  } catch { /* fallback */ }
  return process.env['AUTODISCOVER_BASE'] ?? 'http://localhost:3000';
}

// ── RFC 6749 §5.2 Fehlerantwort ───────────────────────────────────────────────
type OAuthError =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'unsupported_response_type'
  | 'invalid_scope'
  | 'access_denied'
  | 'server_error';

function oauthError(
  res: Response,
  status: number,
  error: OAuthError,
  description?: string,
): void {
  if (status === 401) {
    res.setHeader('WWW-Authenticate', 'Basic realm="CoreMail OAuth2"');
  }
  res.status(status).json({
    error,
    ...(description ? { error_description: description } : {}),
  });
}

// ── §2.3.1 Client-Authentifizierung ───────────────────────────────────────────
/**
 * Extrahiert Client-Credentials aus dem Request:
 *   1. Authorization: Basic base64(clientId:clientSecret) [§2.3.1]
 *   2. Body-Parameter client_id + client_secret [§2.3.1 Fallback]
 * Gibt null zurück wenn keine Credentials vorhanden sind.
 */
function extractClientCreds(
  req: Request,
): { clientId: string; clientSecret: string | null } | null {
  const authHeader = req.get('Authorization') ?? '';
  if (authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
    const colon   = decoded.indexOf(':');
    if (colon === -1) return null;
    return {
      clientId:     decodeURIComponent(decoded.slice(0, colon)),
      clientSecret: decodeURIComponent(decoded.slice(colon + 1)),
    };
  }

  const body = req.body as Record<string, string | undefined>;
  if (body['client_id']) {
    return {
      clientId:     body['client_id'],
      clientSecret: body['client_secret'] ?? null,
    };
  }

  return null;
}

/**
 * Lädt und verifiziert den Client.
 * - Public clients (trusted): kein Geheimnis nötig
 * - Confidential clients: clientSecret per bcrypt prüfen
 * Gibt null zurück bei ungültigem Client.
 */
async function authenticateClient(
  clientId: string,
  clientSecret: string | null,
): Promise<Awaited<ReturnType<typeof prisma.oAuthClient.findUnique>> | null> {
  const client = await prisma.oAuthClient.findUnique({ where: { clientId } });
  if (!client || !client.active) return null;

  // Trusted clients (z. B. Outlook) benötigen kein Secret
  if (client.trusted) return client;

  // Public clients (pkceRequired=true, kein clientSecret) ebenfalls ohne Secret
  if (!client.clientSecret && client.pkceRequired) return client;

  if (!clientSecret) return null;

  const valid = await bcrypt.compare(clientSecret, client.clientSecret);
  return valid ? client : null;
}

// ── §3.3 Scope-Validierung ────────────────────────────────────────────────────
/**
 * Gibt die tatsächlich gewährten Scopes zurück (Schnittmenge mit allowedScopes).
 * Wirft einen Error wenn ein scope nicht erlaubt ist.
 */
function resolveScopes(
  requested: string | undefined,
  allowedScopes: string[],
): string {
  const reqList = (requested ?? '').split(' ').filter(Boolean);
  if (reqList.length === 0) return allowedScopes.join(' '); // Fallback: alle erlaubten

  const invalid = reqList.filter((s) => !allowedScopes.includes(s));
  if (invalid.length > 0) {
    throw new Error(`invalid_scope: ${invalid.join(', ')}`);
  }
  return reqList.join(' ');
}

// ── OIDC Discovery ─────────────────────────────────────────────────────────────

oauth2Router.get('/.well-known/openid-configuration', async (_req: Request, res: Response) => {
  const base = await getBaseUrl();
  res.json({
    issuer: base,
    authorization_endpoint:              `${base}/oauth2/authorize`,
    token_endpoint:                      `${base}/oauth2/token`,
    userinfo_endpoint:                   `${base}/oauth2/userinfo`,
    // JWKS auch unter dem Standard-Pfad /.well-known/jwks.json verfügbar
    // (Outlook + andere Clients suchen häufig dort).
    jwks_uri:                            `${base}/.well-known/jwks.json`,
    revocation_endpoint:                 `${base}/oauth2/token/revoke`,
    introspection_endpoint:              `${base}/oauth2/token/introspect`,
    response_types_supported:            ['code'],
    grant_types_supported:               ['authorization_code', 'client_credentials', 'password', 'refresh_token'],
    subject_types_supported:             ['public'],
    // v5.3.0: RS256 (RSA-2048 asymmetrisch) — Outlook + Clients verifizieren via JWKS
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported:                    ['openid', 'profile', 'email', 'mail', 'calendar', 'contacts', 'ews', 'EWS.AccessAsUser.All', 'Mail.Read', 'Mail.ReadWrite', 'Mail.Send', 'Calendars.Read', 'Calendars.ReadWrite', 'Contacts.Read', 'Contacts.ReadWrite'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
    code_challenge_methods_supported:    ['S256'],
    claims_supported:                    ['sub', 'iss', 'aud', 'iat', 'exp', 'email', 'name', 'preferred_username'],
  });
});

/**
 * JWKS-Endpoint (RFC 7517) — liefert den öffentlichen RSA-Schlüssel als JWK
 * damit Outlook & andere Clients die JWT-Signatur selbständig verifizieren
 * können. Vor v5.3.0 war das leer (HS256 hat keinen Public Key).
 */
oauth2Router.get('/jwks', (_req: Request, res: Response) => {
  res.json({ keys: [getPublicJwk()] });
});

// ── §4.1 Authorization Code Endpoint ──────────────────────────────────────────

/**
 * GET /oauth2/authorize
 *
 * Für trusted oder bereits-consented Clients: direkt zum OWA-Login weiterleiten.
 * Für neue nicht-trusted Clients: erst Consent-Seite zeigen.
 *
 * Parameter (RFC 6749 §4.1.1):
 *   response_type=code  (Pflicht)
 *   client_id           (Pflicht)
 *   redirect_uri        (Pflicht)
 *   scope               (Optional)
 *   state               (Empfohlen, CSRF-Schutz)
 *   code_challenge      (Pflicht für public clients, RFC 7636)
 *   code_challenge_method S256
 *   nonce               (OIDC)
 */
oauth2Router.get('/authorize', async (req: Request, res: Response) => {
  const {
    client_id,
    redirect_uri,
    response_type,
    scope,
    state,
    code_challenge,
    code_challenge_method,
    nonce,
  } = req.query as Record<string, string | undefined>;

  // §4.1.2.1 — response_type muss "code" sein
  if (response_type !== 'code') {
    res.status(400).json({ error: 'unsupported_response_type', error_description: 'Only response_type=code is supported' });
    return;
  }
  if (!client_id || !redirect_uri) {
    res.status(400).json({ error: 'invalid_request', error_description: 'client_id and redirect_uri required' });
    return;
  }

  const client = await prisma.oAuthClient.findUnique({ where: { clientId: client_id } });
  if (!client || !client.active) {
    res.status(401).json({ error: 'invalid_client' });
    return;
  }
  if (!client.redirectUris.includes(redirect_uri)) {
    res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uri not registered for this client' });
    return;
  }

  // PKCE Pflicht für public clients
  if (client.pkceRequired && !code_challenge) {
    res.status(400).json({ error: 'invalid_request', error_description: 'code_challenge required for this client' });
    return;
  }
  if (code_challenge && code_challenge_method && code_challenge_method !== 'S256') {
    res.status(400).json({ error: 'invalid_request', error_description: 'Only S256 code_challenge_method is supported' });
    return;
  }

  // Scope validieren
  let resolvedScope: string;
  try {
    resolvedScope = resolveScopes(scope, client.allowedScopes);
  } catch {
    res.status(400).json({ error: 'invalid_scope', error_description: `Requested scope not allowed for this client. Allowed: ${client.allowedScopes.join(' ')}` });
    return;
  }

  // Redirect zu OWA-Login mit OAuth2-Kontext im Query-String
  const loginParams = new URLSearchParams({
    oauth2:        '1',
    client_id:     client_id,
    redirect_uri:  redirect_uri,
    scope:         resolvedScope,
    state:         state ?? '',
    nonce:         nonce ?? '',
    ...(code_challenge        ? { code_challenge }        : {}),
    ...(code_challenge_method ? { code_challenge_method } : {}),
  });

  res.redirect(`/owa/login?${loginParams.toString()}`);
});

/**
 * POST /oauth2/authorize/complete
 *
 * Intern: Wird von OWA nach erfolgreicher Benutzerauthentifizierung aufgerufen.
 * Stellt den Authorization Code aus und gibt die Redirect-URL zurück.
 * Für nicht-trusted Clients wird Consent geprüft.
 *
 * v3.18.22 D1: KEIN Auto-Grant mehr! Wenn Consent fehlt oder neue Scopes
 * benötigt werden, liefert die Antwort `{ requiresConsent: true, client,
 * requestedScopes, alreadyGrantedScopes }`. Frontend muss dann den User
 * über die ConsentPage führen und nach Grant erneut diesen Endpoint mit
 * `consentConfirmed: true` aufrufen.
 */
oauth2Router.post('/authorize/complete', async (req: Request, res: Response) => {
  const {
    userId, clientId, redirectUri, scope, state,
    codeChallenge, codeChallengeMethod, nonce,
    consentConfirmed,
  } = req.body as {
    userId?: string; clientId?: string; redirectUri?: string;
    scope?: string; state?: string;
    codeChallenge?: string; codeChallengeMethod?: string;
    nonce?: string;
    consentConfirmed?: boolean;
  };

  if (!userId || !clientId || !redirectUri) {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }

  const client = await prisma.oAuthClient.findUnique({ where: { clientId } });
  if (!client?.active) { res.status(401).json({ error: 'invalid_client' }); return; }

  const requestedScopes = (scope ?? '').split(' ').filter(Boolean);

  // Consent-Prüfung für nicht-trusted Clients
  if (!client.trusted) {
    const existing = await prisma.oAuthConsent.findUnique({
      where: { userId_clientId: { userId, clientId: client.id } },
    });

    const grantedScopes = existing?.scopes ?? [];
    const newScopes     = requestedScopes.filter((s) => !grantedScopes.includes(s));
    const consentMissing = !existing || newScopes.length > 0;

    if (consentMissing) {
      // v3.18.22: Statt Auto-Grant → Frontend muss User durch Consent-Page führen.
      // Nach Bestätigung kommt der zweite Call mit `consentConfirmed: true`.
      if (!consentConfirmed) {
        res.status(200).json({
          requiresConsent: true,
          client: {
            clientId:    client.clientId,
            name:        client.name,
            description: client.description,
            trusted:     false,
          },
          requestedScopes,
          alreadyGrantedScopes: grantedScopes,
          newScopes,
        });
        return;
      }
      // consentConfirmed=true → Consent in DB persistieren
      await prisma.oAuthConsent.upsert({
        where: { userId_clientId: { userId, clientId: client.id } },
        create: { userId, clientId: client.id, scopes: requestedScopes },
        update: { scopes: [...new Set([...grantedScopes, ...requestedScopes])], revokedAt: null },
      });
    }
  }

  const code      = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_SEC * 1000);

  await prisma.oAuthAuthorizationCode.create({
    data: {
      code,
      clientId:  client.id,
      userId,
      scope:     scope ?? 'openid email',
      redirectUri,
      expiresAt,
      ...(codeChallenge        ? { codeChallenge, codeChallengeMethod: codeChallengeMethod ?? 'S256' } : {}),
    },
  });

  const params = new URLSearchParams({
    code,
    ...(state ? { state } : {}),
    ...(nonce ? { nonce } : {}),
  });
  res.json({ redirect: `${redirectUri}?${params.toString()}` });
});

// ── POST /oauth2/consent — Consent erteilen oder verweigern ─────────────────────
/**
 * POST /oauth2/consent
 *
 * Body: { userId, clientId, scopes: string[], decision: 'grant' | 'deny' }
 * Wird von der OWA Consent-Seite aufgerufen.
 */
oauth2Router.post('/consent', async (req: Request, res: Response) => {
  const { userId, clientId, scopes, decision } = req.body as {
    userId?: string; clientId?: string; scopes?: string[]; decision?: 'grant' | 'deny';
  };

  if (!userId || !clientId || !scopes || !decision) {
    oauthError(res, 400, 'invalid_request', 'userId, clientId, scopes, decision required');
    return;
  }

  const client = await prisma.oAuthClient.findUnique({ where: { clientId } });
  if (!client?.active) { oauthError(res, 401, 'invalid_client'); return; }

  if (decision === 'deny') {
    await prisma.oAuthConsent.deleteMany({
      where: { userId, clientId: client.id },
    });
    res.json({ ok: true, granted: false });
    return;
  }

  // Grant
  const existing = await prisma.oAuthConsent.findUnique({
    where: { userId_clientId: { userId, clientId: client.id } },
  });
  const merged = [...new Set([...(existing?.scopes ?? []), ...scopes])];

  await prisma.oAuthConsent.upsert({
    where: { userId_clientId: { userId, clientId: client.id } },
    create: { userId, clientId: client.id, scopes: merged },
    update: { scopes: merged, revokedAt: null },
  });

  res.json({ ok: true, granted: true, scopes: merged });
});

// ── §4 Token Endpoint ──────────────────────────────────────────────────────────

oauth2Router.post('/token', async (req: Request, res: Response) => {
  const body       = req.body as Record<string, string | undefined>;
  const grant_type = body['grant_type'];

  switch (grant_type) {
    case 'authorization_code':
      await handleAuthorizationCodeGrant(req, res);
      break;
    case 'client_credentials':
      await handleClientCredentialsGrant(req, res);
      break;
    case 'password':
      await handlePasswordGrant(req, res);
      break;
    case 'refresh_token':
      await handleRefreshTokenGrant(req, res);
      break;
    default:
      oauthError(res, 400, 'unsupported_grant_type',
        'Supported: authorization_code, client_credentials, password, refresh_token');
  }
});

// ── §4.1 Authorization Code Grant ─────────────────────────────────────────────

async function handleAuthorizationCodeGrant(req: Request, res: Response): Promise<void> {
  const body         = req.body as Record<string, string | undefined>;
  const code         = body['code'];
  const redirect_uri = body['redirect_uri'];
  const code_verifier = body['code_verifier'];

  if (!code || !redirect_uri) {
    oauthError(res, 400, 'invalid_request', 'code and redirect_uri required');
    return;
  }

  const creds = extractClientCreds(req);
  if (!creds) {
    oauthError(res, 401, 'invalid_client', 'client_id required');
    return;
  }

  const client = await authenticateClient(creds.clientId, creds.clientSecret);
  if (!client) {
    oauthError(res, 401, 'invalid_client');
    return;
  }

  const authCode = await prisma.oAuthAuthorizationCode.findUnique({
    where: { code },
    include: { user: { select: { id: true, email: true, displayName: true, role: true } } },
  });

  if (
    !authCode ||
    authCode.used ||
    authCode.expiresAt < new Date() ||
    authCode.clientId !== client.id
  ) {
    oauthError(res, 400, 'invalid_grant', 'Authorization code invalid, expired or already used');
    return;
  }

  // §4.1.3 redirect_uri muss mit dem gespeicherten Wert übereinstimmen
  if (authCode.redirectUri !== redirect_uri) {
    oauthError(res, 400, 'invalid_grant', 'redirect_uri mismatch');
    return;
  }

  // PKCE verifizieren (RFC 7636 §4.6)
  if (authCode.codeChallenge) {
    if (!code_verifier) {
      oauthError(res, 400, 'invalid_grant', 'code_verifier required');
      return;
    }
    const computed = crypto.createHash('sha256').update(code_verifier).digest('base64url');
    if (computed !== authCode.codeChallenge) {
      oauthError(res, 400, 'invalid_grant', 'code_verifier mismatch');
      return;
    }
  } else if (client.pkceRequired) {
    // Public client ohne PKCE = Fehler
    oauthError(res, 400, 'invalid_grant', 'PKCE required for this client');
    return;
  }

  // Code als "verwendet" markieren — verhindert Replay-Attacken
  await prisma.oAuthAuthorizationCode.update({ where: { id: authCode.id }, data: { used: true } });

  const tokenResponse = await issueTokens(client.id, authCode.userId, authCode.scope);
  log.info({ userId: authCode.userId, clientId: creds.clientId }, 'OAuth2 authorization_code token issued');
  res.json(tokenResponse);
}

// ── §4.4 Client Credentials Grant ─────────────────────────────────────────────

async function handleClientCredentialsGrant(req: Request, res: Response): Promise<void> {
  const body  = req.body as Record<string, string | undefined>;
  const scope = body['scope'];

  const creds = extractClientCreds(req);
  if (!creds || !creds.clientSecret) {
    oauthError(res, 401, 'invalid_client', 'client_id and client_secret required for client_credentials grant');
    return;
  }

  const client = await authenticateClient(creds.clientId, creds.clientSecret);
  if (!client) {
    oauthError(res, 401, 'invalid_client');
    return;
  }

  // Client Credentials: kein User, nur Client-Scope
  let resolvedScope: string;
  try {
    resolvedScope = resolveScopes(scope, client.allowedScopes);
  } catch {
    oauthError(res, 400, 'invalid_scope', `Allowed scopes: ${client.allowedScopes.join(' ')}`);
    return;
  }

  // Access Token ohne userId (client-only context)
  const accessToken = crypto.randomBytes(40).toString('hex');
  const now = Date.now();

  await prisma.oAuthToken.create({
    data: {
      accessToken,
      scope:     resolvedScope,
      expiresAt: new Date(now + ACCESS_TOKEN_TTL_SEC * 1000),
      clientId:  client.id,
      // Client Credentials hat keinen User — Dummy-userId benötigt wegen NOT NULL-Constraint.
      // Workaround: createdBy des Clients als userId verwenden.
      userId:    client.createdBy,
    },
  });

  log.info({ clientId: creds.clientId }, 'OAuth2 client_credentials token issued');
  res.json({
    access_token: accessToken,
    token_type:   'Bearer',
    expires_in:   ACCESS_TOKEN_TTL_SEC,
    scope:        resolvedScope,
  });
}

// ── §4.3 Resource Owner Password Credentials Grant ───────────────────────────

async function handlePasswordGrant(req: Request, res: Response): Promise<void> {
  const body     = req.body as Record<string, string | undefined>;
  const username = body['username'];
  const password = body['password'];
  const scope    = body['scope'];

  if (!username || !password) {
    oauthError(res, 400, 'invalid_request', 'username and password required');
    return;
  }

  const creds = extractClientCreds(req);
  if (!creds) {
    oauthError(res, 401, 'invalid_client', 'client_id required');
    return;
  }

  const client = await authenticateClient(creds.clientId, creds.clientSecret);
  if (!client) {
    oauthError(res, 401, 'invalid_client');
    return;
  }

  // Benutzer verifizieren
  const user = await prisma.user.findFirst({
    where: { email: username.toLowerCase(), active: true },
    select: { id: true, email: true, displayName: true, role: true, passwordHash: true },
  });

  if (!user?.passwordHash) {
    oauthError(res, 400, 'invalid_grant', 'Invalid username or password');
    return;
  }

  const passwordValid = await verifyPassword(password, user.passwordHash);
  if (!passwordValid) {
    oauthError(res, 400, 'invalid_grant', 'Invalid username or password');
    return;
  }

  let resolvedScope: string;
  try {
    resolvedScope = resolveScopes(scope, client.allowedScopes);
  } catch {
    oauthError(res, 400, 'invalid_scope', `Allowed scopes: ${client.allowedScopes.join(' ')}`);
    return;
  }

  const tokenResponse = await issueTokens(client.id, user.id, resolvedScope);
  log.info({ userId: user.id, clientId: creds.clientId }, 'OAuth2 password token issued');
  res.json(tokenResponse);
}

// ── §6 Refresh Token Grant ────────────────────────────────────────────────────

async function handleRefreshTokenGrant(req: Request, res: Response): Promise<void> {
  const body          = req.body as Record<string, string | undefined>;
  const refresh_token = body['refresh_token'];
  const scope         = body['scope'];

  if (!refresh_token) {
    oauthError(res, 400, 'invalid_request', 'refresh_token required');
    return;
  }

  const token = await prisma.oAuthToken.findUnique({
    where: { refreshToken: refresh_token },
    include: { client: true },
  });

  if (
    !token ||
    token.revoked ||
    !token.refreshToken ||
    !token.refreshExpiresAt ||
    token.refreshExpiresAt < new Date()
  ) {
    oauthError(res, 400, 'invalid_grant', 'Refresh token invalid or expired');
    return;
  }

  // Optionaler Client-Check
  const creds = extractClientCreds(req);
  if (creds) {
    const client = await authenticateClient(creds.clientId, creds.clientSecret);
    if (!client || client.id !== token.clientId) {
      oauthError(res, 401, 'invalid_client');
      return;
    }
  }

  // §6: Scope des neuen Tokens darf nicht größer sein als der originale Scope
  const originalScopes = token.scope.split(' ').filter(Boolean);
  let resolvedScope: string;
  try {
    resolvedScope = resolveScopes(scope, originalScopes);
  } catch {
    oauthError(res, 400, 'invalid_scope', `Scope cannot exceed original: ${token.scope}`);
    return;
  }

  // Altes Token widerrufen (Rotation)
  await prisma.oAuthToken.update({ where: { id: token.id }, data: { revoked: true } });

  const tokenResponse = await issueTokens(token.clientId, token.userId, resolvedScope);
  res.json(tokenResponse);
}

// ── RFC 7009 Token Revocation ─────────────────────────────────────────────────

oauth2Router.post('/token/revoke', async (req: Request, res: Response) => {
  const body  = req.body as Record<string, string | undefined>;
  const token = body['token'];

  if (!token) {
    oauthError(res, 400, 'invalid_request', 'token parameter required');
    return;
  }

  // Optionale Client-Authentifizierung
  const creds = extractClientCreds(req);
  if (creds) {
    const client = await authenticateClient(creds.clientId, creds.clientSecret);
    if (!client) {
      oauthError(res, 401, 'invalid_client');
      return;
    }
  }

  await prisma.oAuthToken.updateMany({
    where: { OR: [{ accessToken: token }, { refreshToken: token }] },
    data:  { revoked: true },
  });

  // RFC 7009 §2.2: immer 200, auch wenn Token unbekannt
  res.status(200).send('');
});

// ── RFC 7662 Token Introspection ──────────────────────────────────────────────

oauth2Router.post('/token/introspect', async (req: Request, res: Response) => {
  // Introspection benötigt Client-Authentifizierung
  const creds = extractClientCreds(req);
  if (!creds) {
    oauthError(res, 401, 'invalid_client', 'Client authentication required for introspection');
    return;
  }
  const client = await authenticateClient(creds.clientId, creds.clientSecret);
  if (!client) {
    oauthError(res, 401, 'invalid_client');
    return;
  }

  const body  = req.body as Record<string, string | undefined>;
  const token = body['token'];
  if (!token) {
    oauthError(res, 400, 'invalid_request', 'token parameter required');
    return;
  }

  const record = await prisma.oAuthToken.findFirst({
    where: { OR: [{ accessToken: token }, { refreshToken: token }] },
    include: { user: { select: { email: true, displayName: true } } },
  });

  const isActive =
    record &&
    !record.revoked &&
    (record.accessToken === token
      ? record.expiresAt > new Date()
      : (record.refreshExpiresAt ?? new Date(0)) > new Date());

  if (!isActive || !record) {
    // RFC 7662 §2.2: inactive token → { active: false }
    res.json({ active: false });
    return;
  }

  const base = await getBaseUrl();
  res.json({
    active:    true,
    scope:     record.scope,
    client_id: client.clientId,
    username:  record.user.email,
    token_type: 'Bearer',
    exp:       Math.floor(record.expiresAt.getTime() / 1000),
    iat:       Math.floor(record.createdAt.getTime() / 1000),
    sub:       record.userId,
    iss:       base,
  });
});

// ── OIDC UserInfo ──────────────────────────────────────────────────────────────

oauth2Router.get('/userinfo', async (req: Request, res: Response) => {
  const header = req.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="CoreMail"');
    res.status(401).json({ error: 'invalid_token' });
    return;
  }

  const bearerToken = header.slice(7);

  const token = await prisma.oAuthToken.findFirst({
    where: { OR: [{ accessToken: bearerToken }] },
    include: { user: { select: { id: true, email: true, displayName: true } } },
  });

  if (!token || token.revoked || token.expiresAt < new Date()) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="CoreMail", error="invalid_token"');
    res.status(401).json({ error: 'invalid_token' });
    return;
  }

  const scopes = token.scope.split(' ');
  const claims: Record<string, unknown> = {
    sub:                token.userId,
    preferred_username: token.user.email,
  };

  if (scopes.includes('email') || scopes.includes('openid')) {
    claims['email'] = token.user.email;
  }
  if (scopes.includes('profile')) {
    claims['name']         = token.user.displayName;
    claims['display_name'] = token.user.displayName;
  }

  res.json(claims);
});

// ── Helper: Tokens ausstellen ─────────────────────────────────────────────────

async function issueTokens(
  clientId: string,
  userId:   string,
  scope:    string,
): Promise<Record<string, unknown>> {
  const user = await prisma.user.findUnique({
    where:  { id: userId },
    select: { email: true, displayName: true, role: true },
  });
  if (!user) throw new Error('User not found');

  const base = await getBaseUrl();
  const now  = Date.now();

  // JWT Access Token (HS256)
  const accessToken = signAccessToken({
    sub:        userId,
    email:      user.email,
    role:       user.role,
    domainId:   '',
    sessionId:  clientId,
    mfaVerified: false,
  });

  const refreshTokenStr = crypto.randomBytes(40).toString('hex');

  await prisma.oAuthToken.create({
    data: {
      accessToken,
      scope,
      expiresAt:        new Date(now + ACCESS_TOKEN_TTL_SEC  * 1000),
      refreshToken:     refreshTokenStr,
      refreshExpiresAt: new Date(now + REFRESH_TOKEN_TTL_SEC * 1000),
      clientId,
      userId,
    },
  });

  const response: Record<string, unknown> = {
    access_token:  accessToken,
    token_type:    'Bearer',
    expires_in:    ACCESS_TOKEN_TTL_SEC,
    refresh_token: refreshTokenStr,
    scope,
  };

  // OIDC Core §3.1.3.3: ID Token wenn "openid" Scope angefordert
  if (scope.split(' ').includes('openid')) {
    response['id_token'] = signIdToken({
      iss:                base,
      sub:                userId,
      aud:                clientId,
      iat:                Math.floor(now / 1000),
      exp:                Math.floor(now / 1000) + ACCESS_TOKEN_TTL_SEC,
      email:              user.email,
      name:               user.displayName,
      preferred_username: user.email,
    });
  }

  return response;
}
