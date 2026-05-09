import { Issuer, generators, type Client } from 'openid-client';
import { getPrisma } from '@coremail/storage';
import { getRedis } from '@coremail/core';
import { createLogger } from '@coremail/core';
import type { AuthResult } from '../../auth-service/src/types.js';

const log = createLogger('auth:sso');

const STATE_TTL = 10 * 60; // 10 minutes
const STATE_PREFIX = 'auth:oidc:state:';

interface ClaimMap {
  email?: string;
  name?: string;
  sub?: string;
}

const clientCache = new Map<string, Client>();

async function getOidcClient(providerId: string): Promise<Client | null> {
  if (clientCache.has(providerId)) {
    return clientCache.get(providerId) ?? null;
  }

  const prisma = getPrisma();
  const provider = await prisma.oidcProvider.findUnique({ where: { id: providerId } });
  if (!provider || !provider.active) return null;

  try {
    const issuer = await Issuer.discover(provider.discoveryUrl);
    const client = new issuer.Client({
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      response_types: ['code'],
    });

    clientCache.set(providerId, client);
    return client;
  } catch (err) {
    log.error({ err, providerId }, 'Failed to discover OIDC issuer');
    return null;
  }
}

export async function startOidcLogin(
  providerId: string,
  redirectUri: string,
): Promise<string | null> {
  const client = await getOidcClient(providerId);
  if (!client) return null;

  const state = generators.state();
  const nonce = generators.nonce();
  const redis = getRedis();

  await redis.setex(
    `${STATE_PREFIX}${state}`,
    STATE_TTL,
    JSON.stringify({ providerId, nonce, redirectUri }),
  );

  const authUrl = client.authorizationUrl({
    scope: 'openid email profile',
    state,
    nonce,
    redirect_uri: redirectUri,
  });

  return authUrl;
}

export async function handleOidcCallback(
  state: string,
  code: string,
): Promise<AuthResult | null> {
  const redis = getRedis();
  const raw = await redis.get(`${STATE_PREFIX}${state}`);
  if (!raw) {
    log.warn({ state }, 'OIDC state not found or expired');
    return null;
  }

  const { providerId, nonce, redirectUri } = JSON.parse(raw) as {
    providerId: string;
    nonce: string;
    redirectUri: string;
  };

  await redis.del(`${STATE_PREFIX}${state}`);

  const client = await getOidcClient(providerId);
  if (!client) return null;

  const prisma = getPrisma();
  const provider = await prisma.oidcProvider.findUnique({ where: { id: providerId } });
  if (!provider) return null;

  try {
    const params = client.callbackParams(`${redirectUri}?code=${code}&state=${state}`);
    const tokenSet = await client.callback(redirectUri, params, { state, nonce });

    const claims = tokenSet.claims();
    const claimMap = provider.claimMap as ClaimMap;

    const emailClaim = claimMap.email ?? 'email';
    const nameClaim = claimMap.name ?? 'name';

    const email = String((claims[emailClaim] as string | undefined) ?? '');
    const displayName = String((claims[nameClaim] as string | undefined) ?? email);

    if (!email || !email.includes('@')) {
      log.error({ providerId }, 'OIDC token missing email claim');
      return null;
    }

    if (!provider.autoProvision) {
      // Check user exists
      const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
      if (!existing) {
        log.warn({ email }, 'OIDC auto-provision disabled and user not found');
        return null;
      }
    }

    const domain = email.split('@')[1] ?? '';
    const domainRecord = await prisma.domain.findUnique({ where: { name: domain } });
    if (!domainRecord) {
      log.warn({ email, domain }, 'Domain not found for OIDC user');
      return null;
    }

    const user = await prisma.user.upsert({
      where: { email: email.toLowerCase() },
      create: {
        email: email.toLowerCase(),
        displayName,
        passwordHash: '',
        role: 'USER',
        authSource: 'OIDC',
        domainId: domainRecord.id,
      },
      update: {
        displayName,
        authSource: 'OIDC',
      },
    });

    log.info({ userId: user.id, email, providerId }, 'OIDC authentication successful');
    return {
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      source: 'oidc',
      mfaRequired: false,
    };
  } catch (err) {
    log.error({ err, providerId }, 'OIDC callback handling failed');
    return null;
  }
}

export async function listProviders() {
  const prisma = getPrisma();
  return prisma.oidcProvider.findMany({
    where: { active: true },
    select: { id: true, name: true, discoveryUrl: true },
  });
}
