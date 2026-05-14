/**
 * OAuth2 Authorization Server — Phase 10 (Modern Auth for Outlook)
 *
 * Implements OAuth2 Authorization Code Flow + PKCE (RFC 7636)
 * so Outlook 2019/365 can authenticate without Basic Auth.
 *
 * Endpoints (mounted at /oauth2):
 *   GET  /oauth2/authorize          — Authorization endpoint (redirect user to login)
 *   POST /oauth2/token              — Token endpoint (code → access + refresh token)
 *   POST /oauth2/token/revoke       — Revoke access or refresh token
 *   GET  /oauth2/userinfo           — UserInfo endpoint (OIDC)
 *   GET  /oauth2/.well-known/openid-configuration  — OIDC discovery document
 *   GET  /oauth2/jwks               — JSON Web Key Set (RS256 public keys)
 *
 * Admin endpoints (mounted at /api/v1/admin/oauth):
 *   GET/POST/PUT/DELETE /clients    — manage OAuth2 clients (via adminOAuthRouter)
 */

import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { prisma } from '@coremail/storage/prisma';
import { createLogger, createAccessToken, verifyAccessToken } from '@coremail/core';

const log = createLogger('oauth2');

export const oauth2Router = Router();

const BASE_URL = process.env['AUTODISCOVER_BASE'] ?? 'http://localhost:3000';
const ACCESS_TOKEN_TTL_SEC  = 3600;          // 1 hour
const REFRESH_TOKEN_TTL_SEC = 30 * 86400;    // 30 days
const AUTH_CODE_TTL_SEC     = 600;           // 10 minutes

// ── OIDC Discovery ─────────────────────────────────────────────────────────────

oauth2Router.get('/.well-known/openid-configuration', (_req: Request, res: Response) => {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/oauth2/authorize`,
    token_endpoint: `${BASE_URL}/oauth2/token`,
    userinfo_endpoint: `${BASE_URL}/oauth2/userinfo`,
    jwks_uri: `${BASE_URL}/oauth2/jwks`,
    revocation_endpoint: `${BASE_URL}/oauth2/token/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['HS256'],
    scopes_supported: ['openid', 'profile', 'email', 'mail', 'calendar', 'contacts', 'ews'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
    code_challenge_methods_supported: ['S256'],
    claims_supported: ['sub', 'email', 'name', 'preferred_username'],
  });
});

oauth2Router.get('/jwks', (_req: Request, res: Response) => {
  // CoreMail uses HS256 (symmetric) — no public key to expose.
  // Return an empty key set (Outlook accepts this for auth code flows).
  res.json({ keys: [] });
});

// ── Authorization Endpoint ─────────────────────────────────────────────────────

/**
 * GET /oauth2/authorize
 * Redirects to the OWA login page with OAuth2 state embedded.
 * OWA handles user authentication and calls back to complete the code grant.
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
  } = req.query as Record<string, string | undefined>;

  if (response_type !== 'code') {
    res.status(400).json({ error: 'unsupported_response_type' });
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
    res.status(400).json({ error: 'invalid_redirect_uri' });
    return;
  }

  // Redirect to OWA login with oauth2 context encoded in URL
  const loginParams = new URLSearchParams({
    oauth2: '1',
    client_id: client_id,
    redirect_uri: redirect_uri,
    scope: scope ?? 'openid email',
    state: state ?? '',
    ...(code_challenge ? { code_challenge } : {}),
    ...(code_challenge_method ? { code_challenge_method } : {}),
  });

  res.redirect(`/owa/login?${loginParams.toString()}`);
});

/**
 * POST /oauth2/authorize/complete
 * Called by OWA after successful user authentication.
 * Issues an authorization code and redirects to the client's redirect_uri.
 * Body: { userId, clientId, redirectUri, scope, state, codeChallenge }
 * This endpoint is called server-to-server (no user interaction).
 */
oauth2Router.post('/authorize/complete', async (req: Request, res: Response) => {
  const { userId, clientId, redirectUri, scope, state, codeChallenge, codeChallengeMethod } =
    req.body as {
      userId?: string;
      clientId?: string;
      redirectUri?: string;
      scope?: string;
      state?: string;
      codeChallenge?: string;
      codeChallengeMethod?: string;
    };

  if (!userId || !clientId || !redirectUri) {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }

  const client = await prisma.oAuthClient.findUnique({ where: { clientId } });
  if (!client?.active) { res.status(401).json({ error: 'invalid_client' }); return; }

  const code = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_SEC * 1000);

  await prisma.oAuthAuthorizationCode.create({
    data: {
      code,
      clientId: client.id,
      userId,
      scope: scope ?? 'openid email',
      redirectUri,
      expiresAt,
      ...(codeChallenge ? { codeChallenge, codeChallengeMethod: codeChallengeMethod ?? 'S256' } : {}),
    },
  });

  const params = new URLSearchParams({ code, ...(state ? { state } : {}) });
  res.json({ redirect: `${redirectUri}?${params.toString()}` });
});

// ── Token Endpoint ─────────────────────────────────────────────────────────────

oauth2Router.post('/token', async (req: Request, res: Response) => {
  const { grant_type } = req.body as Record<string, string>;

  if (grant_type === 'authorization_code') {
    await handleAuthorizationCodeGrant(req, res);
  } else if (grant_type === 'refresh_token') {
    await handleRefreshTokenGrant(req, res);
  } else {
    res.status(400).json({ error: 'unsupported_grant_type' });
  }
});

async function handleAuthorizationCodeGrant(req: Request, res: Response): Promise<void> {
  const { code, redirect_uri, client_id, client_secret, code_verifier } =
    req.body as Record<string, string>;

  if (!code || !redirect_uri || !client_id) {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }

  const client = await prisma.oAuthClient.findUnique({ where: { clientId: client_id } });
  if (!client?.active) { res.status(401).json({ error: 'invalid_client' }); return; }

  // Verify client secret (for confidential clients)
  if (!client.trusted && client_secret) {
    const bcrypt = await import('bcrypt');
    const valid = await bcrypt.compare(client_secret, client.clientSecret);
    if (!valid) { res.status(401).json({ error: 'invalid_client' }); return; }
  }

  const authCode = await prisma.oAuthAuthorizationCode.findUnique({
    where: { code },
    include: { user: { select: { id: true, email: true, displayName: true, role: true } } },
  });

  if (!authCode || authCode.used || authCode.expiresAt < new Date() || authCode.clientId !== client.id) {
    res.status(400).json({ error: 'invalid_grant' });
    return;
  }

  if (authCode.redirectUri !== redirect_uri) {
    res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
    return;
  }

  // PKCE verification
  if (authCode.codeChallenge) {
    if (!code_verifier) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'code_verifier required' });
      return;
    }
    const hash = crypto.createHash('sha256').update(code_verifier).digest('base64url');
    if (hash !== authCode.codeChallenge) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'code_verifier mismatch' });
      return;
    }
  }

  // Mark code as used
  await prisma.oAuthAuthorizationCode.update({ where: { id: authCode.id }, data: { used: true } });

  // Issue tokens
  const tokenResponse = await issueTokens(client.id, authCode.userId, authCode.scope);
  log.info({ userId: authCode.userId, clientId: client_id }, 'OAuth2 token issued');
  res.json(tokenResponse);
}

async function handleRefreshTokenGrant(req: Request, res: Response): Promise<void> {
  const { refresh_token, client_id } = req.body as Record<string, string>;

  if (!refresh_token) { res.status(400).json({ error: 'invalid_request' }); return; }

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
    res.status(400).json({ error: 'invalid_grant' });
    return;
  }

  if (client_id && token.client.clientId !== client_id) {
    res.status(401).json({ error: 'invalid_client' });
    return;
  }

  // Revoke old token
  await prisma.oAuthToken.update({ where: { id: token.id }, data: { revoked: true } });

  // Issue fresh tokens
  const tokenResponse = await issueTokens(token.clientId, token.userId, token.scope);
  res.json(tokenResponse);
}

// ── Revocation Endpoint ────────────────────────────────────────────────────────

oauth2Router.post('/token/revoke', async (req: Request, res: Response) => {
  const { token } = req.body as { token?: string };
  if (!token) { res.status(400).json({ error: 'invalid_request' }); return; }

  await prisma.oAuthToken.updateMany({
    where: { OR: [{ accessToken: token }, { refreshToken: token }] },
    data: { revoked: true },
  });

  res.status(200).send('');
});

// ── UserInfo Endpoint ──────────────────────────────────────────────────────────

oauth2Router.get('/userinfo', async (req: Request, res: Response) => {
  const header = req.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) { res.status(401).json({ error: 'invalid_token' }); return; }

  const bearerToken = header.slice(7);

  // Check in OAuth token table first
  const token = await prisma.oAuthToken.findUnique({
    where: { accessToken: bearerToken },
    include: { user: { select: { id: true, email: true, displayName: true } } },
  });

  if (!token || token.revoked || token.expiresAt < new Date()) {
    res.status(401).json({ error: 'invalid_token' });
    return;
  }

  res.json({
    sub: token.userId,
    email: token.user.email,
    name: token.user.displayName,
    preferred_username: token.user.email,
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────────

async function issueTokens(
  clientId: string,
  userId: string,
  scope: string,
): Promise<Record<string, unknown>> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, displayName: true, role: true },
  });
  if (!user) throw new Error('User not found');

  // Reuse createAccessToken from @coremail/core (HS256 JWT)
  const accessToken = createAccessToken({
    sub: userId,
    email: user.email,
    role: user.role,
  });

  const refreshTokenStr = crypto.randomBytes(40).toString('hex');
  const now = Date.now();

  await prisma.oAuthToken.create({
    data: {
      accessToken,
      scope,
      expiresAt: new Date(now + ACCESS_TOKEN_TTL_SEC * 1000),
      refreshToken: refreshTokenStr,
      refreshExpiresAt: new Date(now + REFRESH_TOKEN_TTL_SEC * 1000),
      clientId,
      userId,
    },
  });

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SEC,
    refresh_token: refreshTokenStr,
    scope,
  };
}
