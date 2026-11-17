import { initRuntimeLogLevel } from '@coremail/core';
import { registerLdapMailVerifier } from '@coremail/auth-ldap';
import express from 'express';
import {
  createLogger, getRedisClient, CHANNEL_SETTINGS_RELOAD,
  installProcessGuards, installAsyncErrorHandling, errorMiddleware, resolveBindHost,
} from '@coremail/core';
import { connectDatabase, invalidateProtocolAccessCache } from '@coremail/storage';
import { createAutodiscoverApp } from './app.js';
import { invalidateSettingsCache } from './settings.js';
import { invalidateAutoconfigCache } from './autoconfig.js';

const log = createLogger('autodiscover');
installProcessGuards(log);
// v6.1: LDAP accounts can log in on the mail protocols (shared credential check)
registerLdapMailVerifier();
installAsyncErrorHandling(express);
const PORT = parseInt(process.env['AUTODISCOVER_PORT'] ?? '8081', 10);

async function main() {
  await connectDatabase();
  void initRuntimeLogLevel('autodiscover', { aliases: [] }); // BCP per-service log level

  // v3.18.35: on settings changes (e.g. publicHostname update via BCP)
  // invalidate the settings cache — otherwise Autodiscover returns stale URLs
  // for up to 60s. Outlook clients might then fail to connect.
  try {
    const sub = getRedisClient().duplicate();
    void sub.subscribe(CHANNEL_SETTINGS_RELOAD);
    sub.on('message', () => {
      invalidateSettingsCache();
      invalidateAutoconfigCache();
      // 9.4: every protocol switch change publishes this signal as well
      invalidateProtocolAccessCache();
      log.info('Settings cache invalidated (Redis signal)');
    });
  } catch (err) {
    log.warn({ err }, 'Redis subscription failed — cache expires automatically after 60s');
  }

  // Routes: app.ts (v1 POX incl. mobilesync, v2 JSON in both URL forms)
  const app = createAutodiscoverApp();

  // v6: shared error middleware (registered last)
  app.use(errorMiddleware(log));

  // v6: internal service behind the api-gateway — loopback by default
  const host = resolveBindHost();
  app.listen(PORT, host, () => {
    log.info({ port: PORT, host }, 'Autodiscover service started');
  });

  process.on('SIGTERM', () => process.exit(0));
}

main().catch((err) => {
  log.error({ err }, 'Fatal startup error');
  process.exit(1);
});
