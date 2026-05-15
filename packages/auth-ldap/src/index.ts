import { Client } from 'ldapts';
import { prisma } from '@coremail/storage';
import { createLogger } from '@coremail/core';

export interface AuthResult {
  userId: string;
  email: string;
  displayName: string;
  role: string;
  source: 'local' | 'ldap' | 'oidc';
  mfaRequired: boolean;
}

const log = createLogger('auth:ldap');

interface LdapAttributeMap {
  email?: string;
  displayName?: string;
  uid?: string;
}

interface LdapConfig {
  host: string;
  port: number;
  ssl: boolean;
  baseDN: string;
  bindDN: string;
  bindPassword: string;
  userFilter: string;
  userDN: string;
  attributeMap: LdapAttributeMap;
}

function buildFilter(template: string, username: string): string {
  return template.replace(/\{\{username\}\}/g, username.replace(/[*()\\\0/]/g, ''));
}

export async function authenticateLdap(
  email: string,
  password: string,
): Promise<AuthResult | null> {
  // prisma imported at top level

  // Find domain LDAP config
  const domain = email.split('@')[1] ?? '';
  const domainRecord = await prisma.domain.findUnique({ where: { name: domain } });
  if (!domainRecord) return null;

  const ldapConfig = await prisma.ldapConfig.findUnique({
    where: { domainId: domainRecord.id },
  });
  if (!ldapConfig || !ldapConfig.syncEnabled) return null;

  const config: LdapConfig = {
    host: ldapConfig.host,
    port: ldapConfig.port,
    ssl: ldapConfig.ssl,
    baseDN: ldapConfig.baseDN,
    bindDN: ldapConfig.bindDN,
    bindPassword: ldapConfig.bindPassword,
    userDN: ldapConfig.userDN ?? ldapConfig.baseDN,
    userFilter: ldapConfig.userFilter,
    attributeMap: (ldapConfig.attributeMap as LdapAttributeMap) ?? {},
  };

  const client = new Client({
    url: `${config.ssl ? 'ldaps' : 'ldap'}://${config.host}:${config.port}`,
    timeout: 5000,
    connectTimeout: 5000,
  });

  try {
    // Bind with service account
    await client.bind(config.bindDN, config.bindPassword);

    // Search for user
    const username = email.split('@')[0] ?? email;
    const { searchEntries } = await client.search(config.userDN, {
      scope: 'sub',
      filter: buildFilter(config.userFilter, username),
      attributes: [
        config.attributeMap.email ?? 'mail',
        config.attributeMap.displayName ?? 'displayName',
        config.attributeMap.uid ?? 'objectGUID',
        'dn',
      ],
    });

    if (searchEntries.length === 0) {
      log.debug({ email }, 'LDAP user not found');
      return null;
    }

    const entry = searchEntries[0];
    if (!entry) return null;

    const userDn = entry.dn;

    // Bind as user to verify password
    const userClient = new Client({
      url: `${config.ssl ? 'ldaps' : 'ldap'}://${config.host}:${config.port}`,
      timeout: 5000,
      connectTimeout: 5000,
    });

    try {
      await userClient.bind(userDn, password);
    } catch {
      log.debug({ email }, 'LDAP password verification failed');
      return null;
    } finally {
      await userClient.unbind().catch(() => undefined);
    }

    // Provision/sync user in PostgreSQL
    const ldapEmail =
      String((entry[config.attributeMap.email ?? 'mail'] as string | undefined) ?? email);
    const displayName =
      String((entry[config.attributeMap.displayName ?? 'displayName'] as string | undefined) ?? email);

    const user = await prisma.user.upsert({
      where: { email: ldapEmail.toLowerCase() },
      create: {
        email: ldapEmail.toLowerCase(),
        displayName,
        passwordHash: '',
        role: 'USER',
        authSource: 'LDAP',
        domainId: domainRecord.id,
      },
      update: {
        displayName,
        authSource: 'LDAP',
      },
    });

    log.info({ email, userId: user.id }, 'LDAP authentication successful');
    return {
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      source: 'ldap',
      mfaRequired: false,
    };
  } catch (err) {
    log.error({ err, email }, 'LDAP authentication error');
    return null;
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

export async function syncLdapUsers(domainId: string): Promise<number> {
  // prisma imported at top level
  const ldapConfig = await prisma.ldapConfig.findUnique({ where: { domainId } });
  if (!ldapConfig) return 0;

  const config: LdapConfig = {
    host: ldapConfig.host,
    port: ldapConfig.port,
    ssl: ldapConfig.ssl,
    baseDN: ldapConfig.baseDN,
    bindDN: ldapConfig.bindDN,
    bindPassword: ldapConfig.bindPassword,
    userDN: ldapConfig.userDN ?? ldapConfig.baseDN,
    userFilter: ldapConfig.userFilter,
    attributeMap: (ldapConfig.attributeMap as LdapAttributeMap) ?? {},
  };

  const client = new Client({
    url: `${config.ssl ? 'ldaps' : 'ldap'}://${config.host}:${config.port}`,
    timeout: 10000,
  });

  try {
    await client.bind(config.bindDN, config.bindPassword);

    const { searchEntries } = await client.search(config.userDN, {
      scope: 'sub',
      filter: '(objectClass=person)',
      attributes: [
        config.attributeMap.email ?? 'mail',
        config.attributeMap.displayName ?? 'displayName',
      ],
    });

    const domain = await prisma.domain.findUnique({ where: { id: domainId } });
    if (!domain) return 0;

    let synced = 0;
    for (const entry of searchEntries) {
      const email = String(
        (entry[config.attributeMap.email ?? 'mail'] as string | undefined) ?? '',
      );
      const displayName = String(
        (entry[config.attributeMap.displayName ?? 'displayName'] as string | undefined) ?? email,
      );

      if (!email || !email.includes('@')) continue;

      await prisma.user.upsert({
        where: { email: email.toLowerCase() },
        create: {
          email: email.toLowerCase(),
          displayName,
          passwordHash: '',
          role: 'USER',
          authSource: 'LDAP',
          domainId,
        },
        update: { displayName },
      });
      synced++;
    }

    await prisma.ldapConfig.update({
      where: { domainId },
      data: { lastSyncAt: new Date() },
    });

    log.info({ domainId, synced }, 'LDAP sync completed');
    return synced;
  } finally {
    await client.unbind().catch(() => undefined);
  }
}
